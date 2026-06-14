// Stages 5-6 — encode each plan entry to a uniform-format segment, then
// stream-copy concat into one file. All segments share identical params so
// the concat demuxer can copy without re-encoding (proven on the NATTY edit).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg } from "./ffmpeg.js";
import { gradeFilter } from "./presets.js";

// The video filter applied per segment: grade -> scale/pad to target -> sar/fps/pixfmt.
function videoFilter(cfg) {
  const { w, h, fps } = cfg.resolution;
  const grade = gradeFilter(cfg.tone_preset);
  return [
    grade,
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
    `fps=${fps}`,
    "format=yuv420p",
  ].join(",");
}

// Encode one trimmed, graded, loudness-normalized segment.
async function encodeSegment(entry, idx, cfg, enc, log, signal) {
  const n = String(idx + 1).padStart(2, "0");
  const out = join(cfg.work_dir, `seg_${n}.mov`);
  const dur = entry.out - entry.in;
  const a = cfg.audio;
  const args = [
    "-loglevel", "error", "-y",
    "-ss", String(entry.in), "-i", entry.file, "-t", String(dur),
    "-vf", videoFilter(cfg),
    "-af", `loudnorm=${a.loudnorm}`,
    ...enc.vargs,
    "-c:a", "aac", "-b:a", a.bitrate, "-ar", String(a.rate), "-ac", String(a.channels),
    out,
  ];
  log.info(`  [${n}/${"" + cfg._planLen}] ${entry.file.split("/").pop()} ${entry.in}..${entry.out}s`);
  await ffmpeg(args, { signal });
  return out;
}

// Encode all segments sequentially (ffmpeg already saturates the box; parallel
// encodes contend for the encoder). Returns the concat list path.
export async function buildSegments(plan, cfg, enc, { log, signal } = {}) {
  cfg._planLen = plan.length;
  const segs = [];
  for (let i = 0; i < plan.length; i++) {
    if (signal?.aborted) throw new Error("render aborted");
    segs.push(await encodeSegment(plan[i], i, cfg, enc, log, signal));
  }
  const listPath = join(cfg.work_dir, "concat.txt");
  writeFileSync(listPath, segs.map((s) => `file '${s}'`).join("\n") + "\n");
  return { listPath, segments: segs };
}

// Concat segments via the demuxer with stream copy -> single file.
// If a caption overlay filtergraph is supplied, we cannot stream-copy; the
// caller routes to renderWithCaptions instead.
export async function concat(listPath, outPath, { log, signal } = {}) {
  log.info("  concatenating segments (stream copy)…");
  await ffmpeg([
    "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart",
    outPath,
  ], { signal });
  return outPath;
}
