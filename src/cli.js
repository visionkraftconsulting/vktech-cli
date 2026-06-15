#!/usr/bin/env node
// vktech — multi-provider AI analysis CLI that hands code work to Claude Code.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
// dirname is already imported above for __dirname; reused for output paths.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

const { ask, askVision, askAll, availableProviders, PROVIDERS, DEFAULTS, resolveProvider } = await import("./providers.js");
const { runClaude } = await import("./claude.js");
const { listTemplates, loadTemplate, buildPrompt } = await import("./templates.js");
const { detectIndustry, INDUSTRIES } = await import("./industry.js");
const { readSnippet, runLocalJs, runLocalShell, runRemote } = await import("./run.js");
const { runEdit } = await import("./edit/index.js");
const { loadConfig } = await import("./edit/config.js");
const { upsertA, removeA, isLicensed } = await import("./edit/cloudflare.js");
const { identify, fmt } = await import("./edit/identify.js");

// ── Theme ────────────────────────────────────────────────────────────────
// "Full look & feel" palette modeled on the Claude Code TUI: one signature
// accent carries headings/prompt/borders, with muted secondary chrome, dim
// grey metadata, and the usual success/warn/error states. Two named themes —
// `violet` (default) and `coral` (Claude-orange) — selectable via
// VKTECH_THEME=violet|coral. Truecolor escapes by default; 256-color fallback
// when the terminal can't do 24-bit (NO_COLOR disables color entirely).
const TRUECOLOR = !process.env.NO_COLOR &&
  /truecolor|24bit/i.test(process.env.COLORTERM || "");
const NO_COLOR = !!process.env.NO_COLOR;

// Each entry: [truecolor RGB, 256-color index].
const THEMES = {
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
const THEME_NAME = (process.env.VKTECH_THEME || "violet").toLowerCase() in THEMES
  ? (process.env.VKTECH_THEME || "violet").toLowerCase()
  : "violet";
const PALETTE = THEMES[THEME_NAME];

const C = {
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

const color = (c, s) => NO_COLOR ? `${s}` : `${C[c]}${s}${C.reset}`;

// Visible length of a string, ignoring ANSI escape sequences.
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

// Terminal width, clamped to something sane for piped/non-TTY output.
function termWidth() {
  return Math.max(20, Math.min(process.stdout.columns || 80, 200));
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
  return color("accent", "─".repeat(termWidth()));
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
  const pad = Math.max(0, termWidth() - visLen(text));
  console.log(" ".repeat(pad) + color("grey", text));
}

// ── Boxed line editor ───────────────────────────────────────────────────────
// A raw-mode replacement for readline so the input "❯" caret can live inside a
// live 3-line violet box (rule / caret+text / rule), both rules visible while
// typing — readline can't do this because it clears below its own prompt line.
// Supports: printable input, Backspace, Left/Right/Home/End, Up/Down history,
// Enter (submit), Ctrl-C (abort line), Ctrl-D (EOF on empty line). Falls back to
// plain readline when stdin isn't an interactive TTY (pipes, NO_COLOR scripts).
function makeBoxedReader({ historyRef, promptLabel }) {
  const stdin = process.stdin;
  const out = process.stdout;
  const interactive = stdin.isTTY && out.isTTY && !NO_COLOR;

  // Plain (non-TTY) fallback: one readline question with a leading rule.
  if (!interactive) {
    return (close) => new Promise((resolve) => {
      const rl = createInterface({ input: stdin, output: out });
      console.log(rule());
      rl.question(`${promptLabel()} `, (answer) => { rl.close(); resolve({ line: answer, eof: false }); });
      rl.on("close", () => { if (close) close(); });
    });
  }

  return () => new Promise((resolve) => {
    let buf = "";
    let pos = 0;            // cursor index within buf
    let hist = -1;          // -1 = current (unsaved) line; else index into history
    let stash = "";         // holds the in-progress line while browsing history
    let pasting = false;    // inside a bracketed-paste burst
    let prevLines = 0;      // box height drawn last render (for clean repaint)
    const history = historyRef;
    const label = promptLabel();
    const labelLen = visLen(label) + 1;       // visible width of "❯ model "
    // Pastes/inputs above this size COLLAPSE to a one-line summary chip so the
    // box stays compact. The full text is still kept in `buf` and submitted; the
    // caret moves over the chip's visible characters so Left/Right still work.
    const COLLAPSE_CHARS = 1800;
    const isCollapsed = () => buf.length > COLLAPSE_CHARS;
    const summaryText = () => {
      const nl = (buf.match(/\n/g) || []).length + 1;
      return `[pasted ${buf.length.toLocaleString()} chars · ${nl} lines · Enter to send]`;
    };
    // In collapsed mode the caret position maps to a column over the summary
    // chip: pos 0 -> chip start, pos buf.length -> chip end (clamped between).
    const collapsedCol = () => {
      const s = summaryText();
      return labelLen + (pos <= 0 ? 0 : pos >= buf.length ? s.length : Math.round((pos / buf.length) * s.length));
    };

    // Wrap the buffer (which may contain \n) into display rows that fit the box
    // interior. When collapsed, return a single summary-chip row. The first row
    // is indented past the label. Returns { rows, curRow, curCol }.
    const layout = () => {
      const width = termWidth();
      const inner = Math.max(8, width - labelLen); // usable cols on row 0
      if (isCollapsed()) {
        const chip = color("chrome", summaryText());
        return { rows: [chip], curRow: 0, curCol: collapsedCol() };
      }
      // Build wrapped rows tracking where `pos` lands for the cursor.
      const rows = [];
      let cur = "";
      let curRow = 0, curCol = labelLen, seen = 0;
      const pushCol = (i) => { if (i === pos) { curRow = rows.length; curCol = (rows.length === 0 ? labelLen : 0) + cur.length; } };
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

    // Map a visual (row, desiredCol) back to a buffer index — for Up/Down within
    // multi-row input. Walks the buffer recording each row's [start,end) span the
    // same way layout() wraps, then clamps desiredCol into the target row.
    const posAtRow = (targetRow, desiredCol) => {
      const width = termWidth();
      const inner = Math.max(8, width - labelLen);
      const spans = [];                 // [{start, len}] per visual row
      let start = 0, len = 0, rowIdx = 0;
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
      // desiredCol is a screen column; row 0 is offset by the label.
      const colInRow = Math.max(0, desiredCol - (targetRow === 0 ? labelLen : 0));
      return span.start + Math.min(colInRow, span.len);
    };

    // Remember where the visible cursor sits after a paint so cursor-only moves
    // can reposition relative to it (no destructive repaint — that made the
    // caret look "stuck" in some terminals, e.g. VS Code's).
    let lastRow = 0, lastCol = labelLen, lastRows = 1;

    // Position the caret on (row, col) of the box using only widely-supported
    // moves: carriage-return to column 0, then forward by N. Absolute-column
    // (\x1b[NG) proved unreliable in some terminals (VS Code), leaving the
    // visible caret stuck even though the logical position was right.
    const placeCaret = (curRow, curCol) => {
      out.write("\r");                               // -> column 0 (always honored)
      if (curCol > 0) out.write(`\x1b[${curCol}C`);  // forward to the target column
    };

    const render = () => {
      const { rows, curRow, curCol } = layout();
      out.write("\x1b[?25l");                       // hide cursor
      if (prevLines > 0) out.write(`\x1b[${prevLines}A`); // back to box top
      out.write("\r\x1b[0J");                        // col 0 + clear from here down
      out.write(rule() + "\n");                     // top rule
      rows.forEach((r, i) => {
        out.write((i === 0 ? label + " " : "") + r + "\n");
      });
      out.write(rule());                            // bottom rule (no newline)
      prevLines = rows.length + 2;                  // rules + content rows
      // Cursor is on the bottom rule; go up onto the target content row.
      const upFromBottom = rows.length - curRow;
      out.write(`\x1b[${upFromBottom}A`);
      placeCaret(curRow, curCol);
      out.write("\x1b[?25h");                        // show cursor
      lastRow = curRow; lastCol = curCol; lastRows = rows.length;
    };

    // Reposition the visible caret to the current `pos` WITHOUT repainting the
    // box. Used for arrow/Home/End/word motion so the cursor visibly moves.
    const moveCaret = () => {
      const { rows, curRow, curCol } = layout();
      if (rows.length !== lastRows) return render(); // layout changed -> full paint
      const dRow = curRow - lastRow;
      if (dRow < 0) out.write(`\x1b[${-dRow}A`);
      else if (dRow > 0) out.write(`\x1b[${dRow}B`);
      placeCaret(curRow, curCol);
      lastRow = curRow; lastCol = curCol;
    };

    const finish = (result) => {
      stdin.removeListener("keypress", onKey);
      if (stdin.isRaw) stdin.setRawMode(false);
      out.write("\x1b[?2004l");                      // disable bracketed paste
      stdin.pause();
      // Cursor is somewhere inside the box; move it onto the bottom rule, then
      // a newline, so following output starts on a clean line below the box.
      const { rows, curRow } = layout();
      out.write(`\x1b[${rows.length - curRow}B\n`);  // rows after curRow + bottom rule
      resolve(result);
    };

    const insert = (s) => { buf = buf.slice(0, pos) + s + buf.slice(pos); pos += s.length; };

    // Word-boundary helpers for word-wise motion/deletion. A "word" is a run of
    // non-whitespace; we skip trailing whitespace first (shell/readline style).
    const prevWord = (i) => {
      let j = i;
      while (j > 0 && /\s/.test(buf[j - 1])) j--;
      while (j > 0 && !/\s/.test(buf[j - 1])) j--;
      return j;
    };
    const nextWord = (i) => {
      let j = i;
      while (j < buf.length && /\s/.test(buf[j])) j++;
      while (j < buf.length && !/\s/.test(buf[j])) j++;
      return j;
    };
    const deleteRange = (a, b) => { // remove [a,b), put cursor at a
      buf = buf.slice(0, a) + buf.slice(b); pos = a;
    };

    function onKey(str, key) {
      if (!key) return;
      const k = key.name;
      // Bracketed paste: terminal sends ESC[200~ … ESC[201~ around pasted text.
      // Inside a paste, treat everything (including newlines) as literal content
      // so a pasted snippet with line breaks doesn't submit early.
      if (key.code === "[200~" || str === "\x1b[200~") { pasting = true; return; }
      if (key.code === "[201~" || str === "\x1b[201~") { pasting = false; return render(); }
      if (pasting) {
        if (k === "return" || k === "enter") { insert("\n"); return; }
        if (str) { insert(str); }
        return; // defer render to the 201~ terminator (one repaint per paste)
      }

      if (key.ctrl && k === "c") {
        if (buf === "") return finish({ line: "", eof: true, sigint: true });
        buf = ""; pos = 0; hist = -1; return render();
      }
      if (key.ctrl && k === "d") {
        if (buf === "") return finish({ line: "", eof: true });
        // Ctrl-D with text: forward-delete one char (readline convention).
        if (pos < buf.length) deleteRange(pos, pos + 1);
        return render();
      }
      if (k === "return" || k === "enter") return finish({ line: buf, eof: false });

      // ── Deletion ──────────────────────────────────────────────────────────
      // Quick-delete the collapsed paste chip: any delete key removes the WHOLE
      // chip at once (deleting one char of a hidden blob would look like nothing
      // happened). Treats the [pasted …] chip as a single atomic unit.
      const DELETE_KEYS = ["backspace", "delete"];
      const isDeleteCombo = DELETE_KEYS.includes(k) ||
        (key.ctrl && (k === "w" || k === "u" || k === "k")) || (key.meta && k === "d");
      if (isCollapsed() && isDeleteCombo) { buf = ""; pos = 0; hist = -1; return render(); }

      if (k === "backspace") {
        // Alt/Option-Backspace -> delete the word before the cursor.
        if (key.meta) { if (pos > 0) deleteRange(prevWord(pos), pos); return render(); }
        if (pos > 0) deleteRange(pos - 1, pos);
        return render();
      }
      if (k === "delete") { if (pos < buf.length) deleteRange(pos, pos + 1); return render(); }
      if (key.ctrl && k === "w") { if (pos > 0) deleteRange(prevWord(pos), pos); return render(); } // delete word back
      if (key.meta && (k === "d")) { if (pos < buf.length) deleteRange(pos, nextWord(pos)); return render(); } // delete word fwd
      if (key.ctrl && k === "u") { if (pos > 0) deleteRange(0, pos); return render(); }           // delete to line start
      if (key.ctrl && k === "k") { if (pos < buf.length) deleteRange(pos, buf.length); return render(); } // delete to line end

      // Collapsed (chip) mode: a single char step is invisible on the summary,
      // so Left/Right snap the caret to the chip's start/end — the two useful
      // spots (insert before vs. after the paste).
      if (isCollapsed() && (k === "left" || k === "right")) {
        pos = k === "left" ? 0 : buf.length; return moveCaret();
      }

      // Cursor-only motion: reposition the caret WITHOUT repainting the box
      // (a full repaint per arrow press left the caret looking stuck).
      if (k === "left") { pos = key.meta ? prevWord(pos) : Math.max(0, pos - 1); return moveCaret(); }
      if (k === "right") { pos = key.meta ? nextWord(pos) : Math.min(buf.length, pos + 1); return moveCaret(); }
      if (k === "home" || (key.ctrl && k === "a")) { pos = 0; return moveCaret(); }
      if (k === "end" || (key.ctrl && k === "e")) { pos = buf.length; return moveCaret(); }
      if (k === "up") {
        // Multi-row input: move the caret up a visual row. On the top row (or
        // single-row input), fall back to recalling previous history.
        const { rows, curRow, curCol } = layout();
        if (rows.length > 1 && curRow > 0) { pos = posAtRow(curRow - 1, curCol); return moveCaret(); }
        if (history.length === 0) return;
        if (hist === -1) { stash = buf; hist = history.length; }
        if (hist > 0) hist--;
        buf = history[hist]; pos = buf.length; return render();
      }
      if (k === "down") {
        const { rows, curRow, curCol } = layout();
        if (rows.length > 1 && curRow < rows.length - 1) { pos = posAtRow(curRow + 1, curCol); return moveCaret(); }
        if (hist === -1) return;
        if (hist < history.length - 1) { hist++; buf = history[hist]; }
        else { hist = -1; buf = stash; }
        pos = buf.length; return render();
      }
      // Printable input (ignore other escape/control sequences).
      if (str && !key.ctrl && !key.meta && str >= " ") { insert(str); return render(); }
    }

    emitKeypressEvents(stdin);
    if (stdin.isRaw !== true) stdin.setRawMode(true);
    stdin.resume();
    out.write("\x1b[?2004h");                        // enable bracketed paste
    stdin.on("keypress", onKey);
    render();
  });
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
  "Be precise and actionable. You are NOT editing files — another tool (Claude Code) " +
  "will implement changes. Point out bugs, risks, and concrete recommendations.";

function help() {
  console.log(`
${color("bold", "vktech")} v${version()} — analyze with OpenAI / Gemini / xAI, implement with Claude Code

${color("bold", "USAGE")}
  vktech                              Start interactive REPL
  vktech ask --model <m> "<prompt>"  One-shot analysis with a provider
  vktech ask -i <img> "<prompt>"     Vision analysis (grok › claude › openai)
  vktech audit [template] [-d dir]   Run a saved audit template over a project
  vktech audit auto -d <dir>         Auto-detect industry, pick template+frameworks
  vktech audit <t> --all -d <dir>    Run ALL providers, consolidate for Claude
  vktech audit --list                List available audit templates
  vktech edit --config job.json      Automated video edit (probe→plan→dark-scan→caption→render)
  vktech edit -d <dir> -o <out.mp4>  Edit clips (--preset, --captions, --audio, --premiere, --dry-run)
  vktech identify <file>             Recognize music in an audio/video file (Shazam)
  vktech dns publish <sub> --ip <a>  Provision a Cloudflare subdomain (paid; VKTECH_LICENSE)
  vktech industries                  Show detectable industries + frameworks
  vktech code "<prompt>"             Hand off to Claude Code to implement
  vktech run                         Paste a JS snippet (Ctrl-D) → run with Node
  vktech sh                          Paste a shell snippet → run with bash
  vktech remote --host <h>           Paste a snippet → run on a host over SSH
  vktech providers                   Show configured providers / keys
  vktech --help                      This help
  vktech --version

${color("bold", "MODELS")} (for --model / -m — default priority: grok › claude › openai)
  ${color("cyan", "grok, xai")}       -> xAI         (${DEFAULTS.xai})        [default]
  ${color("cyan", "claude")}          -> Anthropic   (${DEFAULTS.anthropic})
  ${color("cyan", "gpt-5, openai")}   -> OpenAI      (${DEFAULTS.openai})
  ${color("cyan", "gemini, google")}  -> Gemini      (${DEFAULTS.gemini})
  You may also pass an explicit id, e.g. --model gpt-4o

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
  vktech code "Implement the fixes Grok suggested in src/order.js"

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
  /model <m>     switch active analysis provider
  /code <text>   hand the text to Claude Code
  /file <path>   load a file's contents into the next prompt
  /providers     list providers
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

function showProviders() {
  console.log(color("bold", "\nConfigured providers:\n"));
  // Listed in default priority order: grok › claude › openai › gemini.
  const rows = [
    ["xAI",       "XAI_API_KEY",       DEFAULTS.xai],
    ["Anthropic", "ANTHROPIC_API_KEY", DEFAULTS.anthropic],
    ["OpenAI",    "OPENAI_API_KEY",    DEFAULTS.openai],
    ["Gemini",    "GEMINI_API_KEY",    DEFAULTS.gemini],
  ];
  for (const [name, env, model] of rows) {
    const ok = !!process.env[env];
    const status = ok ? color("green", "✓ key set") : color("red", "✗ no key");
    console.log(`  ${name.padEnd(10)} ${status.padEnd(20)} ${color("dim", model)}`);
  }
  const claudeBin = process.env.CLAUDE_BIN || "claude";
  console.log(`\n  ${color("chrome", "Claude Code")} (implementation) via "${claudeBin}"`);
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
    console.log(text + "\n");
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
    console.log(text + "\n");
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
    console.log(text + "\n");
    saveReport(header, text);
  } catch (err) {
    console.error(color("red", `\nProvider error: ${err.message}\n`));
    process.exit(1);
  }
}

async function repl() {
  // Boot on the highest-priority configured analysis provider (default: grok).
  const _avail = availableProviders();
  let activeModel = _avail.length ? DEFAULTS[_avail[0]] : null;
  let pendingFile = "";
  console.log(banner([
    `${color("heading", "✦ vktech")} ${color("grey", "v" + version())} ${color("chrome", "— interactive analysis")}`,
    `${color("grey", "Type")} ${color("accent", "/help")} ${color("grey", "for commands,")} ${color("accent", "/exit")} ${color("grey", "to quit.")}`,
  ]));
  console.log(color("dim", `Active analysis model: `) + color("chrome", activeModel) + "\n");

  // Live violet input box drawn by a raw-mode reader: rule above the "❯" caret
  // line and rule below, both visible while typing (readline can't do this).
  const promptLabel = () => color("accent", "❯") + color("grey", ` ${activeModel}`);
  const history = [];
  const readBoxed = makeBoxedReader({ historyRef: history, promptLabel });

  const quit = () => {
    console.log(color("dim", "\nbye 👋"));
    process.exit(0);
  };

  // Main loop: read one boxed line, dispatch, repeat.
  for (;;) {
    const { line, eof } = await readBoxed();
    if (eof) return quit();
    const input = (line || "").trim();
    if (!input) continue;
    if (input !== history[history.length - 1]) history.push(input);

    if (input === "/exit" || input === "/quit") return quit();
    if (input === "/help") { help(); continue; }
    if (input === "/providers") { showProviders(); continue; }
    if (input.startsWith("/model")) {
      const m = input.split(/\s+/)[1];
      if (m && resolveProvider(m)) {
        activeModel = m;
        console.log(color("dim", `Active model -> ${activeModel}`));
      } else {
        console.log(color("red", `Unknown model "${m || ""}". Try grok, claude, gpt-5, gemini.`));
      }
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
      if (!text) {
        console.log(color("red", "Usage: /code <what Claude should implement>"));
        continue;
      }
      console.log(color("magenta", "\n→ Handing off to Claude Code…\n"));
      try {
        await runClaude(text);
      } catch (err) {
        console.error(color("red", err.message));
      }
      continue;
    }

    // Plain text -> analysis with active provider. Ctrl-C during the request
    // aborts the in-flight fetch. We can't rely on OS SIGINT (stdin spends the
    // request paused/raw), so we keep a minimal raw keypress watcher on stdin
    // that aborts the AbortController on Ctrl-C, plus a SIGINT fallback.
    const fullPrompt = pendingFile ? `${pendingFile}\n\n---\n\n${input}` : input;
    pendingFile = "";
    const spin = startSpinner(`querying ${activeModel}… (Ctrl-C to cancel)`);
    const t0 = Date.now();
    const ac = new AbortController();
    const cancel = () => { if (!ac.signal.aborted) ac.abort(new Error("cancelled")); };
    const tty = process.stdin.isTTY && process.stdout.isTTY && !NO_COLOR;
    const onWatchKey = (str, key) => { if (key && key.ctrl && key.name === "c") cancel(); };
    if (tty) {
      emitKeypressEvents(process.stdin);
      if (process.stdin.isRaw !== true) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onWatchKey);
    }
    process.once("SIGINT", cancel);
    try {
      const { provider, model, text } = await ask({
        modelArg: activeModel,
        prompt: fullPrompt,
        system: ANALYSIS_SYSTEM,
        signal: ac.signal,
      });
      spin.stop();
      console.log(color("cyan", `\n[${provider}:${model}]\n`));
      console.log(text + "\n");
      statusFooter({ provider, model, ms: Date.now() - t0, chars: text.length });
    } catch (err) {
      spin.stop();
      if (ac.signal.aborted) console.log(color("yellow", "\n✗ cancelled\n"));
      else console.error(color("red", `Provider error: ${err.message}`));
    } finally {
      process.removeListener("SIGINT", cancel);
      if (tty) {
        process.stdin.removeListener("keypress", onWatchKey);
        if (process.stdin.isRaw) process.stdin.setRawMode(false);
        process.stdin.pause();
      }
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

  if (cmd === "ask") {
    const { model, images, rest } = extractModel(argv.slice(1));
    if (images.length) return doAskVision(model, images, rest.join(" "));
    return doAsk(model, rest.join(" "));
  }

  if (cmd === "code") {
    const text = argv.slice(1).join(" ");
    if (!text) {
      console.error(color("red", "Usage: vktech code \"<what to implement>\""));
      process.exit(1);
    }
    console.log(color("magenta", "→ Handing off to Claude Code…\n"));
    const code = await runClaude(text);
    process.exit(code);
  }

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
