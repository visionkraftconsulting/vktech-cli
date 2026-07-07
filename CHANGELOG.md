# Changelog

All notable changes to vktech are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0]

### Added
- `vktech transcribe <file|dir>` — offline speech-to-text via whisper.cpp (**paid feature**,
  gated on `VKTECH_LICENSE` / `VKTECH_PRO=1`, like `edit`/`dns`). Extracts 16 kHz mono audio
  with ffmpeg, then whisper-cli writes `.txt` (default) and/or `.srt`. Directory inputs sweep
  every audio/video file; `--combine` writes one `ALL_TRANSCRIPTS_COMBINED.txt`. Flags:
  `--model`, `--srt`, `--srt-only`, `--combine`, `--lang`, `-o`, `--dry-run` (free file-list
  preview). ggml model (default `small.en`) auto-downloads once to `~/.config/vktech/models/`;
  override via `--model` or `VKTECH_WHISPER_MODEL`. Requires `whisper-cpp` on PATH
  (`brew install whisper-cpp`).

## [1.0.0]

Initial public release.

### Added
- Multi-provider analysis CLI: `ask`, `audit`, `code`, `providers`, `run`/`sh`/`remote`.
- `audit --all` fan-out across every configured provider into one consolidated report.
- Industry auto-detection (`audit auto`, `detect`, `industries`) that picks templates +
  compliance frameworks.
- Programmatic library API via `import { ask, askAll, … } from "vktech"` (`main: src/index.js`).
- Portable `.env` discovery: `$VKTECH_ENV`, `./.env`, `~/.config/vktech/.env`, `~/.vktech.env`.
- Modern REPL: violet/coral themes, live framed input box, Braille spinner, elapsed/token
  footer, multi-line bracketed paste with large-paste collapse, command history, Ctrl-C
  cancel (clears line / aborts in-flight request / exits on empty).
