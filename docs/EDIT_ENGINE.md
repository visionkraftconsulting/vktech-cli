# vktech edit — Automated Video-Editing Engine

> **Premium feature.** `vktech edit` turns a folder of raw clips into one finished,
> captioned, color-graded, integrity-verified video — fully automated, zero prompts.

It runs the same pipeline a human editor would: probe → plan → remove dark/blocked
shots → AI-generated captions → grade + loudness-normalize → assemble → verify.

---

## Quick start

```bash
# 1. Point it at a folder of clips with flags:
vktech edit -d ./clips -o ./out/final.mp4 --preset memorial --captions vision

# 2. Or drive everything from a config file (recommended for repeatable jobs):
vktech edit --config job.json

# 3. Plan only, no render (fast preview of what it will cut):
vktech edit -d ./clips -o ./out/final.mp4 --dry-run
```

## Prerequisites

- **ffmpeg + ffprobe** on PATH (8.x recommended). The engine auto-detects encoders.
- **Node ≥ 18** (already required by vktech).
- `@napi-rs/canvas` (installed automatically with vktech) — renders caption cards.
  A serif font is bundled; no system fonts required.

## What it does (pipeline)

| Stage | What happens |
|-------|--------------|
| **Probe** | ffprobe every clip; sort chronologically by capture time (filename fallback). |
| **Plan** | Build an edit plan. Clips longer than `long_clip_threshold_sec` are windowed to a highlight segment. Optional `target_runtime_sec` cap. |
| **Dark scan** | Measure brightness (signalstats YAVG); cut spans below threshold — lens-down, covered, black frames. |
| **Captions** | AI vision (grok → claude → openai) analyzes sampled frames and writes tasteful cards. `safe_mode` never asserts unverified facts; `overrides` (verified text) always win. Rendered as PNGs and composited (works even without ffmpeg `drawtext`). |
| **Segments** | Per-clip trim + grade + loudness-normalize, re-encoded to a uniform format. Parallelized. |
| **Concat** | Stream-copy all segments into one master (no quality loss). |
| **Grade/captions** | Final graded pass with caption overlays + fades. |
| **Verify** | Full-decode integrity check; reports 0 errors. |

## Config schema

`vktech edit --config job.json`. All paths resolve relative to the config file.

```jsonc
{
  "input": "./clips",                 // required: folder of source clips
  "output": "./out/final.mp4",        // required
  "work_dir": "./out/_vkedit_work",   // optional (default: <output dir>/_vkedit_work)

  "aspect": "16:9",                   // screen size — see "Aspects" below
  "fit": "pad",                       // pad (letterbox) | crop (fill + center-crop)
  "fps": 30,
  "resolution": null,                 // null => derived from aspect; or { "w":1920,"h":1080,"fps":30 }

  "tone_preset": "memorial",          // see "Tone presets" below
  "encoder": "auto",                  // auto | hevc_videotoolbox | libx265 | libx264 | h264_videotoolbox
  "concurrency": 0,                   // 0 = auto; N = parallel segment encodes

  "target_runtime_sec": 0,            // 0 = no cap; else proportionally trim to fit
  "long_clip_threshold_sec": 600,     // clips longer than this get windowed
  "window_sec": 240,                  // highlight-window length for long clips

  "audio": { "loudnorm": "I=-16:TP=-1.5:LRA=11", "bitrate": "192k", "rate": 48000, "channels": 2 },

  "dark": { "mode": "cut", "threshold": 24, "min_span_sec": 1.5 },  // mode: cut | flag | off

  "captions": {
    "mode": "vision",                 // vision | metadata | off
    "vision_model": null,             // null => provider cascade (grok first)
    "font": null,                     // null => bundled serif
    "safe_mode": true,                // never assert unverified facts
    "facts_file": null,               // optional verified-facts text given to the vision model
    "overrides": [                    // verified cards (win over vision); see schema.example.json
      { "id": "open", "at_sec": 0.5, "dur_sec": 8, "band": [0.30, 0.60, 110],
        "lines": [ { "text": "In Loving Memory", "size": 70, "weight": "400", "y": 0.40 } ] }
    ]
  },

  "dry_run": false
}
```

A full sample lives at `src/edit/schema.example.json`.

## Aspects (screen sizes)

`aspect` sets the output resolution; `fit` controls how source is fitted.

| aspect   | resolution | for |
|----------|------------|-----|
| `16:9`   | 3840×2160  | TV / YouTube (4K) |
| `16:9hd` | 1920×1080  | TV / YouTube (1080p) |
| `9:16`   | 1080×1920  | phone — Reels / Shorts / Stories |
| `1:1`    | 1080×1080  | square feed |
| `4:5`    | 1080×1350  | portrait feed |
| `21:9`   | 3840×1646  | cinematic ultrawide |

Use `fit: "crop"` to fill the frame (best when reformatting landscape footage to
vertical/square); `fit: "pad"` letterboxes without cropping. Caption positions are
fractional, so they adapt to any aspect automatically.

## Tone presets

| preset | look |
|--------|------|
| `memorial`  | cool, gently desaturated, soft contrast — funerals / memorials |
| `vlog`      | warm, vibrant — events / lifestyle |
| `neutral`   | minimal grade |
| `cinematic` | teal-shadow / warm-highlight, medium contrast |
| `bw`        | tasteful monochrome |
| `wedding`   | soft, bright, lightly warm |

## CLI flags

```
vktech edit --config <file>        Drive everything from JSON
            -d, --input <dir>      Clips directory
            -o, --output <file>    Output path
            --preset <name>        Tone preset
            --encoder <name>       Encoder (auto by default)
            --captions <mode>      vision | metadata | off
            --dark <mode>          cut | flag | off
            --runtime <seconds>    Target total runtime
            --dry-run              Plan only, no render
```

CLI flags override the config file.

## Encoder selection

`auto` picks the best available encoder for the host:
`hevc_videotoolbox` (macOS, hardware) → `libx265` → `libx264`. videotoolbox is
macOS-only; Linux hosts fall back to libx265/libx264 automatically.

## Notes for operators

- **Disk**: the engine writes per-clip segments to `work_dir` before concat. Budget
  ~1–1.5× the final size in scratch space.
- **Captions & facts**: in `safe_mode` the AI describes mood/scene only. To put names,
  dates, or other facts on screen, supply them via `captions.overrides` (or
  `facts_file` as context) — the engine will not invent them.
- **Determinism**: same config + same input → same plan. Vision caption *text* varies
  per run; use `captions.mode: "off"` or override-only for byte-stable output.
