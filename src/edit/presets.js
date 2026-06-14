// Tone presets -> ffmpeg grade filter strings (eq + colorbalance).
// memorial values are the exact ones proven on the NATTY funeral edit.
export const PRESETS = {
  memorial: "eq=contrast=0.97:brightness=-0.008:saturation=0.84:gamma=1.02,colorbalance=rs=-0.02:bs=0.04:rm=-0.02:bm=0.03:bh=0.04",
  vlog:     "eq=contrast=1.05:saturation=1.12:gamma=0.98,colorbalance=rm=0.03:bm=-0.02:bh=-0.02",
  neutral:  "eq=contrast=1.0:saturation=1.0",
};

export function gradeFilter(preset) {
  const p = PRESETS[preset];
  if (!p) throw new Error(`unknown tone_preset "${preset}" (use: ${Object.keys(PRESETS).join(", ")})`);
  return p;
}
