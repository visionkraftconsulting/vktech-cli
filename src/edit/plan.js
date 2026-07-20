// Stage 2 — build an edit plan from probed clips.
// Each plan entry: { file, in, out, note }. Long clips get windowed to a
// representative highlight segment (middle window) instead of the full length.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Middle-window a long clip: center a `window` segment within [0,duration].
function windowLong(duration, window) {
  const inPt = Math.max(0, Math.round((duration - window) / 2));
  return { in: inPt, out: Math.min(duration, inPt + window) };
}

// Build the plan. clips are already chronologically sorted (probe.js).
export function buildPlan(clips, cfg) {
  const longThresh = cfg.long_clip_threshold_sec;
  const win = cfg.window_sec;

  let plan = clips.map((c) => {
    const dur = Math.floor(c.duration);
    if (dur <= 0) return null; // skip unreadable / zero-length
    if (longThresh > 0 && dur > longThresh) {
      const w = windowLong(dur, win);
      return { file: c.file, in: w.in, out: w.out, note: `windowed ${win}s of ${dur}s` };
    }
    return { file: c.file, in: 0, out: dur, note: "full" };
  }).filter(Boolean);

  // Optional runtime cap: proportionally shrink to fit target_runtime_sec.
  if (cfg.target_runtime_sec > 0) {
    const total = plan.reduce((s, p) => s + (p.out - p.in), 0);
    if (total > cfg.target_runtime_sec) {
      const k = cfg.target_runtime_sec / total;
      plan = plan.map((p) => {
        const len = Math.max(2, Math.round((p.out - p.in) * k)); // keep >=2s
        return { ...p, out: p.in + len, note: p.note + ` (scaled x${k.toFixed(2)})` };
      });
    }
  }
  return plan;
}

export function totalRuntime(plan) {
  return plan.reduce((s, p) => s + (p.out - p.in), 0);
}

export function writePlan(plan, workDir) {
  const p = join(workDir, "plan.json");
  writeFileSync(p, JSON.stringify(plan, null, 2));
  return p;
}
