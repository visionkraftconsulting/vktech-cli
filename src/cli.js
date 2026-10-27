#!/usr/bin/env node
// vktech — multi-provider AI analysis CLI. Code work defaults to the RTX Ollama agent.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute, basename } from "node:path";
// dirname is already imported above for __dirname; reused for output paths.
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { createInterface, cursorTo, clearLine, emitKeypressEvents } from "node:readline";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Load env keys/config. Order = priority (dotenv won't override an already-set
// var, so the first file to define a var wins). Real process env beats them all.
//   1. $VKTECH_ENV            — explicit override path, if set
//   2. ./.env                 — project-local, run from the user's CWD
//   3. ~/.config/vktech/.env  — XDG user config
//   4. ~/.vktech.env          — simple home-dir fallback
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const ENV_SOURCES = [
  process.env.VKTECH_ENV,
  join(process.cwd(), ".env"),
  HOME && join(HOME, ".config", "vktech", ".env"),
  HOME && join(HOME, ".vktech.env"),
].filter(Boolean);
for (const path of ENV_SOURCES) {
  if (existsSync(path)) dotenv.config({ path });
}

const { ask, askVision, askAll, availableProviders, PROVIDERS, DEFAULTS, resolveProvider,
  PRIORITY, VISION_PRIORITY, VISION_LOCAL_ONLY, displayModel,
  providerConfigured, LOCAL_URL } = await import("./providers.js");
const { useGrokCli } = await import("./grok.js");
const { runClaude } = await import("./claude.js");
const { runLocalAgent, toolResultPreview } = await import("./agent.js");
const { listTemplates, loadTemplate, buildPrompt } = await import("./templates.js");
const { detectIndustry, INDUSTRIES } = await import("./industry.js");
const { readSnippet, runLocalJs, runLocalShell, runRemote } = await import("./run.js");
const { runEdit } = await import("./edit/index.js");
const { loadConfig } = await import("./edit/config.js");
const { upsertA, removeA, isLicensed } = await import("./edit/cloudflare.js");
const { identify, fmt } = await import("./edit/identify.js");
const { transcribe, collectInputs: listTranscribable } = await import("./transcribe.js");
const { runSecrets } = await import("./secrets.js");
const { webSearch } = await import("./search.js");
const { memoryBrief, memoriesForPrompt } = await import("./memories.js");
const { checkReplies, isReplyCheck, replyFocus } = await import("./replies.js");
const {
  createSession, saveSession, latestSession, listSessions, loadSession,
  loadLineHistory, saveLineHistory, appendTranscript, upsertLiveTranscript,
} = await import("./sessions.js");

// ── Theme ─ (palette lives in src/theme.js, shared with the reply renderer)
const { TRUECOLOR, NO_COLOR, THEMES, THEME_NAME, PALETTE, C, color } = await import("./theme.js");
const { renderMarkdown } = await import("./render.js");

// Visible length of a string, ignoring ANSI escape sequences.
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

// Live terminal width. A cap here left the rules short of a wide window.
function termWidth() {
  return Math.max(20, process.stdout.columns || 80);
}

// Rounded box-drawn welcome banner, sized to the terminal (ASCII fallback
// under NO_COLOR). Rounded corners ╭╮╰╯ per the modernization pass.
function banner(lines) {
  if (NO_COLOR) return lines.join("\n");
  const a = (s) => `${C.accent}${s}${C.reset}`;
  const inner = Math.min(termWidth() - 4, 64);
  const dash = "─".repeat(inner + 2);
  const bar = a("│");
  const pad = (s) => s + " ".repeat(Math.max(0, inner - visLen(s)));
  const body = lines.map((l) => `${bar} ${pad(l)} ${bar}`).join("\n");
  return `${a("╭" + dash + "╮")}\n${body}\n${a("╰" + dash + "╯")}`;
}

// Claude-Code-style framed input box: a full-width rule, the "❯" prompt line
// (set as the readline prompt by the caller), and a closing rule printed once
// the line is submitted. `rule()` draws one horizontal divider in the accent.
function rule() {
  // Leave the last column empty. A rule of exactly `columns` chars wraps,
  // and the following newline then paints a second blank row.
  return color("accent", "─".repeat(Math.max(1, termWidth() - 1)));
}

// ── Async spinner ──────────────────────────────────────────────────────────
// Braille spinner shown on stderr during API calls so the REPL never looks
// frozen. Hides the cursor while spinning; clears its line on stop. Falls back
// to a static "…" under NO_COLOR / non-TTY (e.g. piped) so logs stay clean.
const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");
function startSpinner(label) {
  const tty = process.stderr.isTTY && !NO_COLOR;
  if (!tty) {
    process.stderr.write(color("dim", `… ${label}\n`));
    return { stop() {} };
  }
  process.stderr.write("\x1b[?25l"); // hide cursor
  let i = 0;
  const tick = () => {
    const frame = SPINNER_FRAMES[i++ % SPINNER_FRAMES.length];
    process.stderr.write(`\r${color("accent", frame)} ${color("dim", label)}\x1b[K`);
  };
  tick();
  const timer = setInterval(tick, 90);
  // interval shouldn't keep the event loop alive on its own
  if (timer.unref) timer.unref();
  return {
    stop() {
      clearInterval(timer);
      process.stderr.write("\r\x1b[K\x1b[?25h"); // clear line + show cursor
    },
  };
}

// Dim, right-aligned status footer printed after a response: elapsed time and
// an approximate token count (chars/4 — providers here don't return usage).
function statusFooter({ provider, model, ms, chars }) {
  const approxTokens = Math.max(1, Math.round(chars / 4));
  const text = `△ ${ms}ms · ~${approxTokens} tok · ${provider}:${model}`;
  if (NO_COLOR) return console.log(text);
  const pad = Math.max(0, termWidth() - 1 - visLen(text));
  console.log(" ".repeat(pad) + color("grey", text));
}

// ── Pinned composer ─────────────────────────────────────────────────────────
// A permanent input window on the bottom rows, like the Grok composer. The
// conversation scrolls in the region above it. The box is drawn with absolute
// cursor addresses, never cursor-up, so a repaint cannot erase scrollback.
// Rules are redrawn from the live width on every keystroke and on resize.
// Supports: printable input, Backspace, Left/Right/Home/End, Up/Down history,
// Enter (submit), Ctrl-C (abort line), Ctrl-D (EOF on empty line). Falls back to
// plain readline when stdin isn't an interactive TTY (pipes, NO_COLOR scripts).
function openComposer({ historyRef, promptLabel }) {
  const stdin = process.stdin;
  const out = process.stdout;
  const interactive = stdin.isTTY && out.isTTY && !NO_COLOR;

  // Plain (non-TTY) fallback: one readline question with a leading rule.
  if (!interactive) {
    return {
      read() {
        return new Promise((resolve) => {
          const rl = createInterface({ input: stdin, output: out });
          console.log(rule());
          rl.question(`${promptLabel()} `, (answer) => {
            rl.close();
            resolve({ line: answer, eof: false });
          });
        });
      },
      close() {},
    };
  }

  const history = historyRef;
  const state = {
    buf: "",
    pos: 0,
    hist: -1,
    stash: "",
    pasting: false,
    listening: false,
    closed: false,
    scrollBottom: 0,
    boxTop: 0,
    resizeTimer: null,
    paintedLens: [],
    onKey: null,
  };
  // Pastes above this size collapse to a one-line chip. The full text stays
  // in `buf` and is what gets submitted.
  const COLLAPSE_CHARS = 1800;

  const screenRows = () => Math.max(8, out.rows || 24);
  const isCollapsed = () => state.buf.length > COLLAPSE_CHARS;
  const summaryText = () => {
    const nl = (state.buf.match(/\n/g) || []).length + 1;
    return `[pasted ${state.buf.length.toLocaleString()} chars · ${nl} lines · Enter to send]`;
  };
  // Usable width stops one column early so a full rule cannot wrap.
  const metrics = () => {
    const labelLen = visLen(promptLabel()) + 1;
    const width = Math.max(8, termWidth() - 1);
    const inner = Math.max(1, width - labelLen);
    return { labelLen, width, inner };
  };
  const collapsedCol = () => {
    const { labelLen } = metrics();
    const s = summaryText();
    const pos = state.pos;
    const buf = state.buf;
    return labelLen + (pos <= 0 ? 0 : pos >= buf.length ? s.length : Math.round((pos / buf.length) * s.length));
  };

  // Wrap the buffer into display rows. The first row is indented past the
  // label. Returns { rows, curRow, curCol }.
  const layout = () => {
    const { labelLen, width, inner } = metrics();
    const buf = state.buf;
    const pos = state.pos;
    if (isCollapsed()) {
      return { rows: [color("chrome", summaryText())], curRow: 0, curCol: collapsedCol() };
    }
    const rows = [];
    let cur = "";
    let curRow = 0;
    let curCol = labelLen;
    const pushCol = (i) => {
      if (i === pos) {
        curRow = rows.length;
        curCol = (rows.length === 0 ? labelLen : 0) + cur.length;
      }
    };
    for (let i = 0; i < buf.length; i++) {
      pushCol(i);
      const ch = buf[i];
      const rowCap = rows.length === 0 ? inner : width;
      if (ch === "\n") { rows.push(cur); cur = ""; continue; }
      cur += ch;
      if (cur.length >= rowCap) { rows.push(cur); cur = ""; }
    }
    pushCol(buf.length);
    rows.push(cur);
    if (rows.length === 0) rows.push("");
    return { rows, curRow, curCol };
  };

  // Map a visual (row, column) back to a buffer index for Up/Down.
  const posAtRow = (targetRow, desiredCol) => {
    const { labelLen, width, inner } = metrics();
    const buf = state.buf;
    const spans = [];
    let start = 0;
    let len = 0;
    let rowIdx = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      const rowCap = rowIdx === 0 ? inner : width;
      if (ch === "\n") { spans.push({ start, len }); rowIdx++; start = i + 1; len = 0; continue; }
      len++;
      if (len >= rowCap) { spans.push({ start, len }); rowIdx++; start = i + 1; len = 0; }
    }
    spans.push({ start, len });
    if (targetRow < 0) targetRow = 0;
    if (targetRow >= spans.length) targetRow = spans.length - 1;
    const span = spans[targetRow];
    const colInRow = Math.max(0, desiredCol - (targetRow === 0 ? labelLen : 0));
    return span.start + Math.min(colInRow, span.len);
  };

  // Show at most a few rows so a long draft cannot cover the conversation.
  // The window follows the caret.
  const windowOf = (laid) => {
    const max = Math.max(1, Math.min(8, screenRows() - 4));
    const all = laid.rows;
    if (all.length <= max) {
      return { rows: all, start: 0, curRow: laid.curRow, curCol: laid.curCol };
    }
    let start = laid.curRow - max + 1;
    if (start < 0) start = 0;
    if (start > all.length - max) start = all.length - max;
    return {
      rows: all.slice(start, start + max),
      start,
      curRow: laid.curRow - start,
      curCol: laid.curCol,
    };
  };

  // Reserve `box` rows at the bottom. Growth scrolls the transcript up so the
  // new row does not cover it. Shrink only clears rows the box itself occupied.
  const applyRegion = (box, { fromResize = false } = {}) => {
    const r = screenRows();
    const bottom = Math.max(1, r - box);
    const prevBottom = state.scrollBottom;
    const prevTop = state.boxTop;
    if (!fromResize && prevBottom && bottom < prevBottom) {
      out.write(`\x1b[${prevBottom};1H` + "\r\n".repeat(prevBottom - bottom));
    }
    if (prevBottom !== bottom) out.write(`\x1b[1;${bottom}r`);
    const top = r - box + 1;
    if (!fromResize && prevTop && top > prevTop) {
      const last = Math.min(top - 1, bottom);
      for (let row = prevTop; row <= last; row++) out.write(`\x1b[${row};1H\x1b[2K`);
    }
    state.scrollBottom = bottom;
    state.boxTop = top;
    return { bottom, top };
  };

  // mode: "input" puts the caret in the box, "park" leaves it in the
  // transcript region, "keep" restores whatever the terminal had (resize
  // while a reply is streaming).
  const paint = (mode, opts = {}) => {
    if (state.closed) return;
    const laid = layout();
    const view = windowOf(laid);
    const box = view.rows.length + 2;
    if (mode === "keep") out.write("\x1b7");
    // A narrower window reflows the box we painted last: each old rule wraps
    // into a full row plus a remainder and pushes up into the conversation
    // (the "staircase" of rules after a drag-resize). Those fragments are the
    // bottom rows of the screen, so clear exactly as many as they now take.
    if (opts.fromResize && state.paintedLens.length) {
      const cols = Math.max(1, out.columns || 80);
      const frag = state.paintedLens.reduce((n, len) => n + Math.max(1, Math.ceil(len / cols)), 0);
      if (frag > state.paintedLens.length) {
        const r = screenRows();
        out.write("\x1b[r");
        for (let row = Math.max(1, r - frag + 1); row <= r; row++) out.write(`\x1b[${row};1H\x1b[2K`);
        state.scrollBottom = 0;
        state.boxTop = 0;
      }
    }
    const { top } = applyRegion(box, opts);
    out.write("\x1b[?25l\x1b[?7l");
    const put = (row, text) => {
      if (row >= 1) out.write(`\x1b[${row};1H\x1b[2K${text}`);
    };
    put(top, rule());
    const label = promptLabel();
    view.rows.forEach((segment, i) => {
      const prefix = view.start + i === 0 ? `${label} ` : "";
      put(top + 1 + i, prefix + segment);
    });
    put(top + box - 1, rule());
    out.write("\x1b[?7h");
    // Visible width of every box row, for the resize cleanup above.
    const ruleLen = Math.max(1, termWidth() - 1);
    state.paintedLens = [ruleLen, ...view.rows.map((seg, i) => visLen((view.start + i === 0 ? `${visLen(label) ? label : ""} ` : "") + seg)), ruleLen];
    if (mode === "input") {
      const caretRow = top + 1 + view.curRow;
      out.write(`\x1b[${Math.max(1, caretRow)};1H`);
      const col = Math.max(0, Math.min(view.curCol, termWidth() - 2));
      if (col > 0) out.write(`\x1b[${col}C`);
      out.write("\x1b[?25h");
    } else if (mode === "park") {
      out.write(`\x1b[${Math.max(1, screenRows() - box)};1H\x1b[?25h`);
    } else {
      out.write("\x1b8\x1b[?25h");
    }
  };

  const render = () => paint("input");

  const onResize = () => {
    if (state.resizeTimer) clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      state.resizeTimer = null;
      if (!state.closed) paint(state.listening ? "input" : "keep", { fromResize: true });
    }, 30);
    if (state.resizeTimer.unref) state.resizeTimer.unref();
  };
  out.on("resize", onResize);

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    state.listening = false;
    if (state.resizeTimer) clearTimeout(state.resizeTimer);
    out.removeListener("resize", onResize);
    if (state.onKey) stdin.removeListener("keypress", state.onKey);
    if (stdin.isRaw) stdin.setRawMode(false);
    out.write("\x1b[0m\x1b[r\x1b[?7h\x1b[?25h\x1b[?2004l");
    try { out.write(`\x1b[${screenRows()};1H\r\n`); } catch { /* process is exiting */ }
  };
  process.once("exit", close);

  // Push the banner up, then cover the bottom rows with the window.
  out.write("\r\n".repeat(3));
  paint("park");

  const read = () => new Promise((resolve) => {
    state.buf = "";
    state.pos = 0;
    state.hist = -1;
    state.stash = "";
    state.pasting = false;
    state.listening = true;

    const finish = (result) => {
      stdin.removeListener("keypress", onKey);
      state.listening = false;
      if (stdin.isRaw) stdin.setRawMode(false);
      out.write("\x1b[?2004l");
      stdin.pause();
      const submitted = String(result.line || "");
      state.buf = "";
      state.pos = 0;
      state.hist = -1;
      paint("park");
      if (!result.eof && submitted.trim()) {
        const body = submitted.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n/g, "\r\n");
        out.write(`${color("accent", "❯")} ${body}\r\n`);
      }
      resolve(result);
    };

    const insert = (s) => {
      state.buf = state.buf.slice(0, state.pos) + s + state.buf.slice(state.pos);
      state.pos += s.length;
    };
    const prevWord = (i) => {
      let j = i;
      while (j > 0 && /\s/.test(state.buf[j - 1])) j--;
      while (j > 0 && !/\s/.test(state.buf[j - 1])) j--;
      return j;
    };
    const nextWord = (i) => {
      let j = i;
      while (j < state.buf.length && /\s/.test(state.buf[j])) j++;
      while (j < state.buf.length && !/\s/.test(state.buf[j])) j++;
      return j;
    };
    const deleteRange = (a, b) => {
      state.buf = state.buf.slice(0, a) + state.buf.slice(b);
      state.pos = a;
    };

    function onKey(str, key) {
      if (!key || state.closed) return;
      const k = key.name;
      if (key.code === "[200~" || str === "\x1b[200~") { state.pasting = true; return; }
      if (key.code === "[201~" || str === "\x1b[201~") { state.pasting = false; return render(); }
      if (state.pasting) {
        if (k === "return" || k === "enter") { insert("\n"); return; }
        if (str) insert(str);
        return;
      }

      if (key.ctrl && k === "c") {
        if (state.buf === "") return finish({ line: "", eof: true, sigint: true });
        state.buf = ""; state.pos = 0; state.hist = -1; return render();
      }
      if (key.ctrl && k === "d") {
        if (state.buf === "") return finish({ line: "", eof: true });
        if (state.pos < state.buf.length) deleteRange(state.pos, state.pos + 1);
        return render();
      }
      if (k === "return" || k === "enter") return finish({ line: state.buf, eof: false });

      const DELETE_KEYS = ["backspace", "delete"];
      const isDeleteCombo = DELETE_KEYS.includes(k) ||
        (key.ctrl && (k === "w" || k === "u" || k === "k")) || (key.meta && k === "d");
      if (isCollapsed() && isDeleteCombo) {
        state.buf = ""; state.pos = 0; state.hist = -1; return render();
      }

      if (k === "backspace") {
        if (key.meta) { if (state.pos > 0) deleteRange(prevWord(state.pos), state.pos); return render(); }
        if (state.pos > 0) deleteRange(state.pos - 1, state.pos);
        return render();
      }
      if (k === "delete") { if (state.pos < state.buf.length) deleteRange(state.pos, state.pos + 1); return render(); }
      if (key.ctrl && k === "w") { if (state.pos > 0) deleteRange(prevWord(state.pos), state.pos); return render(); }
      if (key.meta && k === "d") { if (state.pos < state.buf.length) deleteRange(state.pos, nextWord(state.pos)); return render(); }
      if (key.ctrl && k === "u") { if (state.pos > 0) deleteRange(0, state.pos); return render(); }
      if (key.ctrl && k === "k") { if (state.pos < state.buf.length) deleteRange(state.pos, state.buf.length); return render(); }

      if (isCollapsed() && (k === "left" || k === "right")) {
        state.pos = k === "left" ? 0 : state.buf.length;
        return render();
      }
      if (k === "left") { state.pos = key.meta ? prevWord(state.pos) : Math.max(0, state.pos - 1); return render(); }
      if (k === "right") { state.pos = key.meta ? nextWord(state.pos) : Math.min(state.buf.length, state.pos + 1); return render(); }
      if (k === "home" || (key.ctrl && k === "a")) { state.pos = 0; return render(); }
      if (k === "end" || (key.ctrl && k === "e")) { state.pos = state.buf.length; return render(); }
      if (k === "up") {
        const { rows, curRow, curCol } = layout();
        if (rows.length > 1 && curRow > 0) { state.pos = posAtRow(curRow - 1, curCol); return render(); }
        if (history.length === 0) return;
        if (state.hist === -1) { state.stash = state.buf; state.hist = history.length; }
        if (state.hist > 0) state.hist--;
        state.buf = history[state.hist]; state.pos = state.buf.length; return render();
      }
      if (k === "down") {
        const { rows, curRow, curCol } = layout();
        if (rows.length > 1 && curRow < rows.length - 1) { state.pos = posAtRow(curRow + 1, curCol); return render(); }
        if (state.hist === -1) return;
        if (state.hist < history.length - 1) { state.hist++; state.buf = history[state.hist]; }
        else { state.hist = -1; state.buf = state.stash; }
        state.pos = state.buf.length; return render();
      }
      if (str && !key.ctrl && !key.meta && str >= " ") { insert(str); return render(); }
    }

    state.onKey = onKey;
    emitKeypressEvents(stdin);
    if (stdin.isRaw !== true) stdin.setRawMode(true);
    stdin.resume();
    out.write("\x1b[?2004h");
    stdin.on("keypress", onKey);
    render();
  });

  return { read, close };
}

function resolvePath(p) {
  if (!p) return process.cwd();
  if (p.startsWith("~")) p = join(process.env.HOME || "", p.slice(1));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function version() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

const ANALYSIS_SYSTEM =
  "You are a senior software engineer doing code and architecture ANALYSIS. " +
  "Be precise and actionable. You are NOT editing files — `vktech code` (the RTX Ollama agent) " +
  "will implement changes. Point out bugs, risks, and concrete recommendations.";

// Cloud providers in the REPL have no tool loop. The local provider does.
const REPL_CLOUD_SYSTEM =
  "You are vktech's assistant, continuing an existing conversation. " +
  "Be precise. This turn has no tools: you cannot edit files, browse, or inspect the RTX from here. " +
  "If the user needs that, tell them to run /providers local.";

function help() {
  console.log(`
${color("bold", "vktech")} v${version()} — analyze with several models, implement with the RTX Ollama agent

${color("bold", "USAGE")}
  vktech                              Start the RTX agent REPL (edits, browses, remembers)
  vktech ask --model <m> "<prompt>"  One-shot analysis with a provider
  vktech ask -i <img> "<prompt>"     Vision analysis (self-hosted by default; $0 API)
  vktech audit [template] [-d dir]   Run a saved audit template over a project
  vktech audit auto -d <dir>         Auto-detect industry, pick template+frameworks
  vktech audit <t> --all -d <dir>    Run ALL providers, consolidate for Claude
  vktech audit --list                List available audit templates
  vktech edit --config job.json      Automated video edit (probe→plan→dark-scan→caption→render)
  vktech edit -d <dir> -o <out.mp4>  Edit clips (--preset, --captions, --audio, --premiere, --dry-run)
  vktech identify <file>             Recognize music in an audio/video file (Shazam)
  vktech transcribe <file|dir>       Offline speech-to-text (whisper.cpp): .txt/.srt (paid; --dry-run free)
  vktech dns publish <sub> --ip <a>  Provision a Cloudflare subdomain (paid; VKTECH_LICENSE)
  vktech secrets [-d dir] [--history] Scan working tree (+git history) for leaked secrets
  vktech search "<query>"            Web search (self-hosted SearXNG) answered by local Ollama; --raw, --native
  vktech replies                     Mail status for this repo's tracked threads (same as "check replies")
  vktech industries                  Show detectable industries + frameworks
  vktech code "<prompt>"             Implement with the RTX Ollama agent (default ${displayModel("local")})
  vktech code --claude "<prompt>"    Hand the same prompt to Claude Code instead
  vktech run                         Paste a JS snippet (Ctrl-D) → run with Node
  vktech sh                          Paste a shell snippet → run with bash
  vktech remote --host <h>           Paste a snippet → run on a host over SSH
  vktech providers                   Show configured providers / keys
  vktech --help                      This help
  vktech --version

${color("bold", "MODELS")} (for --model / -m — default priority: ${PRIORITY.join(" › ")})
  ${color("cyan", "local, ollama")}   -> RTX Ollama  (${displayModel("local")})  ${color("dim", "default")}
  ${color("cyan", "grok, xai")}       -> xAI         (${displayModel("xai")})
  ${color("cyan", "claude")}          -> Anthropic   (${displayModel("anthropic")})
  ${color("cyan", "gpt-5, openai")}   -> OpenAI      (${displayModel("openai")})
  ${color("cyan", "gemini, google")}  -> Gemini      (${displayModel("gemini")})
  You may also pass an explicit id, e.g. --model gpt-4o or --model qwen3.8:27b

${color("bold", "AUDIT TEMPLATES")} (vktech audit --list for the full set)
  Preselect a saved prompt + curated file bundle, run it over a project dir.
  ${color("cyan", "vktech audit hipaa-iso -d ./my-app")}
  ${color("cyan", "vktech audit")}  (no name -> default template in current dir)

${color("bold", "EXAMPLES")}
  vktech ask -m gpt-5 "Review this function for race conditions: $(cat foo.js)"
  vktech ask -m gemini "Suggest an architecture for a job queue"
  vktech ask -i screenshot.png "Analyze this page's theme and color palette"
  vktech ask -i a.png -i b.png "Compare these two layouts"
  vktech audit hipaa-iso -d ./my-app -o report.md
  vktech transcribe ./videos --srt --combine       # whole folder → .txt + .srt + combined
  vktech transcribe talk.mp4 -m medium.en          # single file, higher-accuracy model
  vktech code "Implement the fixes in src/order.js"
  vktech code --claude "Implement the fixes in src/order.js"

${color("bold", "PASTE & RUN")} (no shell-quoting; snippet read from stdin/heredoc/-f file)
  ${color("cyan", "vktech run")}                          # paste JS, Ctrl-D to execute
  ${color("cyan", "VK_ENGINE_TOKEN=… vktech run <<'EOF'")}
    const base='http://localhost:4000';
    const r = await fetch(base+'/v1/social/accounts',{headers:{Authorization:'Bearer '+process.env.VK_ENGINE_TOKEN}});
    console.log(await r.json());
  EOF
  ${color("cyan", "vktech remote --host root@1.2.3.4 -f post.js")}   # run a JS file on prod over ssh
  ${color("cyan", "vktech remote --host root@1.2.3.4 --lang shell <<'EOF' …")}

${color("bold", "REPL COMMANDS")}
  /model <m>     switch active analysis provider (local, ollama, grok, claude, gpt-5, gemini)
  /code <text>   implement with the RTX Ollama agent (/code --claude … for Claude Code)
  /file <path>   load a file's contents into the next prompt
  /providers     list providers and mark the active one
  /providers <p> switch provider (local, ollama, grok, claude, gpt-5, gemini)
  /history       list saved conversations for this folder
  /history <n>   print that conversation and continue it
  /new           start a fresh conversation
  /help          help        /exit  quit

${color("bold", "EDITING")} (in the input box)
  ${color("accent", "← → / Home / End")}   move          ${color("accent", "Alt+← →")}  move by word
  ${color("accent", "Backspace / Del")}    delete char   ${color("accent", "Ctrl+W / Alt+⌫")}  delete word back
  ${color("accent", "Ctrl+U")}             delete to line start   ${color("accent", "Ctrl+K")}  to line end
  ${color("accent", "Alt+D")}              delete word forward    ${color("accent", "↑ ↓")}     history
  ${color("accent", "Ctrl+C")}             clear line / exit if empty / cancel a running query

${color("bold", "THEME")}
  ${color("accent", "VKTECH_THEME=violet")}   default Claude-style violet look & feel
  ${color("accent", "VKTECH_THEME=coral")}    Claude-orange (coral) palette
  ${color("dim", "NO_COLOR=1")}            disable all color    ${color("dim", "(current: " + THEME_NAME + ")")}
`);
}

// Names the REPL accepts in `/providers <name>` and `/model <name>`.
const PROVIDER_SWITCHES = "local, ollama, grok, claude, gpt-5, gemini";
const PROVIDER_SWITCH_ALIAS = {
  local: "local",
  anthropic: "claude",
  xai: "grok",
  openai: "gpt-5",
  gemini: "gemini",
};

// Switch the REPL's active analysis alias. Returns the alias to store, or
// null after printing the error. Ollama stays the boot default; this only
// changes the current session.
function applyActiveProvider(name) {
  if (name && resolveProvider(name)) {
    const provider = resolveProvider(name);
    console.log(color("dim", `Active provider -> ${name} · ${displayModel(provider)}`));
    if (provider !== "local") {
      console.log(color("dim", "Text only on this provider. /providers local edits code, browses, and checks the RTX."));
    }
    return name;
  }
  console.log(color("red", `Unknown provider "${name || ""}". Try ${PROVIDER_SWITCHES}.`));
  return null;
}

function showProviders(activeAlias) {
  console.log(color("bold", "\nConfigured providers:\n"));
  // Listed in real PRIORITY order so the first ✓ row is what actually runs by
  // default. `local` is keyless (self-hosted Ollama) — it's gated on the box
  // being reachable, not on a key, so it never shows "no key".
  const META = {
    local:     ["Local/GPU", null],
    anthropic: ["Anthropic", "ANTHROPIC_API_KEY"],
    xai:       ["xAI",       "XAI_API_KEY"],
    openai:    ["OpenAI",    "OPENAI_API_KEY"],
    gemini:    ["Gemini",    "GEMINI_API_KEY"],
  };
  const activeProvider = resolveProvider(activeAlias)
    || PRIORITY.find((p) => providerConfigured(p))
    || null;
  for (const p of PRIORITY.filter((p) => META[p])) {
    const [name, env] = META[p];
    // xAI in grok-CLI mode authenticates through `grok login`, not a key, so
    // it is keyless here even though KEY_ENV still names XAI_API_KEY.
    const viaCli = p === "xai" && useGrokCli();
    const status = (!env || viaCli)
      ? color("green", viaCli ? "✓ grok CLI" : "✓ keyless")
      : (process.env[env] ? color("green", "✓ key set") : color("red", "✗ no key"));
    const mark = p === activeProvider ? color("accent", "●") : color("dim", "·");
    const sw = PROVIDER_SWITCH_ALIAS[p] || p;
    console.log(`  ${mark} ${name.padEnd(10)} ${status.padEnd(20)} ${color("dim", displayModel(p))}  ${color("dim", "/providers " + sw)}`);
  }
  console.log(color("dim", `\n  default: ${PRIORITY.find((p) => providerConfigured(p)) || "none"}`
    + ` · vision: ${VISION_PRIORITY[0] || "none"}${VISION_LOCAL_ONLY ? " (local-only)" : ""}`));
  console.log(color("dim", `  switch: /providers <${PROVIDER_SWITCHES}>`));
  const claudeBin = process.env.CLAUDE_BIN || "claude";
  const codeAgent = /^(claude|anthropic)$/i.test(process.env.VKTECH_CODE_AGENT || "") ? "claude" : "local";
  console.log(`\n  ${color("chrome", "Code agent")} ${codeAgent === "local"
    ? color("green", `RTX Ollama · ${displayModel("local")}`)
    : color("yellow", "Claude Code")}`);
  console.log(color("dim", `  ollama ${LOCAL_URL} · ctx joins the loaded runner (else 32768) · --claude uses "${claudeBin}"`));
  console.log(`  ${color("dim", "theme:")} ${color("accent", THEME_NAME)} ${color("dim", "(VKTECH_THEME=violet|coral)")}\n`);
}

// Parse "--model x"/"-m x" and "--image path"/"-i path" (repeatable) out of an
// argv array, return { model, images: string[], rest }.
function extractModel(argv) {
  let model = null;
  const images = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model" || argv[i] === "-m") {
      model = argv[++i];
    } else if (argv[i] === "--image" || argv[i] === "-i") {
      const p = argv[++i];
      if (p) images.push(p);
    } else {
      rest.push(argv[i]);
    }
  }
  return { model, images, rest };
}

// Load image files into [{ mime, dataB64 }] for the vision API.
function loadImages(paths) {
  const MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp",
  };
  return paths.map((p) => {
    if (!existsSync(p)) {
      console.error(color("red", `Error: image not found: ${p}`));
      process.exit(1);
    }
    const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
    const mime = MIME[ext];
    if (!mime) {
      console.error(color("red", `Error: unsupported image type "${ext}" (use png/jpg/gif/webp): ${p}`));
      process.exit(1);
    }
    return { mime, dataB64: readFileSync(p).toString("base64") };
  });
}

async function doAskVision(model, images, prompt) {
  if (!prompt) {
    console.error(color("red", "Error: no prompt provided."));
    process.exit(1);
  }
  const imgs = loadImages(images);
  const spin = startSpinner(`analyzing ${imgs.length} image${imgs.length === 1 ? "" : "s"}…`);
  const t0 = Date.now();
  try {
    const { provider, model: usedModel, text } = await askVision({
      modelArg: model || null,
      prompt,
      system: ANALYSIS_SYSTEM,
      images: imgs,
    });
    spin.stop();
    console.log(color("cyan", `\n[${provider}:${usedModel} · vision]\n`));
    console.log(renderMarkdown(text) + "\n");
    statusFooter({ provider, model: usedModel, ms: Date.now() - t0, chars: text.length });
  } catch (err) {
    spin.stop();
    console.error(color("red", `\nVision error: ${err.message}\n`));
    process.exit(1);
  }
}

async function doAsk(model, prompt) {
  if (!model) {
    console.error(color("red", "Error: --model is required for `ask`. e.g. -m gpt-5"));
    process.exit(1);
  }
  if (!prompt) {
    console.error(color("red", "Error: no prompt provided."));
    process.exit(1);
  }
  const spin = startSpinner(`querying ${model}…`);
  const t0 = Date.now();
  try {
    const { provider, model: usedModel, text } = await ask({
      modelArg: model,
      prompt,
      system: ANALYSIS_SYSTEM,
    });
    spin.stop();
    console.log(color("cyan", `\n[${provider}:${usedModel}]\n`));
    console.log(renderMarkdown(text) + "\n");
    statusFooter({ provider, model: usedModel, ms: Date.now() - t0, chars: text.length });
  } catch (err) {
    spin.stop();
    console.error(color("red", `\nProvider error: ${err.message}\n`));
    process.exit(1);
  }
}

function showTemplates() {
  const tpls = listTemplates(ROOT);
  if (!tpls.length) {
    console.log(color("yellow", "No templates found in templates/."));
    return;
  }
  console.log(color("bold", "\nAudit templates:\n"));
  for (const t of tpls) {
    const def = t.file && existsSync(join(ROOT, "templates", t.file)) &&
      readFileSync(join(ROOT, "templates", t.file), "utf8").includes("default: true");
    const tag = def ? color("green", " (default)") : "";
    console.log(`  ${color("cyan", t.name.padEnd(20))} ${color("dim", "[" + t.model + "]")}  ${t.title}${tag}`);
  }
  console.log(color("dim", `\nRun:  vktech audit <name> -d <project-dir> [-o report.md] [-m <model>]\n`));
}

// `vktech run|sh|remote` — paste a multi-line snippet (heredoc/stdin/file/-c) and run it.
//   vktech run            paste JS, run with Node (top-level await ok)
//   vktech sh             paste shell, run with bash
//   vktech remote --host  pipe the snippet to a host over SSH (node|shell via --lang)
async function doRun(kind, argv) {
  let file = null, inline = null, host = null, lang = (kind === "sh" ? "shell" : "node");
  const sshArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--file") file = argv[++i];
    else if (a === "-c") inline = argv[++i];
    else if (a === "-h" || a === "--host") host = argv[++i];
    else if (a === "--lang") lang = argv[++i];
    else if (a === "--ssh") sshArgs.push(argv[++i]);
    else if (!a.startsWith("-") && inline === null && !file) inline = a;
  }

  const promptHint = color("dim",
    `Paste your ${lang === "shell" ? "shell" : "JS"} snippet, then press Ctrl-D to run` +
    (kind === "remote" ? ` on ${host || "<host>"}` : "") + `:\n`);
  const snippet = await readSnippet({ file, inline, promptHint });
  if (!snippet.trim()) { console.error(color("red", "Nothing to run (empty snippet).")); process.exit(1); }

  try {
    let code;
    if (kind === "remote") {
      if (!host) { console.error(color("red", "remote: --host required, e.g. --host root@1.2.3.4")); process.exit(1); }
      process.stderr.write(color("magenta", `→ Running ${lang} snippet on ${host} via ssh…\n`));
      code = await runRemote(snippet, { host, lang, sshArgs });
    } else if (kind === "sh") {
      process.stderr.write(color("magenta", `→ Running shell snippet locally…\n`));
      code = await runLocalShell(snippet);
    } else {
      process.stderr.write(color("magenta", `→ Running JS snippet locally with Node…\n`));
      code = await runLocalJs(snippet);
    }
    process.exit(code);
  } catch (err) {
    console.error(color("red", `\nrun error: ${err.message}\n`));
    process.exit(1);
  }
}

function showIndustries() {
  console.log(color("bold", "\nDetectable industries (vktech audit auto):\n"));
  for (const ind of INDUSTRIES) {
    console.log(`  ${color("cyan", ind.label)}`);
    console.log(color("dim", `    template: ${ind.template}  |  frameworks: ${ind.frameworks.join(", ")}`));
  }
  console.log(color("dim", `\n  vktech audit auto -d <dir>   # detect + audit\n  vktech detect -d <dir>       # show detection only\n`));
}

function defaultTemplateName() {
  const tpls = listTemplates(ROOT);
  for (const t of tpls) {
    const raw = readFileSync(join(ROOT, "templates", t.file), "utf8");
    if (raw.includes("default: true")) return t.name;
  }
  return tpls[0]?.name || null;
}

// `vktech identify` — recognize music in an audio/video file via Shazam.
//   vktech identify <file> [--step N] [--win N] [--json]
async function doIdentify(argv) {
  let file = null, step = 40, win = 12, asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--step") step = Number(argv[++i]);
    else if (a === "--win") win = Number(argv[++i]);
    else if (a === "--json") asJson = true;
    else if (!a.startsWith("-")) file = a;
  }
  if (!file) { console.error(color("red", "Usage: vktech identify <audio|video file> [--step 40] [--win 12] [--json]")); process.exit(1); }
  if (!existsSync(file)) { console.error(color("red", `file not found: ${file}`)); process.exit(1); }

  const log = asJson ? null : { info: (m) => console.log(color("grey", m)), warn: (m) => console.log(color("yellow", m)) };
  if (!asJson) console.log(color("chrome", "vktech identify") + color("grey", `  scanning ${file}…`));
  try {
    const res = await identify(file, { step, win, log });
    if (asJson) { console.log(JSON.stringify(res, null, 2)); process.exit(0); }
    console.log("");
    if (!res.hits.length) {
      console.log(color("yellow", "No music recognized (likely speech or silence)."));
    } else {
      console.log(color("heading", `Identified ${res.hits.length} track(s):`));
      for (const h of res.hits) {
        console.log(color("green", `  ♪ ${h.title} — ${h.artist}`) + color("grey", `   [${fmt(h.at)}–${fmt(h.end)}]`));
        if (h.isrc) console.log(color("grey", `     ISRC ${h.isrc}`) + (h.url ? color("grey", ` · ${h.url}`) : ""));
        else if (h.url) console.log(color("grey", `     ${h.url}`));
      }
    }
  } catch (e) {
    console.error(color("red", `\nidentify failed: ${e.message}\n`));
    process.exit(1);
  }
  process.exit(0);
}

// `vktech transcribe` — offline speech-to-text (whisper.cpp) for audio/video.
//   vktech transcribe <file|dir> [--model small.en] [--srt] [--txt-only]
//                     [--combine] [-o out_dir] [--lang en] [--dry-run]
// Default output is .txt beside the input; add --srt for subtitles, --combine
// to also write ALL_TRANSCRIPTS_COMBINED.txt when transcribing a directory.
// vktech search "<query>" [-m model] [-n N] [--raw] [--native]
//   Web search for the local Ollama. Default backend = self-hosted SearXNG
//   (LAN-first, tailnet fallback): many results, multi-engine, deep page fetch,
//   no rate limits. --native uses Ollama's cloud web_search API (needs OLLAMA_API_KEY).
//   --raw prints results only (no LLM). -n = # pages to deep-fetch (default 3).
async function doSearch(argv) {
  let model = null, fetchN = 3, raw = false, native = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-m" || a === "--model") model = argv[++i];
    else if (a === "-n" || a === "--fetch") fetchN = Number(argv[++i]);
    else if (a === "--raw") raw = true;
    else if (a === "--native") native = true;
    else rest.push(a);
  }
  const query = rest.join(" ").trim();
  if (!query) {
    console.error(color("red", 'Usage: vktech search "<query>" [-m model] [-n N] [--raw] [--native]'));
    process.exit(1);
  }
  const spin = startSpinner(native ? "searching (ollama cloud)…" : "searching (searxng)…");
  const t0 = Date.now();
  try {
    const { answer, results, backend, model: usedModel } = await webSearch(query, { model, fetchN, raw, native });
    spin.stop();
    if (raw) {
      console.log(color("cyan", `\n[${backend}] ${results.length} results\n`));
      for (const r of results) {
        console.log(color("heading", `• ${r.title}`));
        console.log(color("grey", `  ${r.url}`));
        if (r.content) console.log(`  ${r.content.slice(0, 300)}`);
        console.log("");
      }
      return;
    }
    console.log(color("cyan", `\n[${backend} · ${usedModel}]\n`));
    console.log(renderMarkdown(answer) + "\n");
    statusFooter({ provider: "search", model: usedModel, ms: Date.now() - t0, chars: (answer || "").length });
  } catch (err) {
    spin.stop();
    console.error(color("red", `\nsearch error: ${err.message}\n`));
    process.exit(1);
  }
}

// PAID feature (VKTECH_LICENSE / VKTECH_PRO=1). --dry-run lists inputs for free.
async function doTranscribe(argv) {
  let input = null, model = null, outDir = null, lang = "en";
  let srt = false, txt = true, combine = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" || a === "-m") model = argv[++i];
    else if (a === "-o" || a === "--out") outDir = argv[++i];
    else if (a === "--lang" || a === "-l") lang = argv[++i];
    else if (a === "--srt") srt = true;
    else if (a === "--srt-only") { srt = true; txt = false; }
    else if (a === "--txt-only" || a === "--no-srt") txt = true;
    else if (a === "--combine") combine = true;
    else if (a === "--dry-run") dryRun = true;
    else if (!a.startsWith("-")) input = a;
  }
  if (!input) {
    console.error(color("red", "Usage: vktech transcribe <file|dir> [--model small.en] [--srt] [--combine] [-o out_dir] [--lang en] [--dry-run]"));
    process.exit(1);
  }
  if (!srt && !txt) txt = true; // never produce nothing

  const log = { info: (m) => console.log(color("grey", m)), warn: (m) => console.log(color("yellow", m)) };
  console.log(color("chrome", "vktech transcribe") + color("grey", `  ${input}  (whisper.cpp, model ${model || process.env.VKTECH_WHISPER_MODEL || "small.en"})`));

  // Free preview: list the files that would be transcribed, no work done.
  if (dryRun) {
    try {
      const files = listTranscribable(input);
      console.log(color("grey", `  dry-run — ${files.length} file(s) would be transcribed:`));
      for (const f of files) console.log(color("grey", `   • ${basename(f)}`));
      console.log(color("grey", `  formats: ${[txt && "txt", srt && "srt"].filter(Boolean).join("+")}` + (combine ? " + combined" : "")));
    } catch (e) {
      console.error(color("red", `\ntranscribe failed: ${e.message}\n`));
      process.exit(1);
    }
    process.exit(0);
  }

  // Paid gate — matches `vktech edit` / `vktech dns`.
  if (!isLicensed()) {
    console.error(color("red", "vktech transcribe is a paid feature.") +
      color("grey", " Set VKTECH_LICENSE (or VKTECH_PRO=1) in your vktech env to run it. Use --dry-run to preview the file list for free, or get access at https://video.vktech.ai"));
    process.exit(1);
  }

  try {
    const { outputs, combined, outDir: dir } = await transcribe(input, { model, lang, srt, txt, combine, outDir, log });
    console.log("");
    console.log(color("green", `✓ transcribed ${outputs.length} file(s)`) + color("grey", ` → ${dir}`));
    for (const o of outputs) {
      const made = [o.txt && "txt", o.srt && "srt"].filter(Boolean).join("+");
      console.log(color("grey", `   ${basename(o.src)}  (${made})`));
    }
    if (combined) console.log(color("heading", `\n   combined → ${combined}`));
  } catch (e) {
    console.error(color("red", `\ntranscribe failed: ${e.message}\n`));
    process.exit(1);
  }
  process.exit(0);
}

// `vktech dns` — provision Cloudflare DNS for a published site/preview (paid).
//   vktech dns publish <subdomain> --ip <addr> [--dns-only]
//   vktech dns remove  <subdomain>
async function doDns(argv) {
  const action = argv[0];
  const name = argv[1];
  let ip = null, proxied = true;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--ip") ip = argv[++i];
    else if (argv[i] === "--dns-only") proxied = false;
  }
  if (!["publish", "remove"].includes(action) || !name) {
    console.error(color("red", "Usage: vktech dns publish <subdomain> --ip <addr> [--dns-only]   |   vktech dns remove <subdomain>"));
    process.exit(1);
  }
  if (!isLicensed()) {
    console.error(color("red", "Cloudflare publishing is a paid feature. Set VKTECH_LICENSE (or VKTECH_PRO=1) in your vktech env."));
    process.exit(1);
  }
  try {
    if (action === "publish") {
      if (!ip) { console.error(color("red", "publish requires --ip <addr>")); process.exit(1); }
      const r = await upsertA(name, ip, { proxied });
      console.log(color("green", `✓ ${r.action} ${r.name} → ${r.content}`) + color("grey", ` (proxied=${r.proxied})`));
    } else {
      const r = await removeA(name);
      console.log(color("green", `✓ ${r.action} ${r.name}`));
    }
  } catch (e) {
    console.error(color("red", `\nDNS failed: ${e.message}\n`));
    process.exit(1);
  }
  process.exit(0);
}

// `vktech edit` — automated video-editing engine. Config-driven, zero prompts.
//   vktech edit --config job.json
//   vktech edit -d <clips_dir> -o <out.mp4> [--preset memorial|vlog|neutral]
//               [--captions vision|off] [--encoder auto|libx265|...] [--dry-run]
async function doEdit(argv) {
  let configPath = null;
  const ov = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-c") configPath = argv[++i];
    else if (a === "-d" || a === "--input") ov.input = argv[++i];
    else if (a === "-o" || a === "--output") ov.output = argv[++i];
    else if (a === "--preset") ov.tone_preset = argv[++i];
    else if (a === "--encoder") ov.encoder = argv[++i];
    else if (a === "--captions") ov.captions = { mode: argv[++i] };
    else if (a === "--dark") ov.dark = { mode: argv[++i] };
    else if (a === "--dry-run") ov.dry_run = true;
    else if (a === "--premiere") ov.premiere = true;
    else if (a === "--runtime") ov.target_runtime_sec = Number(argv[++i]);
    // Audio questionnaire flags (music track).
    else if (a === "--audio") { (ov.audio ??= {}).track = argv[++i]; }
    else if (a === "--speech") { (ov.audio ??= {}).speech_track = argv[++i]; } // enhanced-speech source for the tail
    else if (a === "--audio-mode") { (ov.audio ??= {}).mode = argv[++i]; }   // replace_all|bed|opening
    else if (a === "--audio-sync") { (ov.audio ??= {}).sync = argv[++i]; }   // auto|none
    else if (a === "--audio-opening") { (ov.audio ??= {}).opening_sec = Number(argv[++i]); }
    else if (a === "--audio-bed-db") { (ov.audio ??= {}).bed_gain_db = Number(argv[++i]); }
    else if (a === "--no-audio-loop") { (ov.audio ??= {}).loop = false; }
  }
  // A bare --audio with no explicit mode defaults to a full soundtrack.
  if (ov.audio && ov.audio.track && !ov.audio.mode) ov.audio.mode = "replace_all";
  // Paid gate: rendering requires a license. --dry-run (plan only) stays free
  // so prospects can evaluate the cut before buying.
  if (!ov.dry_run && !isLicensed()) {
    console.error(color("red", "vktech edit is a paid feature.") +
      color("grey", " Set VKTECH_LICENSE (or VKTECH_PRO=1) to render. Use --dry-run to preview the plan for free, or get access at https://video.vktech.ai"));
    process.exit(1);
  }

  if (!configPath && !ov.input) {
    console.error(color("red", 'Usage: vktech edit --config job.json   OR   vktech edit -d <clips_dir> -o <out.mp4> [--preset ...] [--captions vision|off] [--dry-run]'));
    process.exit(1);
  }

  let cfg;
  try {
    cfg = loadConfig(configPath, ov);
  } catch (e) {
    console.error(color("red", `\n${e.message}\n`));
    process.exit(1);
  }

  // Theme-aware logger passed into the pure engine.
  const log = {
    step: (m) => console.log(color("heading", `\n▸ ${m}`)),
    info: (m) => console.log(color("grey", m)),
    warn: (m) => console.log(color("yellow", m)),
  };

  console.log(color("chrome", `vktech edit`) + color("grey", `  ${cfg.input} -> ${cfg.output}`));
  const spin = startSpinner("editing…");
  try {
    const res = await runEdit(cfg, { log });
    spin.stop();
    if (res.dryRun) {
      console.log(color("green", `\n✓ Dry run: ${res.segments} segments, ${(res.runtimeSec / 60).toFixed(1)} min planned`));
      console.log(color("grey", `  plan: ${res.planPath}`));
    } else {
      console.log(color("green", `\n✓ Done: ${res.output}`));
      console.log(color("grey", `  ${(res.runtimeSec / 60).toFixed(1)} min · ${res.segments} segments · ${res.encoder} · ${res.captions} captions · audio:${res.audio} · ${res.verified ? "verified" : res.decodeErrors + " decode errors"}`));
    }
    if (res.premiere) {
      console.log(color("chrome", `  Premiere project:`) + color("grey", ` ${res.premiere.fcpxmlPath}`));
      console.log(color("grey", `                    ${res.premiere.edlPath}`));
    }
  } catch (e) {
    spin.stop();
    console.error(color("red", `\nEdit failed: ${e.message}\n`));
    process.exit(1);
  }
  process.exit(0);
}

async function doAudit(argv) {
  // argv after "audit". Supports: <name> -d <dir> -o <out> -m <model> --list
  if (argv.includes("--list") || argv.includes("-l")) return showTemplates();

  let dir = process.cwd();
  let out = null;
  let modelOverride = null;
  let name = null;
  let useAll = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-d" || a === "--dir") dir = argv[++i];
    else if (a === "-o" || a === "--out") out = argv[++i];
    else if (a === "-m" || a === "--model") modelOverride = argv[++i];
    else if (a === "--all" || a === "-a") useAll = true;
    else if (!a.startsWith("-")) name = a;
  }

  name = name || defaultTemplateName();
  if (!name) {
    console.error(color("red", "No templates available. Add one under templates/."));
    process.exit(1);
  }

  const targetDir = resolvePath(dir);
  if (!existsSync(targetDir)) {
    console.error(color("red", `Project dir not found: ${targetDir}`));
    process.exit(1);
  }

  // Dynamic mode: `vktech audit auto` detects the project's industry, picks the
  // best-fit template, and injects industry-specific compliance frameworks.
  let industryAddendum = "";
  if (name === "auto") {
    process.stderr.write(color("dim", `\n… auto-detecting industry of ${targetDir}\n`));
    const { industry, confident, ranking } = detectIndustry(targetDir);
    name = industry.template;
    const rankStr = ranking.map((r) => `${r.label.split(" ")[0]}(${r.score})`).join(", ");
    process.stderr.write(
      color("cyan", `→ Industry: ${industry.label}` +
        (confident ? "" : color("yellow", " (low confidence — defaulting)")) + `\n`) +
      color("dim", `  frameworks: ${industry.frameworks.join(", ")}\n`) +
      color("dim", `  signals ranked: ${rankStr || "none"}\n`) +
      color("dim", `  → using template "${name}"\n`)
    );
    industryAddendum =
      `\n\n## DETECTED INDUSTRY CONTEXT (auto)\n` +
      `This project was auto-classified as: ${industry.label}.\n` +
      `Grade it specifically against these frameworks (in addition to general production ` +
      `readiness): ${industry.frameworks.join(", ")}.\n` +
      (industry.fallback
        ? `NOTE: detection confidence was low; if the code clearly belongs to a different ` +
          `industry, say so and re-grade against the correct frameworks.\n`
        : "") +
      `Begin your report by stating the detected industry and the framework set you used.\n`;
  }

  const tpl = loadTemplate(ROOT, name);
  if (!tpl) {
    console.error(color("red", `Template "${name}" not found. Try: vktech audit --list`));
    process.exit(1);
  }

  const model = modelOverride || tpl.model;
  process.stderr.write(color("dim", `\n… template "${tpl.name}" over ${targetDir}\n`));
  let { prompt, files, skipped, bytes } = buildPrompt({ root: ROOT, targetDir, template: tpl });
  // Inject the industry framework guidance right after the instruction body.
  if (industryAddendum) prompt = industryAddendum + "\n" + prompt;
  process.stderr.write(
    color("dim", `… bundled ${files.length} files (~${Math.round(bytes / 4)} tokens)` +
      (skipped.length ? `, ${skipped.length} omitted for size` : "") + `\n`)
  );
  if (!files.length) {
    console.error(color("yellow", `Warning: no files matched the template's include globs in ${targetDir}.`));
  }
  const saveReport = (header, body) => {
    if (!out) return;
    const outPath = (isAbsolute(out) || out.startsWith("~"))
      ? resolvePath(out)
      : join(targetDir, out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, header + body + "\n");
    process.stderr.write(color("green", `✓ Saved report: ${outPath}\n`));
  };

  // --- Multi-provider mode: run EVERY configured API, consolidate for Claude ---
  if (useAll) {
    const provs = availableProviders();
    process.stderr.write(color("dim", `… querying ALL providers: ${provs.join(", ")}\n`));
    const results = await askAll({ prompt, system: ANALYSIS_SYSTEM, providers: provs });
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    let body = `> Multi-provider audit. ${ok.length}/${results.length} providers responded.\n\n`;
    body += `## How to use this report (for Claude / the implementer)\n` +
      `Each provider below independently audited the same code bundle. Treat agreements as ` +
      `high-confidence, and reconcile disagreements by reading the cited files. Implement the ` +
      `fixes in priority order.\n\n`;
    for (const r of results) {
      body += `\n================================================================================\n`;
      body += `## ${r.provider.toUpperCase()} (${r.model})${r.ok ? "" : "  — FAILED"}\n`;
      body += `================================================================================\n\n`;
      body += r.ok ? r.text : `Provider error: ${r.error}`;
      body += `\n`;
    }
    const header = `# vktech multi-provider audit: ${tpl.title || tpl.name}\n` +
      `Template: ${tpl.name} | Providers: ${results.map((r) => r.provider + (r.ok ? "✓" : "✗")).join(", ")} | ` +
      `Files: ${files.length} | Dir: ${targetDir}\n\n`;
    console.log(color("cyan", `\n[multi-provider: ${ok.map((r) => r.provider).join(", ")}${failed.length ? " | failed: " + failed.map((r) => r.provider).join(", ") : ""}] template=${tpl.name}\n`));
    console.log(body);
    saveReport(header, body);
    return;
  }

  // --- Single-provider mode ---
  process.stderr.write(color("dim", `… querying ${model}\n`));
  try {
    const { provider, model: usedModel, text } = await ask({
      modelArg: model, prompt, system: ANALYSIS_SYSTEM,
    });
    const header = `# vktech audit: ${tpl.title || tpl.name}\n` +
      `Template: ${tpl.name} | Model: ${provider}:${usedModel} | Files: ${files.length} | Dir: ${targetDir}\n\n`;
    console.log(color("cyan", `\n[${provider}:${usedModel}] template=${tpl.name}\n`));
    console.log(renderMarkdown(text) + "\n");
    saveReport(header, text);
  } catch (err) {
    console.error(color("red", `\nProvider error: ${err.message}\n`));
    process.exit(1);
  }
}

// Ctrl-C during a request aborts the in-flight call. The boxed reader has
// already released stdin, so re-attach a raw keypress watcher plus SIGINT.
async function withQueryCancel(fn) {
  const ac = new AbortController();
  const cancel = () => { if (!ac.signal.aborted) ac.abort(new Error("cancelled")); };
  const tty = process.stdin.isTTY && process.stdout.isTTY && !NO_COLOR;
  const onWatchKey = (_str, key) => { if (key && key.ctrl && key.name === "c") cancel(); };
  if (tty) {
    emitKeypressEvents(process.stdin);
    if (process.stdin.isRaw !== true) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onWatchKey);
  }
  process.once("SIGINT", cancel);
  try {
    return await fn(ac.signal);
  } catch (err) {
    if (ac.signal.aborted) throw new Error("cancelled");
    throw err;
  } finally {
    process.removeListener("SIGINT", cancel);
    if (tty) {
      process.stdin.removeListener("keypress", onWatchKey);
      if (process.stdin.isRaw) process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
}

// Flags only as a prefix; everything after them is the prompt, spaces included.
function parseCodeArgs(argv) {
  let claude = /^(claude|anthropic)$/i.test(process.env.VKTECH_CODE_AGENT || "");
  let dir = process.cwd();
  let model = null;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--claude") { claude = true; i++; continue; }
    if (a === "--local" || a === "--ollama") { claude = false; i++; continue; }
    if ((a === "-d" || a === "--dir") && argv[i + 1]) { dir = resolvePath(argv[++i]); i++; continue; }
    if ((a === "-m" || a === "--model") && argv[i + 1]) {
      model = argv[++i];
      i++;
      if (resolveProvider(model) === "anthropic") claude = true;
      continue;
    }
    break;
  }
  return { claude, dir, model, prompt: argv.slice(i).join(" ").trim() };
}

function ollamaModelId(model) {
  if (!model || model === "local" || model === "ollama" || model === "self-hosted") return DEFAULTS.local;
  if (resolveProvider(model) && resolveProvider(model) !== "local") return null;
  return model;
}

const CODE_USAGE = 'Usage: vktech code [--claude] [-d dir] [-m <ollama-model>] "<what to implement>"';

async function executeCode(argv, { exitOnEnd = false } = {}) {
  const parsed = parseCodeArgs(argv);
  const fail = (message, status = 1) => {
    console.error(color("red", message));
    if (exitOnEnd) process.exit(status);
  };
  if (!parsed.prompt) return fail(CODE_USAGE);
  if (parsed.claude) {
    console.log(color("magenta", "→ Handing off to Claude Code…\n"));
    const code = await runClaude(parsed.prompt);
    if (exitOnEnd) process.exit(code);
    return;
  }
  const model = ollamaModelId(parsed.model);
  if (!model) {
    return fail(`vktech code runs on RTX Ollama. "${parsed.model}" is not a local model. Use --claude for Claude Code, or -m qwen3.8:27b.`);
  }
  const dir = resolvePath(parsed.dir);
  if (!existsSync(dir)) return fail(`Dir not found: ${dir}`);
  console.log(color("magenta", `→ RTX Ollama agent (${model})\n`) + color("dim", `  ${dir}\n`));
  const t0 = Date.now();
  try {
    const result = await withQueryCancel((signal) => runLocalAgent({
      prompt: parsed.prompt,
      cwd: dir,
      model,
      signal,
      spin: (label) => startSpinner(`${label}  (Ctrl-C to cancel)`),
      log: (s) => process.stderr.write(color("dim", s.endsWith("\n") ? s : s + "\n")),
      write: (s) => process.stdout.write(s),
    }));
    if (result.files.length) console.log(color("green", `edited ${result.files.join(", ")}\n`));
    statusFooter({ provider: "local", model: result.model, ms: Date.now() - t0, chars: result.text.length });
    if (exitOnEnd) process.exit(0);
  } catch (err) {
    if (err?.message === "cancelled") {
      console.log(color("yellow", "\n✗ cancelled\n"));
      if (exitOnEnd) process.exit(130);
      return;
    }
    fail(`Agent error: ${err.message}`);
  }
}

function printTranscript(session, { limit = 0 } = {}) {
  const all = session.transcript || [];
  const rows = limit > 0 && all.length > limit ? all.slice(-limit) : all;
  const skipped = all.length - rows.length;
  if (skipped > 0) {
    console.log(color("dim", `… ${skipped} earlier messages. /history prints the full conversation.`));
  }
  for (const turn of rows) {
    const who = turn.role === "user" ? "you" : (session.model || "agent");
    console.log(color("chrome", `\n${who}`));
    console.log(turn.role === "user" ? turn.text : renderMarkdown(turn.text));
  }
  if (rows.length) console.log("");
}

function printSessionList(cwd) {
  const rows = listSessions(cwd);
  if (!rows.length) {
    console.log(color("dim", "No saved conversations in this folder."));
    return rows;
  }
  console.log(color("bold", "\nConversations in this folder:\n"));
  rows.slice(0, 20).forEach((row, i) => {
    const when = String(row.updated).replace("T", " ").slice(0, 16);
    console.log(`  ${color("accent", String(i + 1).padStart(2))}  ${color("dim", when)}  ${row.title}`);
  });
  console.log(color("dim", "\n  /history <n> prints that conversation and continues it. /new starts fresh.\n"));
  return rows;
}

async function repl() {
  // Boot on the highest-priority configured provider (default: local). The
  // alias stays valid for xai in grok-CLI mode, where there is no pinned model id.
  const cwd = realpathSync(process.cwd());
  const _avail = availableProviders();
  let activeModel = _avail.length ? _avail[0] : null;
  let pendingFile = "";
  let session = latestSession(cwd) || createSession(cwd);
  console.log(banner([
    `${color("heading", "✦ vktech")} ${color("grey", "v" + version())} ${color("chrome", "— RTX agent")}`,
    `${color("grey", "Type")} ${color("accent", "/help")} ${color("grey", "for commands,")} ${color("accent", "/exit")} ${color("grey", "to quit.")}`,
  ]));
  const bootProvider = activeModel ? resolveProvider(activeModel) : null;
  const bootLabel = bootProvider ? `${activeModel} · ${displayModel(bootProvider)}` : (activeModel || "none");
  console.log(color("dim", `Active: `) + color("chrome", bootLabel));
  console.log(color("dim", `Workspace: ${cwd}`));
  console.log(color("dim", "Plain text edits code, runs commands, searches the web, and checks the RTX."));
  if ((session.transcript || []).length) {
    console.log(color("dim", `Resumed "${session.title || "conversation"}" · ${session.transcript.length} messages. Scroll up to read it. /history lists others. /new starts fresh.`));
    printTranscript(session, { limit: 20 });
  } else {
    console.log(color("dim", "New conversation. /history lists older ones.\n"));
  }

  // Permanent bottom window: rules above and below the caret, redrawn to the
  // live width. Output scrolls above it. Up/Down recalls earlier lines.
  const promptLabel = () => color("accent", "❯") + color("grey", ` ${activeModel}`);
  const history = loadLineHistory();
  if (history.length === 0) {
    for (const turn of session.transcript || []) {
      if (turn.role === "user" && turn.text) history.push(turn.text);
    }
  }
  const composer = openComposer({ historyRef: history, promptLabel });

  const quit = () => {
    composer.close();
    try {
      if ((session.transcript || []).length) saveSession(session);
      saveLineHistory(history);
    } catch { /* the terminal must be restored even if the save fails */ }
    console.log(color("dim", "bye 👋"));
    process.exit(0);
  };

  // Main loop: read one line from the pinned window, dispatch, repeat.
  for (;;) {
    const { line, eof } = await composer.read();
    if (eof) return quit();
    const input = (line || "").trim();
    if (!input) continue;
    if (input !== history[history.length - 1]) {
      history.push(input);
      saveLineHistory(history);
    }

    if (input === "/exit" || input === "/quit") return quit();
    if (input === "/help") { help(); continue; }
    if (input === "/providers" || input.startsWith("/providers ")) {
      const m = input.split(/\s+/)[1];
      if (!m) { showProviders(activeModel); continue; }
      const switched = applyActiveProvider(m);
      if (switched) activeModel = switched;
      continue;
    }
    if (input.startsWith("/model")) {
      const m = input.split(/\s+/)[1];
      const switched = applyActiveProvider(m);
      if (switched) activeModel = switched;
      continue;
    }
    if (input === "/new") {
      if (!(session.transcript || []).length) {
        console.log(color("dim", "Already a fresh conversation."));
        continue;
      }
      saveSession(session);
      session = createSession(cwd);
      console.log(color("dim", "Started a new conversation."));
      continue;
    }
    if (input === "/history" || input.startsWith("/history ")) {
      const which = input.split(/\s+/)[1];
      if (!which) { printSessionList(cwd); continue; }
      const rows = listSessions(cwd);
      const picked = rows[Number(which) - 1];
      if (!picked) {
        console.log(color("red", `No conversation ${which}. /history lists them.`));
        continue;
      }
      const loaded = loadSession(picked.id);
      if (!loaded) {
        console.log(color("red", "That conversation could not be read."));
        continue;
      }
      saveSession(session);
      session = loaded;
      console.log(color("dim", `Continuing "${session.title || "conversation"}". Scroll to read it.`));
      printTranscript(session);
      continue;
    }
    if (input.startsWith("/file")) {
      const p = input.slice(5).trim();
      if (p && existsSync(p)) {
        pendingFile = readFileSync(p, "utf8");
        console.log(color("dim", `Loaded ${p} (${pendingFile.length} chars) into next prompt.`));
      } else {
        console.log(color("red", `File not found: ${p}`));
      }
      continue;
    }
    if (input.startsWith("/code")) {
      const text = input.slice(5).trim();
      await executeCode(text ? text.split(/\s+/) : []);
      continue;
    }
    if (isReplyCheck(input)) {
      appendTranscript(session, "user", input);
      saveSession(session);
      console.log(color("dim", "\nChecking this repo's tracked mail…"));
      try {
        const text = await checkReplies({ cwd, focus: replyFocus(input) });
        console.log(`\n${text}\n`);
        appendTranscript(session, "assistant", text);
      } catch (err) {
        console.error(color("red", `Reply check failed: ${err.message}`));
        appendTranscript(session, "assistant", `(error: ${err.message})`);
      }
      saveSession(session);
      continue;
    }

    // Plain text. On local this is the RTX agent (tools + this conversation).
    // Ctrl-C aborts the in-flight call. The boxed reader has released stdin,
    // so withQueryCancel watches for Ctrl-C itself.
    const fullPrompt = pendingFile ? `${pendingFile}\n\n---\n\n${input}` : input;
    pendingFile = "";
    appendTranscript(session, "user", fullPrompt);
    // The question is on disk before the model runs, so a quit during the
    // first call still resumes this turn.
    saveSession(session);
    const t0 = Date.now();
    const localTurn = resolveProvider(activeModel) === "local";
    let liveText = "";
    const checkpoint = ({ phase, text, label, result, error }) => {
      if (phase === "assistant" && text) {
        liveText = text;
        upsertLiveTranscript(session, liveText, false);
      } else if (phase === "tool") {
        const line = `→ ${label}\n  ${toolResultPreview(result)}`;
        liveText = liveText ? `${liveText}\n${line}` : line;
        upsertLiveTranscript(session, liveText, false);
      } else if (phase === "done") {
        const body = String(text || liveText || "").trim();
        if (body) upsertLiveTranscript(session, body, true);
      } else if (phase === "cancel") {
        const note = error || "(cancelled)";
        liveText = liveText ? `${liveText}\n${note}` : note;
        upsertLiveTranscript(session, liveText, true);
      }
      saveSession(session);
    };
    try {
      if (localTurn) {
        const model = ollamaModelId(activeModel) || DEFAULTS.local;
        session.model = model;
        session.messages ||= [];
        console.log(color("cyan", `\n[local:${model}]\n`));
        const result = await withQueryCancel((signal) => runLocalAgent({
          prompt: fullPrompt,
          cwd,
          model,
          messages: session.messages,
          signal,
          onTrace: checkpoint,
          spin: (label) => startSpinner(`${label}  (Ctrl-C to cancel)`),
          log: (s) => process.stderr.write(color("dim", s.endsWith("\n") ? s : s + "\n")),
          write: (s) => process.stdout.write(s),
        }));
        session.messages = result.messages;
        if (result.files.length) console.log(color("green", `edited ${result.files.join(", ")}\n`));
        statusFooter({ provider: "local", model: result.model, ms: Date.now() - t0, chars: result.text.length });
      } else {
        const prior = (session.transcript || []).slice(0, -1).slice(-12)
          .map((turn) => `${turn.role}: ${String(turn.text).slice(0, 4000)}`)
          .join("\n\n");
        let memoryNote = "";
        try {
          const found = memoriesForPrompt(fullPrompt, cwd);
          memoryNote = found.text;
          if (found.terms.length) {
            const notes = found.count ? `${found.count} note${found.count === 1 ? "" : "s"}` : "none";
            console.log(color("dim", `→ memory ${found.terms.join(", ")} · ${notes}`));
          }
        } catch (err) {
          console.log(color("dim", `→ memory lookup failed (${err.message})`));
        }
        const asked = memoryNote
          ? `${memoryNote}\n\nUser request:\n${fullPrompt}`
          : fullPrompt;
        const prompt = prior ? `Conversation so far:\n${prior}\n\n${asked}` : asked;
        const spin = startSpinner(`querying ${activeModel}… (Ctrl-C to cancel)`);
        try {
          const { provider, model, text } = await withQueryCancel((signal) => ask({
            modelArg: activeModel,
            prompt,
            system: `${REPL_CLOUD_SYSTEM}\n\n${memoryBrief(cwd)}`,
            signal,
          }));
          spin.stop();
          console.log(color("cyan", `\n[${provider}:${model}]\n`));
          console.log(renderMarkdown(text) + "\n");
          appendTranscript(session, "assistant", text);
          session.messages ||= [];
          session.messages.push({ role: "user", content: fullPrompt });
          session.messages.push({ role: "assistant", content: text });
          statusFooter({ provider, model, ms: Date.now() - t0, chars: text.length });
        } catch (err) {
          spin.stop();
          throw err;
        }
      }
    } catch (err) {
      const note = err?.message === "cancelled" ? "(cancelled)" : `(error: ${err.message})`;
      const msgs = session.messages || [];
      const last = msgs[msgs.length - 1];
      if (last?.role === "user" && last.content === fullPrompt) {
        msgs.push({ role: "assistant", content: note });
        if (!localTurn) appendTranscript(session, "assistant", note);
      }
      if (localTurn) {
        // The agent checkpoint already wrote the in-progress row when it had one.
        const row = session.transcript?.[session.transcript.length - 1];
        const saved = row?.role === "assistant" && String(row.text || "").includes(note);
        if (!saved) appendTranscript(session, "assistant", note);
      }
      if (err?.message === "cancelled") console.log(color("yellow", "\n✗ cancelled\n"));
      else console.error(color("red", `Provider error: ${err.message}`));
    } finally {
      saveSession(session);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "--help" || cmd === "-h") return help();
  if (cmd === "--version" || cmd === "-v") return console.log(version());
  if (cmd === "providers") return showProviders();
  if (cmd === "templates") return showTemplates();
  if (cmd === "industries") return showIndustries();
  if (cmd === "detect") {
    // `vktech detect -d <dir>` — show detection without running an audit.
    let d = process.cwd();
    const a = argv.slice(1);
    for (let i = 0; i < a.length; i++) if (a[i] === "-d" || a[i] === "--dir") d = a[++i];
    const dir = resolvePath(d);
    if (!existsSync(dir)) { console.error(color("red", `Dir not found: ${dir}`)); process.exit(1); }
    const { industry, confident, ranking } = detectIndustry(dir);
    console.log(color("bold", `\nDetected: `) + color("cyan", industry.label) +
      (confident ? color("green", " (confident)") : color("yellow", " (low confidence)")));
    console.log(color("dim", `Template: ${industry.template} | Frameworks: ${industry.frameworks.join(", ")}`));
    console.log(color("dim", `Ranking: ${ranking.map((r) => `${r.label.split(" ")[0]}(${r.score})`).join(", ") || "none"}\n`));
    return;
  }
  if (cmd === "run" || cmd === "sh" || cmd === "remote") return doRun(cmd, argv.slice(1));
  if (cmd === "audit") return doAudit(argv.slice(1));
  if (cmd === "edit") return doEdit(argv.slice(1));
  if (cmd === "dns") return doDns(argv.slice(1));
  if (cmd === "identify") return doIdentify(argv.slice(1));
  if (cmd === "transcribe") return doTranscribe(argv.slice(1));
  if (cmd === "secrets" || cmd === "secret-audit") return runSecrets(argv.slice(1), { color, heading: (t) => color("heading", t) });
  if (cmd === "search" || cmd === "web") return doSearch(argv.slice(1));
  if (cmd === "replies") {
    const text = await checkReplies({ cwd: realpathSync(process.cwd()), focus: argv.slice(1).join(" ") });
    console.log(`\n${text}\n`);
    return;
  }

  if (cmd === "ask") {
    const { model, images, rest } = extractModel(argv.slice(1));
    if (images.length) return doAskVision(model, images, rest.join(" "));
    return doAsk(model, rest.join(" "));
  }

  if (cmd === "code") return executeCode(argv.slice(1), { exitOnEnd: true });

  // No recognized command -> REPL (also handles bare `vktech`).
  if (!cmd) return repl();

  console.error(color("red", `Unknown command: ${cmd}`));
  help();
  process.exit(1);
}

main().catch((err) => {
  console.error(color("red", `Fatal: ${err.message}`));
  process.exit(1);
});
