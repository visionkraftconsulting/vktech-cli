# Changelog

All notable changes to vktech are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.3.1] - 2026-11-15

### Fixed
- The agent loads the global `~/.claude/CLAUDE.md` in full, budgeted before repo files. It was
  being truncated. It also reads other CLIs' instruction files: `AGENTS.md`, `GEMINI.md`,
  `GROK.md`, `.cursorrules` and `.github/copilot-instructions.md` per folder, plus
  `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` and `~/.grok` globals.

## [1.3.0] - 2026-11-15

### Added
- Claude on Amazon Bedrock is the default provider and coding agent (REPL, `vktech code`,
  `ask`, vision). Default model Claude Fable 5.2, falling back to Opus 5.5 and then Opus 4.6 when
  the AWS account lacks access. `-m local` keeps the Ollama agent.
- `vktech login` / `logout` / `whoami`: sign in to vkPilot so Claude and web search run on your
  subscription through the vkPilot relay, with no AWS account needed.
- Ops from the agent: `aws`, `doctl`, `ssh host 'cmd'`, `aws_ssm`. A y/N prompt runs before any
  command that changes infrastructure. `run` takes `timeout_seconds` (up to 3600).
- Web search on AWS through the relay (Bedrock Nova grounding). SearXNG is opt-in with
  `VKTECH_SEARCH=searxng`.

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
