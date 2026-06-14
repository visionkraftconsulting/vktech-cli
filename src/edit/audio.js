// Audio track handling for the edit engine — applies a user-supplied music
// track to the rendered video per a questionnaire-style config (config.audio).
//
// config.audio:
//   track:        path to the user's audio file (mp3/wav). Required for these modes.
//   mode:         "off" | "replace_all" | "bed" | "opening"
//                   off         — keep original audio (default)
//                   replace_all — track becomes the whole soundtrack (loops to fill)
//                   bed         — track plays quietly UNDER original audio (ducked)
//                   opening     — track replaces only the opening section, then
//                                 crossfades into the original audio
//   loop:         true|false  (replace_all/bed) — loop the track to cover runtime
//   bed_gain_db:  e.g. -16    (bed) — how far under the original audio the music sits
//   opening_sec:  seconds the opening track covers (opening mode)
//   sync:         "auto" | "none" — auto cross-correlates the track against the
//                 existing in-room audio to find where it should start (great for
//                 swapping a phone-recorded song for its studio master)
//   crossfade_sec: boundary crossfade length (opening mode), default 2
//   fade_in_sec / fade_out_sec: track fades
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg, run } from "./ffmpeg.js";

const RATE = 48000;

async function durationOf(file) {
  const r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return Number(r.stdout.trim()) || 0;
}

// Decode a slice to mono 8k float32 samples for fast correlation.
async function monoSamples(file, start, dur, dir, tag, signal) {
  const out = join(dir, `c_${tag}.raw`);
  await ffmpeg(["-loglevel", "error", "-y", "-ss", String(start), "-t", String(dur),
    "-i", file, "-ac", "1", "-ar", "8000", "-f", "f32le", out], { signal });
  const buf = readFileSync(out);
  rmSync(out, { force: true });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

function normalize(a) {
  let mean = 0; for (const x of a) mean += x; mean /= a.length || 1;
  let sd = 0; for (const x of a) sd += (x - mean) ** 2; sd = Math.sqrt(sd / (a.length || 1)) + 1e-9;
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = (a[i] - mean) / sd;
  return o;
}

// Cross-correlate a short probe against a longer signal -> best lag in seconds.
// Naive O(n*m) but bounded (probe ~20s@8k=160k, track ~5min@8k=2.4M) — runs in ~1-2s.
// Normalized cross-correlation: for each lag, score = dot(probe, track[lag..]) /
// ||track window||. The energy normalization is what disambiguates repetitive
// music (choruses) — a plain dot-product locks onto the loudest repeat, not the
// true alignment. Probe is already zero-mean/unit-std.
function bestLagSeconds(track, probe, fps = 8000, maxSlideSec = 600) {
  const T = track.length, P = probe.length;
  const maxLag = Math.min(T - 1, maxSlideSec * fps);

  // Prefix sum of track^2 for O(1) window-energy lookups.
  const e = new Float64Array(T + 1);
  for (let i = 0; i < T; i++) e[i + 1] = e[i] + track[i] * track[i];
  const winEnergy = (lag, n) => Math.sqrt(e[lag + n] - e[lag]) + 1e-9;

  const score = (lag, stride) => {
    const n = Math.min(P, T - lag);
    let s = 0;
    for (let i = 0; i < n; i += stride) s += probe[i] * track[lag + i];
    return s / winEnergy(lag, n);
  };

  const stepCoarse = Math.round(0.1 * fps);
  let best = -Infinity, bestLag = 0;
  for (let lag = 0; lag < maxLag; lag += stepCoarse) {
    const v = score(lag, 4);
    if (v > best) { best = v; bestLag = lag; }
  }
  let fbest = -Infinity, fineLag = bestLag;
  const lo = Math.max(0, bestLag - stepCoarse), hi = Math.min(maxLag, bestLag + stepCoarse);
  for (let lag = lo; lag < hi; lag++) {
    const v = score(lag, 1);
    if (v > fbest) { fbest = v; fineLag = lag; }
  }
  return fineLag / fps;
}

// Convert samples to a loudness ENVELOPE at `hz` frames/sec (RMS per frame).
// The envelope (rhythm/dynamics) survives the acoustic gap between a phone
// room-recording and a studio master far better than raw waveform — so
// correlating envelopes aligns them reliably where sample correlation fails.
function envelope(samples, fps, hz) {
  const hop = Math.max(1, Math.round(fps / hz));
  const out = new Float32Array(Math.floor(samples.length / hop));
  for (let f = 0; f < out.length; f++) {
    let s = 0; const b = f * hop;
    for (let i = 0; i < hop; i++) { const v = samples[b + i]; s += v * v; }
    out[f] = Math.sqrt(s / hop);
  }
  return normalize(out);
}

// Find where the user's track aligns to the existing in-room music in the video.
// Returns the offset (seconds into the track) that lines up with video t=0.
// Uses loudness-envelope correlation at 50 Hz (robust to recording quality).
export async function syncOffset(videoFile, trackFile, { dir, probeSec = 30, signal } = {}) {
  const fps = 8000, hz = 50;
  const trackEnv = envelope(await monoSamples(trackFile, 0, await durationOf(trackFile), dir, "trk", signal), fps, hz);
  const probeEnv = envelope(await monoSamples(videoFile, 0, probeSec, dir, "vid", signal), fps, hz);
  // bestLagSeconds expects fps == frame rate of the series being correlated.
  return bestLagSeconds(trackEnv, probeEnv, hz);
}

// Build the final audio and mux it into `videoIn` -> `videoOut` (video stream copied).
export async function applyAudio(videoIn, videoOut, cfg, { log, signal } = {}) {
  const a = cfg.audio || {};
  if (!a.track || a.mode === "off" || !a.mode) return null; // nothing to do
  const L = log || { info() {}, warn() {} };
  const dir = mkdtempSync(join(tmpdir(), "vktech-aud-"));
  try {
    const vidDur = await durationOf(videoIn);
    const trkDur = await durationOf(a.track);
    const xf = a.crossfade_sec ?? 2;
    const fin = a.fade_in_sec ?? 1.5;
    const fout = a.fade_out_sec ?? 2;
    const newAudio = join(dir, "new.wav");

    if (a.mode === "opening") {
      const openLen = a.opening_sec || Math.min(trkDur, 120);
      // Where in the track to start. Priority: explicit sync_offset_sec (reliable)
      // > auto cross-correlation (best-effort) > 0 (track from its beginning).
      let ss = 0;
      if (typeof a.sync_offset_sec === "number") {
        ss = a.sync_offset_sec;
        L.info(`  audio: track starts at ${ss.toFixed(1)}s (explicit offset)`);
      } else if (a.sync === "auto") {
        ss = await syncOffset(videoIn, a.track, { dir, signal });
        L.warn(`  audio: auto-sync estimated ${ss.toFixed(1)}s — VERIFY this; pass audio.sync_offset_sec for exact alignment`);
      }
      // HQ opening bed (openLen + xf for crossfade tail), faded + loudnorm
      const open = join(dir, "open.wav");
      await ffmpeg(["-loglevel", "error", "-y", "-ss", String(ss), "-t", String(openLen + xf), "-i", a.track,
        "-af", `afade=t=in:st=0:d=${fin},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${RATE}`,
        "-ac", "2", "-ar", String(RATE), open], { signal });
      // Tail (the kept speech) from openLen onward. Source it from a separate
      // enhanced-speech file when given (same timeline as the video), else from
      // the video's own audio. Lets you combine HQ music + HQ enhanced speech.
      const speechSrc = a.speech_track || videoIn;
      const tail = join(dir, "tail.wav");
      await ffmpeg(["-loglevel", "error", "-y", "-ss", String(openLen), "-i", speechSrc,
        "-vn", "-c:a", "pcm_s16le", "-ar", String(RATE), "-ac", "2", tail], { signal });
      // crossfade open -> tail
      await ffmpeg(["-loglevel", "error", "-y", "-i", open, "-i", tail,
        "-filter_complex", `[0][1]acrossfade=d=${xf}:c1=tri:c2=tri[o]`, "-map", "[o]",
        "-c:a", "pcm_s16le", newAudio], { signal });
      L.info(`  opening ${openLen.toFixed(0)}s = track; rest = ${a.speech_track ? "enhanced speech" : "original"} (crossfaded)`);

    } else if (a.mode === "replace_all") {
      const loop = a.loop !== false ? ["-stream_loop", "-1"] : [];
      await ffmpeg(["-loglevel", "error", "-y", ...loop, "-i", a.track,
        "-t", String(vidDur),
        "-af", `afade=t=in:st=0:d=${fin},afade=t=out:st=${Math.max(0, vidDur - fout)}:d=${fout},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${RATE}`,
        "-ac", "2", "-ar", String(RATE), newAudio], { signal });
      L.info(`  full soundtrack from track${a.loop !== false ? " (looped)" : ""}`);

    } else if (a.mode === "bed") {
      const gain = a.bed_gain_db ?? -16;
      const loop = a.loop !== false ? ["-stream_loop", "-1"] : [];
      // music bed (looped, gained down) + original audio, mixed
      await ffmpeg(["-loglevel", "error", "-y",
        ...loop, "-i", a.track, "-i", videoIn,
        "-filter_complex",
        `[0:a]volume=${gain}dB,afade=t=in:st=0:d=${fin},aresample=${RATE}[bed];` +
        `[1:a]aresample=${RATE}[voc];` +
        `[bed][voc]amix=inputs=2:duration=shortest:dropout_transition=0:normalize=0[o]`,
        "-map", "[o]", "-t", String(vidDur), "-c:a", "pcm_s16le", newAudio], { signal });
      L.info(`  music bed under original audio at ${gain}dB`);

    } else {
      throw new Error(`unknown audio.mode "${a.mode}" (off|replace_all|bed|opening)`);
    }

    // mux: copy video, new audio -> AAC
    await ffmpeg(["-loglevel", "error", "-y", "-i", videoIn, "-i", newAudio,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-ar", String(RATE), "-movflags", "+faststart", "-shortest", videoOut], { signal });
    return videoOut;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
