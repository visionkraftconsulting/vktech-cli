// Stages 5-6 — encode each plan entry to a uniform-format segment, then
// stream-copy concat into one file. All segments share identical params so
// the concat demuxer can copy without re-encoding (proven on the NATTY edit).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { ffmpeg } from "./ffmpeg.js";
import { gradeFilter } from "./presets.js";

// The video filter applied per segment: grade -> fit to target -> sar/fps/pixfmt.
// fit=pad letterboxes (non-destructive); fit=crop scales-to-fill + center-crops
// (best for reformatting landscape source to vertical/square screens).
export function fitFilters(w, h, fit) {
  if (fit === "crop") {
    return [
      `scale=${w}:${h}:force_original_aspect_ratio=increase`,
      `crop=${w}:${h}`,
    ];
  }
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
  ];
}

function videoFilter(cfg) {
  const { w, h, fps } = cfg.resolution;
  const grade = gradeFilter(cfg.tone_preset);
  return [
    grade,
    ...fitFilters(w, h, cfg.fit),
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

// Encode all segments with a bounded concurrency pool. Output paths stay in
// plan order (seg_NN) so the concat list is deterministic regardless of which
// encode finishes first. concurrency defaults to ~half the cores (hardware
// encoders contend; software encoders are already multi-threaded), min 1.
export async function buildSegments(plan, cfg, enc, { log, signal } = {}) {
  cfg._planLen = plan.length;
  const cap = Math.max(1, cfg.concurrency || defaultConcurrency(enc.name));
  const segs = new Array(plan.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= plan.length) return;
      if (signal?.aborted) throw new Error("render aborted");
      segs[i] = await encodeSegment(plan[i], i, cfg, enc, log, signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, plan.length) }, worker));

  const listPath = join(cfg.work_dir, "concat.txt");
  writeFileSync(listPath, segs.map((s) => `file '${s}'`).join("\n") + "\n");
  return { listPath, segments: segs };
}

// Hardware encoders (videotoolbox) serialize on a single ASIC — modest pool.
// Software encoders (libx264/5) already use all cores per job — keep pool small
// to avoid oversubscription, but >1 still helps hide I/O/seek latency.
function defaultConcurrency(encName) {
  const cores = (cpus() || []).length || 4;
  if (encName.includes("videotoolbox")) return Math.min(4, Math.max(2, Math.floor(cores / 2)));
  return Math.min(3, Math.max(1, Math.floor(cores / 4)));
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
