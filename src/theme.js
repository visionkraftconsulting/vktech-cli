// Shared terminal theme: cli.js chrome and src/render.js replies use one palette.
// ── Theme ────────────────────────────────────────────────────────────────
// "Full look & feel" palette modeled on the Claude Code TUI: one signature
// accent carries headings/prompt/borders, with muted secondary chrome, dim
// grey metadata, and the usual success/warn/error states. Two named themes —
// `violet` (default) and `coral` (Claude-orange) — selectable via
// VKTECH_THEME=violet|coral. Truecolor escapes by default; 256-color fallback
// when the terminal can't do 24-bit (NO_COLOR disables color entirely).
export const TRUECOLOR = !process.env.NO_COLOR &&
  /truecolor|24bit/i.test(process.env.COLORTERM || "");
export const NO_COLOR = !!process.env.NO_COLOR;

// Each entry: [truecolor RGB, 256-color index].
export const THEMES = {
  violet: {
    accent:  ["\x1b[38;2;150;110;230m", "\x1b[38;5;141m"], // violet — prompt, accents, borders
    heading: ["\x1b[38;2;180;150;245m", "\x1b[38;5;147m"], // brighter lilac — section headings
    chrome:  ["\x1b[38;2;190;170;235m", "\x1b[38;5;183m"], // muted lilac — secondary labels
    grey:    ["\x1b[38;2;120;120;135m", "\x1b[38;5;243m"], // dim metadata
    green:   ["\x1b[38;2;120;200;130m", "\x1b[38;5;114m"], // success
    yellow:  ["\x1b[38;2;230;190;100m", "\x1b[38;5;179m"], // warning
    red:     ["\x1b[38;2;225;110;110m", "\x1b[38;5;167m"], // error
  },
  coral: {
    accent:  ["\x1b[38;2;217;119;87m",  "\x1b[38;5;173m"], // Claude coral — prompt, accents, borders
    heading: ["\x1b[38;2;227;139;108m", "\x1b[38;5;209m"], // brighter coral-rose — section headings
    chrome:  ["\x1b[38;2;215;175;135m", "\x1b[38;5;180m"], // muted tan/sand — secondary labels
    grey:    ["\x1b[38;2;120;120;135m", "\x1b[38;5;243m"], // dim metadata
    green:   ["\x1b[38;2;120;200;130m", "\x1b[38;5;114m"], // success
    yellow:  ["\x1b[38;2;230;190;100m", "\x1b[38;5;179m"], // warning
    red:     ["\x1b[38;2;225;110;110m", "\x1b[38;5;167m"], // error
  },
};
export const THEME_NAME = (process.env.VKTECH_THEME || "violet").toLowerCase() in THEMES
  ? (process.env.VKTECH_THEME || "violet").toLowerCase()
  : "violet";
export const PALETTE = THEMES[THEME_NAME];

export const C = {
  reset: NO_COLOR ? "" : "\x1b[0m",
  bold: NO_COLOR ? "" : "\x1b[1m",
  dim: NO_COLOR ? "" : "\x1b[2m",
};
for (const [name, [tc, fb]] of Object.entries(PALETTE)) {
  C[name] = NO_COLOR ? "" : (TRUECOLOR ? tc : fb);
}
// Back-compat aliases for the old color names used throughout the file.
C.lilac = C.chrome;    // legacy name kept for any external refs
C.cyan = C.accent;     // old "cyan" headers/model tags -> theme accent
C.magenta = C.chrome;  // old "magenta" Claude-handoff lines -> chrome

export const color = (c, s) => NO_COLOR ? `${s}` : `${C[c]}${s}${C.reset}`;
