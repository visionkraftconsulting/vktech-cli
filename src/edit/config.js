// Config loading, validation, defaults. Zero interactive prompts — the config
// (file + CLI overrides) is the single source of truth for a job.
import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { PRESETS, ASPECTS, aspectResolution } from "./presets.js";

const DEFAULTS = {
  target_runtime_sec: 0,            // 0 = no cap
  resolution: null,                 // null => derived from `aspect`; or { w, h, fps }
  fps: 30,
  aspect: "16:9",
  fit: "pad",            // pad (letterbox, non-destructive) | crop (fill, center-crop)
  concurrency: 0,        // 0 = auto (per-encoder default); N = parallel segment encodes
  tone_preset: "neutral",
  encoder: "auto",
  // Per-segment loudness/encode + optional user music track (the "audio
  // questionnaire"): track + mode (off|replace_all|bed|opening) + how to fit it.
  audio: {
    loudnorm: "I=-16:TP=-1.5:LRA=11", bitrate: "192k", rate: 48000, channels: 2,
    track: null,               // path to user-uploaded music (mp3/wav)
    speech_track: null,        // opening mode: source the kept speech from this
                               //   file (e.g. an enhanced-speech render, same
                               //   timeline as the video) instead of the original
    mode: "off",               // off | replace_all | bed | opening
    loop: true,                // replace_all/bed: loop to cover runtime
    bed_gain_db: -16,          // bed: how far under the voices
    opening_sec: 120,          // opening: seconds the track covers
    sync: "none",              // none | auto (best-effort cross-correlate to in-room music)
    sync_offset_sec: null,     // explicit, reliable: where in the track to start (overrides sync)
    crossfade_sec: 2, fade_in_sec: 1.5, fade_out_sec: 2,
  },
  long_clip_threshold_sec: 600,
  window_sec: 240,
  dark: { mode: "cut", threshold: 24, min_span_sec: 1.5 },
  captions: { mode: "off", vision_model: null, font: null, overrides: [], facts_file: null, safe_mode: true },
  dry_run: false,
  log_level: "info",
};

// Deep-merge plain objects (arrays/scalars replace).
function merge(base, over) {
  if (over == null) return base;
  if (Array.isArray(base) || typeof base !== "object") return over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = (typeof base[k] === "object" && base[k] && !Array.isArray(base[k]))
      ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

// Resolve a possibly-relative path against the config file's directory.
function abs(p, baseDir) {
  if (!p) return p;
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

// Load + validate a job config. `overrides` are CLI flags merged on top.
// `baseDir` anchors relative paths (defaults to the config file's dir).
export function loadConfig(configPath, overrides = {}) {
  let raw = {};
  let baseDir = process.cwd();
  if (configPath) {
    if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
    baseDir = dirname(resolve(configPath));
    try { raw = JSON.parse(readFileSync(configPath, "utf8")); }
    catch (e) { throw new Error(`config is not valid JSON: ${e.message}`); }
  }

  const cfg = merge(merge(DEFAULTS, raw), overrides);

  // Resolve paths.
  cfg.input = abs(cfg.input, baseDir);
  cfg.output = abs(cfg.output, baseDir);
  cfg.work_dir = abs(cfg.work_dir || (cfg.output ? join(dirname(cfg.output), "_vkedit_work") : null), baseDir);
  if (cfg.captions) cfg.captions.facts_file = abs(cfg.captions.facts_file, baseDir);
  if (cfg.audio) { cfg.audio.track = abs(cfg.audio.track, baseDir); cfg.audio.speech_track = abs(cfg.audio.speech_track, baseDir); }

  // Derive resolution from aspect unless explicitly provided. fps from cfg.fps.
  if (!cfg.resolution) {
    if (!ASPECTS[cfg.aspect]) {
      // leave null; validation below reports the bad aspect
    } else {
      const a = aspectResolution(cfg.aspect);
      cfg.resolution = { w: a.w, h: a.h, fps: cfg.fps };
    }
  } else if (cfg.resolution.fps == null) {
    cfg.resolution.fps = cfg.fps;
  }

  // Validate — aggregate all errors into one message.
  const errs = [];
  if (!cfg.input) errs.push("input (clips dir) is required");
  else if (!existsSync(cfg.input)) errs.push(`input dir does not exist: ${cfg.input}`);
  if (!cfg.output) errs.push("output path is required");
  if (!PRESETS[cfg.tone_preset]) errs.push(`tone_preset must be one of: ${Object.keys(PRESETS).join(", ")}`);
  if (!ASPECTS[cfg.aspect]) errs.push(`aspect must be one of: ${Object.keys(ASPECTS).join(", ")}`);
  if (!["pad", "crop"].includes(cfg.fit)) errs.push('fit must be pad|crop');
  if (!["cut", "flag", "off"].includes(cfg.dark.mode)) errs.push('dark.mode must be cut|flag|off');
  if (!["vision", "metadata", "off"].includes(cfg.captions.mode)) errs.push('captions.mode must be vision|metadata|off');
  if (!["off", "replace_all", "bed", "opening"].includes(cfg.audio.mode)) errs.push('audio.mode must be off|replace_all|bed|opening');
  if (cfg.audio.mode !== "off") {
    if (!cfg.audio.track) errs.push(`audio.mode="${cfg.audio.mode}" requires audio.track (path to a music file)`);
    else if (!existsSync(cfg.audio.track)) errs.push(`audio.track not found: ${cfg.audio.track}`);
    if (!["none", "auto"].includes(cfg.audio.sync)) errs.push('audio.sync must be none|auto');
    if (cfg.audio.speech_track && !existsSync(cfg.audio.speech_track)) errs.push(`audio.speech_track not found: ${cfg.audio.speech_track}`);
  }
  if (!cfg.resolution || !(cfg.resolution.w > 0 && cfg.resolution.h > 0 && cfg.resolution.fps > 0)) errs.push("resolution w/h/fps must be positive");
  if (cfg.captions.mode === "metadata" && !(cfg.captions.overrides || []).length)
    errs.push("captions.mode=metadata requires captions.overrides");

  if (errs.length) throw new Error("invalid config:\n  - " + errs.join("\n  - "));
  return cfg;
}

export { DEFAULTS };
