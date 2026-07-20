// Tone presets -> ffmpeg grade filter strings (eq + colorbalance + optional fx).
// `memorial` values are the exact ones proven on the NATTY funeral edit.
export const PRESETS = {
  memorial:  "eq=contrast=0.97:brightness=-0.008:saturation=0.84:gamma=1.02,colorbalance=rs=-0.02:bs=0.04:rm=-0.02:bm=0.03:bh=0.04",
  vlog:      "eq=contrast=1.05:saturation=1.12:gamma=0.98,colorbalance=rm=0.03:bm=-0.02:bh=-0.02",
  neutral:   "eq=contrast=1.0:saturation=1.0",
  cinematic: "eq=contrast=1.08:saturation=0.92:gamma=0.96,colorbalance=rs=-0.03:bs=0.05:rm=0.02:bm=0.04:rh=0.04:bh=-0.03,curves=preset=medium_contrast",
  bw:        "format=gray,eq=contrast=1.06:brightness=0.01,format=yuv420p",
  wedding:   "eq=contrast=0.98:saturation=1.04:brightness=0.012:gamma=1.03,colorbalance=rh=0.03:bh=-0.02",
};

export function gradeFilter(preset) {
  const p = PRESETS[preset];
  if (!p) throw new Error(`unknown tone_preset "${preset}" (use: ${Object.keys(PRESETS).join(", ")})`);
  return p;
}

// Aspect presets -> target resolution + a label. Drive output for different
// screen sizes: landscape TV/YouTube, vertical phone (reels/shorts/stories),
// square (feed). Resolution can still be overridden explicitly in config.
export const ASPECTS = {
  "16:9":  { w: 3840, h: 2160, label: "landscape 4K" },
  "16:9hd":{ w: 1920, h: 1080, label: "landscape 1080p" },
  "9:16":  { w: 1080, h: 1920, label: "vertical phone (reels/shorts)" },
  "1:1":   { w: 1080, h: 1080, label: "square (feed)" },
  "4:5":   { w: 1080, h: 1350, label: "portrait feed" },
  "21:9":  { w: 3840, h: 1646, label: "cinematic ultrawide" },
};

export function aspectResolution(aspect) {
  const a = ASPECTS[aspect];
  if (!a) throw new Error(`unknown aspect "${aspect}" (use: ${Object.keys(ASPECTS).join(", ")})`);
  return a;
}
