// Markdown → ANSI for replies, in the vktech theme, with status colour-coding:
// good news green, open/waiting items yellow, blockers and failures red.
// Streams line by line (a partial line waits for its newline), so a reply
// still prints as the model writes it.
import { C, NO_COLOR } from "./theme.js";

// Colour only a real terminal (or FORCE_COLOR). Piped output stays plain
// Markdown so logs, sessions and grep see exactly what the model wrote.
export function colorEnabled(stream = process.stdout) {
  if (NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(stream?.isTTY);
}

const FG_OFF = "\x1b[39m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const ITALIC = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";
const fg = (name, s) => `${C[name]}${s}${FG_OFF}`;

// Status vocabulary. Order matters: a line with any red word is red.
const BAD = /❌|✗|🔴|\b(?:blocked|blocking|blocker|failed|fails?|failure|errors?|rejected|denied|expired|lapsed|missing|could ?not|cannot|can't|not sent|never sent|broken|crash(?:ed|es)?|down|still closed|(?:end[_ ]date|date|deadline) (?:has )?passed|end_date_passed=1|not (?:yet )?(?:confirmed|approved|sent|received|reachable)|no (?:written )?confirmation|unreachable|refused|overdue|missed|500|401|403)\b/gi;
const WARN = /⚠️?|🟡|\b(?:open|pending|at risk|flag(?:ged)?|stale|caveat|warning|waiting|awaiting|waits? (?:on|for)|still (?:needs|waits)|on hold|not yet|unverified|unconfirmed|unknown|may need(?: an? (?:answer|reply))?|needs? (?:a |an |your )?(?:reply|answer|review|ok|approval|attention)|follow[ -]?up|deadline|todo|untested)\b/gi;
const GOOD = /✅|✓|🟢|(?<!\b(?:not|no|never|un|yet) )\b(?:healthy|confirmed|approved|deployed|done|resolved|passed|passing|accepted|succeeded|success(?:ful)?|working|fixed|complete(?:d)?|on schedule|no change|nothing new|verified|OK)\b/g;

export function severity(text) {
  // "Nothing is open / blocked", "None.", "Open PRs: 0" report an absence.
  const t = String(text || "").replace(/\*\*/g, "");
  if (/^\s*(?:nothing|none|no (?:open|new|pending|blockers?))\b/i.test(t)) return null;
  if (/\b(?:open|pending|blocked|failed|failing)\b[^.:\n]{0,30}:\s*0\b/i.test(t) && !/[1-9]\d* (?:open|pending|blocked|failed)/i.test(t)) return null;
  // Worst status word wins, with the same negation rules as the colouring.
  let worst = null;
  for (const m of String(text || "").matchAll(STATUS)) {
    const g = m.groups;
    if (g.good && /^ok$/i.test(m[0]) && m[0] !== "OK") continue;
    const tone = g.bad ? "red" : g.warn ? "yellow" : "green";
    if (tone === "red") return "red";
    if (tone === "yellow" || !worst) worst = tone;
  }
  return worst;
}

// One pass over the original text, so a negation ("not confirmed", "no
// blockers", "nothing flagged") is seen before anything is coloured.
const NEG = "(?<!\\b(?:not|no|nothing|never|un|yet|without) )";
const STATUS = new RegExp(
  `${NEG}(?<bad>${BAD.source})|${NEG}(?<warn>${WARN.source})|${NEG}(?<good>${GOOD.source})`, "gi");
function paintStatus(s) {
  return s.replace(STATUS, (m, ...rest) => {
    const g = rest[rest.length - 1];
    if (g.good && /^ok$/i.test(m) && m !== "OK") return m;
    return fg(g.bad ? "red" : g.warn ? "yellow" : "green", m);
  });
}

// Inline Markdown for one line: `code`, **bold**, *italic*, [text](url).
// Code spans become placeholders first, so bold can wrap them and nothing
// inside them is restyled.
export function inline(text, { lead = null } = {}) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `${t} \u0001${u}\u0001`);
  // Split into bold and plain runs; style each run once.
  const runs = s.split(/(\*\*[^*]+\*\*)/);
  let first = true;
  s = runs.map((run) => {
    if (/^\*\*[^*]+\*\*$/.test(run)) {
      const body = run.slice(2, -2);
      // A bold lead ("**Watcher:** ...") takes the line's status colour.
      const tone = first && lead ? lead : null;
      first = false;
      if (!tone) return `${BOLD}${paintStatus(body)}${BOLD_OFF}`;
      // Code inside a coloured lead: switch to the code colour and back.
      const inner = body.replace(/\u0000(\d+)\u0000/g, (_, i) => `${C.chrome}${codes[Number(i)]}${C[tone]}`);
      return `${BOLD}${C[tone]}${inner}${FG_OFF}${BOLD_OFF}`;
    }
    if (run.trim()) first = false;
    let r = run.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, (_, pre, i) => `${pre}${ITALIC}${i}${ITALIC_OFF}`);
    return paintStatus(r);
  }).join("");
  // Restore code spans (and link URLs) in their own colours. Inside bold the
  // colour change must not drop the bold, so only the foreground is reset.
  return s
    .replace(/\u0000(\d+)\u0000/g, (_, i) => fg("chrome", codes[Number(i)]))
    .replace(/\u0001([^\u0001]+)\u0001/g, (_, u) => fg("grey", `(${u})`));
}

const MARKS = { red: "✗", yellow: "!", green: "✓" };

function renderLine(line, state, width) {
  // Fenced code: passed through in the code colour, untouched.
  const fence = line.match(/^(\s*)(```|~~~)/);
  if (fence) {
    state.code = !state.code;
    return fg("grey", line);
  }
  if (state.code) return fg("chrome", line);

  if (/^\s*$/.test(line)) return line;
  // Rules: --- / *** / ___
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return fg("grey", "─".repeat(Math.max(8, Math.min(width - 1, 80))));
  // Headings.
  const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
  if (h) {
    const tone = severity(h[2]);
    const level = h[1].length;
    const body = h[2].replace(/\*\*/g, "");
    const head = `${BOLD}${C[tone || (level <= 2 ? "accent" : "heading")]}${body}${FG_OFF}${BOLD_OFF}`;
    return level <= 2 ? `${head}` : head;
  }
  // Tables: grey pipes, separator row dimmed, each cell styled on its own.
  if (/^\s*\|.*\|\s*$/.test(line)) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return fg("grey", line.replace(/-/g, "─").replace(/\|/g, "│"));
    const cells = line.trim().slice(1, -1).split("|");
    const pipe = fg("grey", "│");
    return `${pipe}${cells.map((c) => inline(c)).join(pipe)}${pipe}`;
  }
  // Blockquote.
  const q = line.match(/^(\s*)>\s?(.*)$/);
  if (q) return `${q[1]}${fg("grey", "▌")} ${ITALIC}${inline(q[2])}${ITALIC_OFF}`;
  // Bullets and numbered items: the marker carries the line's status.
  const b = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  if (b) {
    const tone = severity(b[3]);
    const numbered = /\d/.test(b[2]);
    const mark = numbered ? b[2] : (tone ? MARKS[tone] : "•");
    return `${b[1]}${fg(tone || "accent", mark)} ${inline(b[3], { lead: tone })}`;
  }
  // A paragraph that opens with a bold sentence is the summary line.
  const tone = /^\s*\*\*/.test(line) ? severity(line.replace(/`[^`]*`/g, "")) : null;
  return inline(line, { lead: tone });
}

export function renderMarkdown(text, { color = colorEnabled(), width = process.stdout.columns || 100 } = {}) {
  if (!color) return String(text ?? "");
  const state = { code: false };
  return String(text ?? "").split("\n").map((l) => renderLine(l, state, width)).join("\n");
}

// Streaming renderer: push() model deltas, flush() at the end of a message.
export function createMarkdownStream(write, { color = colorEnabled() } = {}) {
  if (!color) return { push: (s) => s && write(s), flush() {} };
  const state = { code: false };
  let buf = "";
  const width = () => process.stdout.columns || 100;
  return {
    push(chunk) {
      buf += String(chunk ?? "");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        write(`${renderLine(buf.slice(0, i), state, width())}\n`);
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (buf) write(renderLine(buf, state, width()));
      buf = "";
    },
  };
}
