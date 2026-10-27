# vktech

**Multi-provider AI analysis CLI & library** — query OpenAI, Google Gemini, xAI Grok, or the
RTX 5090's Ollama for code and architecture analysis. Implementation defaults to that
same Ollama agent (`qwen3.8:27b`). `--claude` still hands a prompt to
[Claude Code](https://claude.com/claude-code).

```
────────────────────────────────────────────────────────────────
❯ gpt-5 review this function for race conditions
────────────────────────────────────────────────────────────────
```

- 🎛 **Multiple providers, one interface** — `gpt-5`, `gemini`, `grok` (via the `grok` CLI),
  `claude`, `local` (or any explicit model id).
- 🧑‍⚖️ **`--all` fan-out** — ask every configured provider in parallel and get one consolidated
  report; agreements are high-confidence, disagreements are flagged for review.
- 📋 **Audit templates** — curated prompt + file bundle for HIPAA/ISO, security, prod-readiness,
  architecture. `audit auto` detects the project's industry and picks the frameworks.
- 💬 **Modern REPL** — the default `vktech` chat is the RTX agent: it edits the
  working directory, runs commands, searches the web, and checks the GPU.
  Every session loads memories from Claude, Grok, Codex, Cursor, and Gemini,
  and each prompt searches those notes for the words you used.
  The input window stays pinned to the bottom and redraws to the terminal width.
  Conversations are saved per folder as the turn runs, so quitting mid-command
  resumes on the next launch. `/history` lists them, `/history <n>`
  continues one, `/new` starts fresh. Up/Down recalls what you typed.
- 🤝 **RTX coding agent** — `vktech code "…"` (or `/code` in the REPL) is the same
  agent as a one-shot. `vktech code --claude "…"` uses Claude Code instead.

---

## Install

```bash
npm install -g vktech       # global CLI
# or, from source:
npm install github:visionkraftconsulting/vktech-cli -g
```

Requires **Node ≥ 18**.

## Configure keys

vktech reads API keys from the environment. Set them however you like, or drop a `.env` file
in one of these locations (first match wins; real `process.env` always overrides):

1. `$VKTECH_ENV` — explicit path, if set
2. `./.env` — project-local (run from your project dir)
3. `~/.config/vktech/.env`
4. `~/.vktech.env`

```bash
# ~/.config/vktech/.env
OPENAI_API_KEY=sk-…
GEMINI_API_KEY=…
# XAI_API_KEY is only needed with XAI_BACKEND=api (see below) — the default
# `grok` CLI path uses the CLI's own login instead.
# optional model overrides
OPENAI_MODEL=gpt-5
GEMINI_MODEL=gemini-2.5-pro
# XAI_MODEL=grok-4.6       # unset => let the grok CLI pick its default
LOCAL_MODEL=qwen3.8:27b    # RTX Ollama model for analysis and `vktech code`
# LOCAL_NUM_CTX=32768      # unset = join the loaded runner; set only to force one
CLAUDE_BIN=claude          # only used by `vktech code --claude`
```

Only the providers whose keys are set are used — `vktech providers` shows status.

### xAI via the `grok` CLI (default)

`grok` requests shell out to the installed **`grok` CLI** rather than `api.x.ai`, so they
spend your Grok **subscription** instead of API credits. Run `grok login` once; no
`XAI_API_KEY` is needed. `vktech providers` shows `✓ grok CLI` for xAI in this mode.

| Env | Effect |
| --- | --- |
| *(unset)* | CLI path (default) |
| `XAI_BACKEND=api` | use `api.x.ai` with `XAI_API_KEY` instead |
| `GROK_BIN` | path to the `grok` binary (default: `grok`) |
| `XAI_MODEL` | pin a model id (see `grok models`); unset = the CLI's default |

Note the CLI's model ids differ from the old API ones — `grok-4.6` / `grok-4.5`, not
`grok-4`. Image input (`ask -i`) has no CLI path, so xAI **vision** still uses
`api.x.ai` and needs `XAI_API_KEY` (vision is local-only by default regardless).

## Usage

```bash
vktech                              # interactive REPL
vktech ask -m gpt-5 "<prompt>"      # one-shot analysis
vktech ask -m gemini "Suggest an architecture for a job queue"

vktech audit --list                 # list audit templates
vktech audit security-review -d ./my-app -o report.md
vktech audit auto -d ./my-app       # detect industry, pick template + frameworks
vktech audit hipaa-iso --all -d ./my-app   # all providers -> one report

vktech code "Implement the fixes Grok suggested in src/order.js"
vktech providers                    # key/model status
vktech --help

# Offline speech-to-text (whisper.cpp) — audio/video -> .txt / .srt  (paid)
vktech transcribe ./videos --dry-run           # free: preview the file list
vktech transcribe talk.mp4                     # one file -> talk.txt
vktech transcribe ./videos --srt --combine     # whole folder -> .txt + .srt + combined doc
vktech transcribe podcast.m4a -m medium.en     # higher-accuracy model

# Automated video-editing engine (premium) — folder of clips -> finished video
vktech edit -d ./clips -o ./out/final.mp4 --preset memorial --captions vision
vktech edit --config job.json       # full control via JSON
vktech edit -d ./clips -o ./out/x.mp4 --dry-run   # plan only
```

### Transcription

`vktech transcribe <file|dir>` runs fully offline speech-to-text via
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) — no API key, no upload.
Per file it extracts 16 kHz mono audio with `ffmpeg`, then whisper-cli writes a
`.txt` (default) and/or `.srt` beside it. A directory input transcribes every
audio/video file inside; `--combine` also concatenates all `.txt` into one
`ALL_TRANSCRIPTS_COMBINED.txt` master document.

Requires `ffmpeg` and `whisper-cpp` on PATH (`brew install ffmpeg whisper-cpp`).
The ggml model (default `small.en`) is auto-downloaded once to
`~/.config/vktech/models/`. Override with `--model <name|path.bin>` or
`VKTECH_WHISPER_MODEL`. Flags: `--srt`, `--srt-only`, `--combine`, `--lang <code>`,
`-o <out_dir>`, `--dry-run`.

**Paid feature** — set `VKTECH_LICENSE` (or `VKTECH_PRO=1`) in your vktech env to run
transcription. `--dry-run` previews the file list for free without a license.

### Video editing engine

`vktech edit` is an automated, config-driven video editor: probe → plan → remove
dark/blocked shots → AI-generated captions → grade + loudness-normalize → assemble →
verify. Supports multiple screen sizes (16:9, 9:16 vertical, 1:1, 4:5, 21:9) and tone
presets (memorial, vlog, cinematic, bw, wedding, neutral). Requires `ffmpeg` on PATH.
See **[docs/EDIT_ENGINE.md](docs/EDIT_ENGINE.md)** for the full config schema and options.

### Repo awareness: "status" in any repo

In the REPL, or with `vktech code`, ask `status`, `progress`, `catch me up`, `what did claude work on last` or
`check on <topic>`. vktech first gathers, read-only and in about a second:
- git: branch, uncommitted files, recent commits and branches;
- GitHub: open and merged PRs, and issues;
- prod: an HTTPS check of the repo's site;
- the Claude memory for this repo;
- the last Claude Code sessions run in this folder: what was asked, the files edited, the commits, PRs and deploys,
  and how the final message ended.

The local model then writes a short report: **Last worked on / Current state / Open & next**. Follow-up questions
are answered from that report. Replies are rendered Markdown, colour-coded by status (red = blocked or failed,
yellow = open or waiting, green = done or healthy).

- Prod URL for a repo vktech doesn't know: add `.vktech/status.json` with `{"urls": ["https://…"]}`.
- AWS boxes for the `aws_ssm` tool: `~/.config/vktech/ssm-hosts.json` with `{"name": "i-…"}`.
- Private, site-specific checks (internal hosts or case details that must not be in this repo): drop a module in
  `~/.config/vktech/checks/*.mjs`. The contract is in `src/checks.js`.

### REPL commands

| Command | Action |
|---|---|
| *(plain text)* | analyze with the active provider |
| `/model <m>` | switch provider (`local`, `ollama`, `grok`, `claude`, `gpt-5`, `gemini`) |
| `/file <path>` | load a file into the next prompt |
| `/code <text>` | implement with the RTX Ollama agent (`/code --claude` for Claude Code) |
| `/providers` | list providers and mark the active one |
| `/providers <name>` | switch provider (`local`, `ollama`, `grok`, `claude`, `gpt-5`, `gemini`). Tools run on `local`. |
| `/history` | list saved conversations for this folder |
| `/history <n>` | print that conversation and continue it |
| `/new` | start a fresh conversation |
| `/help` · `/exit` | help · quit |

**Editing** (in the input box): `←`/`→`/`Home`/`End` move · `Alt`+`←`/`→` move by word ·
`Backspace`/`Del` delete char · `Ctrl`+`W` / `Alt`+`⌫` delete word back · `Alt`+`D` delete
word forward · `Ctrl`+`U` delete to line start · `Ctrl`+`K` to line end · `↑`/`↓` history ·
`Ctrl`+`C` clear line / exit when empty / cancel a running query. Multi-line paste is
supported (bracketed paste); large pastes collapse to a compact `[pasted N chars …]` chip —
`←`/`→` snap the caret to its start/end, and any delete key (`Backspace`/`Del`/`Ctrl`+`W`/
`Ctrl`+`U`/`Ctrl`+`K`) removes the whole chip in one stroke. The full text is still sent.

**Theme:** `VKTECH_THEME=violet` (default) or `coral`. `NO_COLOR=1` disables color.

## Use as a library

```js
import { ask, askAll, availableProviders, loadEnv } from "vktech";

loadEnv(); // optional: read the same .env files the CLI uses

const { provider, model, text } = await ask({
  modelArg: "gpt-5",
  prompt: "Review this for bugs:\n" + code,
});
console.log(`[${provider}:${model}]`, text);

// Fan out to every configured provider:
const results = await askAll({ prompt: "…" }); // [{provider, model, ok, text|error}]
```

Exports: `ask`, `askAll`, `availableProviders`, `resolveProvider`, `PROVIDERS`, `DEFAULTS`,
`listTemplates`, `loadTemplate`, `buildPrompt`, `detectIndustry`, `INDUSTRIES`, `runClaude`,
`loadEnv`.

## License

[MIT](./LICENSE) © Kwasi Kabiro · [vktech.ai](https://vktech.ai)
