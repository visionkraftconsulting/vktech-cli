# vktech

**Multi-provider AI analysis CLI & library** — query OpenAI, Google Gemini, and xAI Grok for
code & architecture analysis, then hand the actual implementation off to
[Claude Code](https://claude.com/claude-code). One tool, three opinions, a clean handoff.

```
────────────────────────────────────────────────────────────────
❯ gpt-5 review this function for race conditions
────────────────────────────────────────────────────────────────
```

- 🎛 **Three providers, one interface** — `gpt-5`, `gemini`, `grok` (or any explicit model id).
- 🧑‍⚖️ **`--all` fan-out** — ask every configured provider in parallel and get one consolidated
  report; agreements are high-confidence, disagreements are flagged for review.
- 📋 **Audit templates** — curated prompt + file bundle for HIPAA/ISO, security, prod-readiness,
  architecture. `audit auto` detects the project's industry and picks the frameworks.
- 💬 **Modern REPL** — violet themed, live framed input box, Braille spinner, elapsed/token
  footer, multi-line bracketed paste, history, Ctrl-C cancel.
- 🤝 **Claude Code handoff** — `vktech code "…"` (or `/code` in the REPL) shells out to the
  `claude` CLI to implement what the analysis surfaced.

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
XAI_API_KEY=…
# optional model overrides
OPENAI_MODEL=gpt-5
GEMINI_MODEL=gemini-2.5-pro
XAI_MODEL=grok-4
CLAUDE_BIN=claude          # path to the Claude Code CLI for `vktech code`
```

Only the providers whose keys are set are used — `vktech providers` shows status.

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

### REPL commands

| Command | Action |
|---|---|
| *(plain text)* | analyze with the active provider |
| `/model <m>` | switch provider (`gpt-5`, `gemini`, `grok`) |
| `/file <path>` | load a file into the next prompt |
| `/code <text>` | hand off to Claude Code |
| `/providers` | list providers |
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
