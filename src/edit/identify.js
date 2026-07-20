// Music identification via Shazam (node-shazam — pure Node, web API).
// Scans an audio/video file in windows and reports recognized tracks + where.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg, run } from "./ffmpeg.js";

// Slice [start, start+dur] to a temp wav (44.1k stereo — what Shazam expects).
async function slice(src, start, dur, dir, idx, signal) {
  const out = join(dir, `s_${idx}.wav`);
  await ffmpeg(["-loglevel", "error", "-y", "-ss", String(start), "-t", String(dur),
    "-i", src, "-ac", "2", "-ar", "44100", out], { signal });
  return out;
}

// Recognize one slice; returns { title, artist, isrc, url } or null.
async function recognizeFile(shazam, file) {
  const r = await shazam.recognise(file, "en-US").catch(() => null);
  const t = r && r.track;
  if (!t) return null;
  let isrc = "";
  for (const s of t.sections || []) {
    if (s.metadata) for (const m of s.metadata) if (/isrc/i.test(m.title || "")) isrc = m.text;
  }
  return { title: t.title, artist: t.subtitle, isrc: isrc || t.isrc || "", url: t.url || "" };
}

// Scan a media file for music. Returns { duration, hits:[{at,end,title,artist,isrc,url}] }.
// opts: { step (sec between samples), win (window len), full (whole-file once) }
export async function identify(src, { step = 40, win = 12, full = false, log, signal } = {}) {
  const { Shazam } = await import("node-shazam");
  const shazam = new Shazam();
  const dir = mkdtempSync(join(tmpdir(), "vktech-id-"));
  const L = log || { info() {}, warn() {} };

  // duration
  const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", src]);
  const duration = Math.floor(Number(probe.stdout.trim()) || 0);

  try {
    if (full || duration <= win) {
      const f = await slice(src, 0, Math.min(win, duration || win), dir, 0, signal);
      const m = await recognizeFile(shazam, f);
      return { duration, hits: m ? [{ at: 0, end: duration, ...m }] : [] };
    }

    // Window scan, then coalesce consecutive same-track hits into ranges.
    const raw = [];
    for (let t = 0; t < duration; t += step) {
      if (signal?.aborted) throw new Error("identify aborted");
      const f = await slice(src, t, win, dir, t, signal);
      const m = await recognizeFile(shazam, f);
      if (m) {
        L.info(`  ♪ ${fmt(t)}  ${m.title} — ${m.artist}`);
        raw.push({ at: t, ...m });
      } else {
        L.info(`  · ${fmt(t)}  (speech / no match)`);
      }
    }
    const hits = [];
    for (const r of raw) {
      const last = hits[hits.length - 1];
      if (last && last.title === r.title && r.at - last.end <= step + win) last.end = r.at + win;
      else hits.push({ ...r, end: r.at + win });
    }
    return { duration, hits };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fmt(s) { return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
export { fmt };
