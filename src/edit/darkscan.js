// Stage 3 — detect dark/blocked spans (lens-down, covered, black) via
// signalstats YAVG and adjust the plan to cut them.
//
// Three gotchas proven during the manual NATTY edit are handled explicitly:
//   (a) ffmpeg consumes the parent stdin -> we already pass -nostdin (ffmpeg.js).
//   (b) `metadata=print:file=-` collides with `-f null -` (both stdout) ->
//       write metadata to a REAL temp file, and mux null to the null device.
//   (c) parse that file in JS — never via an inline-quoted shell heredoc.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, NULL_DEVICE } from "./ffmpeg.js";

// Scan one window of a clip; return [{ t, yavg }] sampled at `fps` per second.
async function scanWindow(file, inPt, dur, workDir, idx, fps, signal) {
  const meta = join(workDir, `_luma_${idx}.txt`);
  await ffmpeg([
    "-loglevel", "error",
    "-ss", String(inPt), "-t", String(dur), "-i", file,
    "-vf", `fps=${fps},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${meta}`,
    "-f", "null", NULL_DEVICE,
  ], { signal });

  const txt = readFileSync(meta, "utf8");
  rmSync(meta, { force: true });
  const samples = [];
  let t = null;
  for (const line of txt.split("\n")) {
    const mt = line.match(/pts_time:([0-9.]+)/);
    if (mt) { t = Number(mt[1]); continue; }
    const my = line.match(/YAVG=([0-9.]+)/);
    if (my && t != null) samples.push({ t: t + inPt, yavg: Number(my[1]) });
  }
  return samples;
}

// Coalesce consecutive below-threshold samples into spans >= minSpan seconds.
function darkSpans(samples, threshold, minSpan, step) {
  const spans = [];
  let start = null, last = null;
  for (const s of samples) {
    if (s.yavg < threshold) {
      if (start == null) start = s.t;
      last = s.t;
    } else if (start != null) {
      if (last - start + step >= minSpan) spans.push([start, last + step]);
      start = last = null;
    }
  }
  if (start != null && last - start + step >= minSpan) spans.push([start, last + step]);
  return spans;
}

// Subtract dark spans from a plan entry's [in,out], yielding 0+ kept sub-entries.
function subtractSpans(entry, spans) {
  let kept = [[entry.in, entry.out]];
  for (const [ds, de] of spans) {
    const next = [];
    for (const [ks, ke] of kept) {
      if (de <= ks || ds >= ke) { next.push([ks, ke]); continue; } // no overlap
      if (ds > ks) next.push([ks, Math.min(ds, ke)]);              // keep left
      if (de < ke) next.push([Math.max(de, ks), ke]);              // keep right
    }
    kept = next;
  }
  return kept
    .filter(([s, e]) => e - s >= 1)   // drop sub-1s slivers
    .map(([s, e]) => ({ file: entry.file, in: Math.round(s), out: Math.round(e), note: "dark-trimmed" }));
}

// Run the dark scan over the whole plan. mode: cut | flag | off.
// Returns { plan: adjustedPlan, report: [{file,spans}] }.
export async function darkScan(plan, cfg, { log, signal } = {}) {
  const { mode, threshold, min_span_sec } = cfg.dark;
  if (mode === "off") return { plan, report: [] };

  const fps = 2, step = 1 / fps;
  const report = [];
  const outPlan = [];

  for (let i = 0; i < plan.length; i++) {
    if (signal?.aborted) throw new Error("darkscan aborted");
    const e = plan[i];
    const samples = await scanWindow(e.file, e.in, e.out - e.in, cfg.work_dir, i, fps, signal);
    const spans = darkSpans(samples, threshold, min_span_sec, step);
    if (spans.length) {
      report.push({ file: e.file, spans });
      log.info(`  dark in ${e.file.split("/").pop()}: ${spans.map(s => `${s[0].toFixed(1)}-${s[1].toFixed(1)}s`).join(", ")}`);
    }
    if (mode === "cut" && spans.length) outPlan.push(...subtractSpans(e, spans));
    else outPlan.push(e); // flag mode keeps entry as-is
  }
  if (mode === "cut") {
    const removed = plan.length - outPlan.length;
    log.info(`  dark scan: ${report.length} clip(s) had dark spans` + (removed > 0 ? `, ${removed} segment(s) net change` : ""));
  }
  return { plan: outPlan, report };
}
