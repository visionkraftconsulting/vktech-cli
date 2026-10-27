// Memories saved by the other coding CLIs. Every vktech session gets a short
// index, and read_memory opens the full note. Bodies stay out of the prompt
// so a 16k Ollama context is not filled by every project the user has ever
// touched. Lines that look like credentials are redacted before they reach
// the model or the saved transcript.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

const BRIEF_CHARS = 6000;
const READ_CHARS = 8000;
let cache = { at: 0, entries: [] };

function home() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

export function redactText(text) {
  return String(text || "")
    .replace(/\b([A-Z0-9_]*(?:API_?KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_?KEY)[A-Z0-9_]*)\s*=\s*\S+/g, "$1=[redacted]")
    .replace(/(api[_-]?key|client[_-]?secret|secret|password|passwd|token|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted]");
}

// Claude's project folder is the absolute path with every non-alphanumeric
// character, including "/" and "_", replaced by "-".
export function encodePath(abs) {
  return String(abs || "").replace(/[^A-Za-z0-9]/g, "-");
}

function safeRead(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function roots() {
  const h = home();
  return [
    join(h, ".claude", "projects"),
    join(h, ".grok", "memory-v2"),
    join(h, ".grok", "memory"),
    join(h, ".codex", "memories"),
    join(h, ".codex", "memories_v2"),
    join(h, ".cursor"),
    join(h, "Library", "Application Support", "Cursor", "User"),
    join(h, ".config", "Cursor", "User"),
    join(h, ".gemini"),
  ].filter((dir) => existsSync(dir));
}

function allowed(file) {
  let real;
  try {
    real = realpathSync(file);
  } catch {
    return false;
  }
  return roots().some((root) => {
    let base;
    try {
      base = realpathSync(root);
    } catch {
      return false;
    }
    return real === base || real.startsWith(base + sep);
  });
}

function add(entries, row) {
  if (!row?.file || !existsSync(row.file)) return;
  entries.push({
    source: row.source,
    scope: row.scope || "",
    title: String(row.title || basename(row.file)).trim(),
    hint: String(row.hint || "").replace(/\s+/g, " ").trim(),
    file: row.file,
    kind: row.kind || "note",
    projectKey: row.projectKey || "",
  });
}

function parseClaudeIndex(file, memDir) {
  const found = [];
  for (const line of safeRead(file).split("\n")) {
    const match = line.match(/^- \[(.+?)\]\(([^)]+)\)\s*(?:—|–|-)\s*(.*)$/)
      || line.match(/^- \[(.+?)\]\(([^)]+)\)\s*$/);
    if (!match) continue;
    found.push({
      title: match[1],
      hint: match[3] || "",
      file: join(memDir, match[2]),
    });
  }
  return found;
}

function collectClaude(entries) {
  const projects = join(home(), ".claude", "projects");
  if (!existsSync(projects)) return;
  let names = [];
  try {
    names = readdirSync(projects);
  } catch {
    return;
  }
  for (const proj of names) {
    const mem = join(projects, proj, "memory");
    if (!existsSync(mem)) continue;
    const linked = new Set();
    for (const item of parseClaudeIndex(join(mem, "MEMORY.md"), mem)) {
      linked.add(basename(item.file));
      add(entries, { source: "claude", scope: proj, projectKey: proj, ...item });
    }
    let files = [];
    try {
      files = readdirSync(mem);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".md") || name === "MEMORY.md" || linked.has(name)) continue;
      add(entries, {
        source: "claude",
        scope: proj,
        projectKey: proj,
        title: name.replace(/\.md$/, "").replaceAll("-", " "),
        file: join(mem, name),
      });
    }
  }
}

function parseGrokIndex(file, dir) {
  const found = [];
  for (const line of safeRead(file).split("\n")) {
    const match = line.match(/^- \*\*(.+?)\*\*\s+\(`([^`]+)`\)/);
    if (!match) continue;
    found.push({ title: match[1], file: join(dir, match[2]) });
  }
  return found;
}

function collectDirNotes(entries, dir, source, scope, projectKey, linked) {
  if (!existsSync(dir)) return;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".md") || name === "MEMORY.md" || linked?.has(name)) continue;
    add(entries, {
      source,
      scope,
      projectKey,
      title: name.replace(/\.md$/, "").replaceAll("-", " "),
      file: join(dir, name),
    });
  }
}

function collectGrok(entries) {
  const root = join(home(), ".grok", "memory-v2");
  if (!existsSync(root)) return;
  const globalDir = join(root, "global");
  const globalLinked = new Set();
  for (const item of parseGrokIndex(join(globalDir, "MEMORY.md"), globalDir)) {
    globalLinked.add(basename(item.file));
    add(entries, { source: "grok", scope: "global", projectKey: "global", ...item });
  }
  collectDirNotes(entries, join(globalDir, "topics"), "grok", "global", "global", globalLinked);
  const workspaces = join(root, "workspaces");
  if (!existsSync(workspaces)) return;
  let scopes = [];
  try {
    scopes = readdirSync(workspaces);
  } catch {
    return;
  }
  for (const scope of scopes) {
    const dir = join(workspaces, scope);
    const linked = new Set();
    for (const item of parseGrokIndex(join(dir, "MEMORY.md"), dir)) {
      linked.add(basename(item.file));
      add(entries, { source: "grok", scope, projectKey: scope.toLowerCase(), ...item });
    }
    collectDirNotes(entries, join(dir, "topics"), "grok", scope, scope.toLowerCase(), linked);
  }
}

function collectCodex(entries) {
  const summary = join(home(), ".codex", "memories_v2", "memory_summary.md");
  add(entries, {
    source: "codex",
    scope: "global",
    projectKey: "global",
    title: "Codex memory summary",
    kind: "summary",
    file: summary,
  });
  add(entries, {
    source: "codex",
    scope: "global",
    projectKey: "global",
    title: "Codex raw memories",
    file: join(home(), ".codex", "memories", "raw_memories.md"),
  });
  for (const dir of [
    join(home(), ".codex", "memories", "rollout_summaries"),
    join(home(), ".codex", "memories_v2", "rollout_summaries"),
  ]) {
    collectDirNotes(entries, dir, "codex", "rollout", "", null);
  }
}

function walkLoose(dir, source, depth, entries, limit) {
  if (depth < 0 || entries.length >= limit || !existsSync(dir)) return;
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of names) {
    if (entries.length >= limit) return;
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "Cache" || ent.name === "logs") continue;
    const file = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "memory" || ent.name === "memories" || ent.name === "topics") {
        collectDirNotes(entries, file, source, ent.name, "", null);
      } else {
        walkLoose(file, source, depth - 1, entries, limit);
      }
    } else if (ent.isFile() && (ent.name === "MEMORY.md" || ent.name === "memory_summary.md")) {
      add(entries, { source, scope: basename(dir), title: `${source} memory`, file });
    }
  }
}

function collectLoose(entries) {
  const h = home();
  const before = entries.length;
  for (const dir of [
    join(h, ".cursor"),
    join(h, "Library", "Application Support", "Cursor", "User"),
    join(h, ".config", "Cursor", "User"),
    join(h, ".gemini"),
  ]) {
    walkLoose(dir, dir.includes("gemini") ? "gemini" : "cursor", 3, entries, before + 200);
  }
}

function catalog() {
  if (Date.now() - cache.at < 15000) return cache.entries;
  const entries = [];
  collectClaude(entries);
  collectGrok(entries);
  collectCodex(entries);
  collectLoose(entries);
  cache = { at: Date.now(), entries };
  return entries;
}

function score(entry, cwdKey, base) {
  let n = 10;
  if (entry.kind === "summary") n = 70;
  if (entry.source === "grok" && entry.scope === "global") n = Math.max(n, 60);
  if (entry.projectKey && cwdKey) {
    if (entry.projectKey === cwdKey) n = 100;
    else if (cwdKey.startsWith(`${entry.projectKey}-`)) {
      // A shorter remainder is a closer parent project.
      const rest = cwdKey.length - entry.projectKey.length;
      n = Math.max(n, 88 - Math.min(38, Math.floor(rest / 12)));
    } else if (entry.projectKey.startsWith(`${cwdKey}-`)) n = Math.max(n, 30);
  }
  if (base && entry.projectKey && entry.projectKey.startsWith(`${base.toLowerCase()}-`)) n = Math.max(n, 92);
  if (base && `${entry.title} ${entry.hint} ${entry.scope}`.toLowerCase().includes(base)) n += 5;
  return n;
}

function lineFor(entry) {
  const hint = entry.hint ? ` — ${entry.hint}` : "";
  return `- ${entry.title}${hint}`;
}

export function memoryBrief(cwd, maxChars = Number(process.env.VKTECH_MEMORY_CHARS || BRIEF_CHARS)) {
  const cap = Number.isFinite(maxChars) && maxChars > 500 ? maxChars : BRIEF_CHARS;
  let cwdKey = "";
  let base = "";
  try {
    if (cwd && existsSync(cwd)) {
      const real = realpathSync(cwd);
      cwdKey = encodePath(real);
      base = basename(real).toLowerCase();
    }
  } catch { /* brief still lists global memories */ }
  const ranked = catalog()
    .map((entry) => ({ ...entry, score: score(entry, cwdKey, base) }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const counts = {};
  for (const entry of ranked) counts[entry.source] = (counts[entry.source] || 0) + 1;
  const sources = Object.entries(counts).map(([name, n]) => `${name} ${n}`).join(", ") || "none found";
  const parts = [
    "CLI memories from Claude, Grok, Codex, Cursor, and Gemini apply in every session.",
    "Use them for prior decisions, deploys, and preferences. Call read_memory with a title to open the full note.",
    "The latest user message is the task. A memory is reference.",
    `Loaded: ${sources}.`,
  ];
  // Each CLI gets a slice, so one large project cannot hide the others.
  const budgets = { claude: 2400, grok: 1200, codex: 1500, cursor: 500, gemini: 400 };
  const seen = new Set();
  for (const source of ["claude", "grok", "codex", "cursor", "gemini"]) {
    let room = budgets[source] || 400;
    const group = ranked.filter((entry) => entry.source === source);
    for (const entry of group) {
      if (room < 40) break;
      if (entry.kind === "summary") {
        const body = redactText(safeRead(entry.file)).slice(0, Math.min(1400, room));
        const block = `\n## ${entry.source} · ${entry.title}\n${body}`;
        parts.push(block);
        room -= block.length;
        seen.add(entry.file);
        continue;
      }
      if (entry.score < 50 && seen.size > 0 && source !== "cursor" && source !== "gemini") break;
      const header = `\n## ${entry.source} · ${entry.scope}`;
      if (!parts.includes(header)) {
        parts.push(header);
        room -= header.length;
      }
      const line = lineFor(entry).slice(0, 220);
      parts.push(line);
      room -= line.length + 1;
      seen.add(entry.file);
    }
  }
  const rest = ranked.filter((entry) => !seen.has(entry.file));
  if (rest.length) {
    const sample = rest.slice(0, 12).map((entry) => `${entry.source}: ${entry.title}`).join("; ");
    parts.push(`\nAlso ${rest.length} other memories. Examples: ${sample}`);
  }
  return redactText(parts.join("\n")).slice(0, cap);
}

function sliceNote(text, query) {
  const clean = redactText(text);
  if (clean.length <= READ_CHARS) return clean;
  const needle = String(query || "").trim().toLowerCase();
  const lines = clean.split("\n");
  let start = 0;
  if (needle) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        start = Math.max(0, i - 2);
        break;
      }
    }
  }
  const slice = lines.slice(start).join("\n").slice(0, READ_CHARS);
  return `${slice}\n…[truncated]`;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "for", "to", "of", "and", "or", "in", "on", "at", "is", "it",
  "be", "do", "check", "please", "me", "my", "this", "that", "with", "from",
  "what", "when", "how", "can", "you", "your", "we", "our", "i", "vk", "vktech",
  "about", "into", "just", "not", "if", "so", "are", "was", "were", "been",
  "have", "has", "had", "will", "would", "should", "could", "also", "any", "all",
  "etc", "user", "prompt", "there", "then", "than", "them", "they", "their",
]);

// Words the prompt is actually about. "check for edit" → edit.
// "check for replies" → replies. Filler and the word "check" are dropped.
export function promptTerms(text) {
  const all = String(text || "");
  const parts = all.split(/\n---\n/);
  const focus = parts.length > 1 ? parts[parts.length - 1] : all.slice(-2000);
  const raw = focus.toLowerCase().match(/[a-z0-9][a-z0-9_+-]{2,}/g) || [];
  const terms = [];
  for (const word of raw) {
    if (word.length > 40 || STOP_WORDS.has(word)) continue;
    if (!terms.includes(word)) terms.push(word);
    if (terms.length >= 8) break;
  }
  return terms;
}

function termForms(term) {
  const forms = new Set([term]);
  if (term.length >= 5 && term.endsWith("ies")) forms.add(`${term.slice(0, -3)}y`);
  if (term.length >= 5 && term.endsWith("es")) forms.add(term.slice(0, -2));
  if (term.length >= 4 && term.endsWith("s")) forms.add(term.slice(0, -1));
  if (term.length >= 6 && term.endsWith("ing")) forms.add(term.slice(0, -3));
  if (term.length >= 5 && term.endsWith("ed")) forms.add(term.slice(0, -2));
  return [...forms].filter((form) => form.length >= 3 && !STOP_WORDS.has(form));
}

// "edit" matches "edited". "replies" matches "reply". "credit" does not match "edit".
function mentions(hay, term) {
  const text = String(hay || "").toLowerCase();
  return termForms(term).some((form) => {
    let from = 0;
    while (from <= text.length - form.length) {
      const at = text.indexOf(form, from);
      if (at < 0) return false;
      const before = at === 0 ? "" : text[at - 1];
      if (!before || !/[a-z0-9]/.test(before)) return true;
      from = at + form.length;
    }
    return false;
  });
}

function metaHits(entry, terms) {
  const blob = `${entry.title}\n${entry.hint}\n${basename(entry.file)}\n${entry.scope}`;
  return terms.filter((term) => mentions(blob, term));
}

function cwdBias(cwd) {
  let cwdKey = "";
  let base = "";
  try {
    if (cwd && existsSync(cwd)) {
      const real = realpathSync(cwd);
      cwdKey = encodePath(real);
      base = basename(real).toLowerCase();
    }
  } catch { /* search without a project bias */ }
  return { cwdKey, base };
}

/**
 * Search CLI memories for the words in this prompt.
 * @returns {{text:string, terms:string[], count:number}}
 */
export function memoriesForPrompt(prompt, cwd, maxChars = Number(process.env.VKTECH_MEMORY_HITS || 2800)) {
  const terms = promptTerms(prompt);
  if (!terms.length) return { text: "", terms, count: 0 };
  const cap = Number.isFinite(maxChars) && maxChars > 400 ? maxChars : 2800;
  const { cwdKey, base } = cwdBias(cwd);
  const pool = catalog()
    .map((entry) => ({
      ...entry,
      project: score(entry, cwdKey, base),
      hits: metaHits(entry, terms),
    }))
    .filter((entry) => entry.hits.length || entry.project >= 60)
    .sort((a, b) => (b.hits.length - a.hits.length) || (b.project - a.project) || a.title.localeCompare(b.title));
  const found = [];
  let reads = 0;
  for (const entry of pool) {
    if (found.length >= 3 && !entry.hits.length) break;
    if (reads >= 80 && !entry.hits.length) break;
    if (!allowed(entry.file)) continue;
    reads += 1;
    const body = safeRead(entry.file);
    const bodyHits = terms.filter((term) => mentions(body, term));
    const hits = [...new Set([...entry.hits, ...bodyHits])];
    if (!hits.length) continue;
    found.push({ ...entry, hits, body });
    if (found.length >= 8) break;
  }
  found.sort((a, b) => (b.hits.length - a.hits.length) || (b.project - a.project));
  const top = found.slice(0, 3);
  const listed = terms.join(", ");
  if (!top.length) {
    const text = `CLI memories checked for: ${listed}. No saved note mentions those words.`;
    return { text, terms, count: 0 };
  }
  const blocks = top.map((entry) => {
    const excerpt = sliceNote(entry.body, entry.hits[0]).slice(0, 800);
    return `## ${entry.source} · ${entry.title}\n${excerpt}`;
  });
  let text = [
    `CLI memories checked for: ${listed}. Reference only. The user request below is the task.`,
    ...blocks,
  ].join("\n\n");
  text = redactText(text);
  if (text.length > cap) text = `${text.slice(0, cap)}\n…[truncated]`;
  return { text, terms, count: top.length };
}

export function readMemory(query, cwd) {
  const q = String(query || "").trim();
  if (!q) return memoryBrief(cwd);
  if (q.startsWith("/") || q.startsWith("~")) {
    const file = q.startsWith("~") ? join(home(), q.slice(1)) : q;
    if (!allowed(file)) return "refused: that path is outside CLI memory folders.";
    if (!existsSync(file)) return "no memory at that path";
    return `${file}\n${sliceNote(safeRead(file), "")}`;
  }
  let cwdKey = "";
  let base = "";
  try {
    if (cwd && existsSync(cwd)) {
      const real = realpathSync(cwd);
      cwdKey = encodePath(real);
      base = basename(real).toLowerCase();
    }
  } catch { /* search without a cwd bias */ }
  const needle = q.toLowerCase();
  const hits = catalog()
    .map((entry) => {
      const title = entry.title.toLowerCase();
      const fileName = basename(entry.file).toLowerCase();
      let match = 0;
      if (title === needle || fileName === needle || fileName === `${needle}.md`) match = 100;
      else if (title.includes(needle) || fileName.includes(needle)) match = 70;
      else if (`${entry.hint} ${entry.scope}`.toLowerCase().includes(needle)) match = 40;
      if (!match) return null;
      return { ...entry, match: match + score(entry, cwdKey, base) / 10 };
    })
    .filter(Boolean)
    .sort((a, b) => b.match - a.match);
  if (!hits.length) return `no memory matching: ${q}`;
  const best = hits[0];
  if (!allowed(best.file)) return "refused: that memory is outside the CLI memory folders.";
  const also = hits.slice(1, 6).map((entry) => `${entry.source}: ${entry.title}`);
  const extra = also.length ? `\n\nAlso matched:\n${also.map((line) => `- ${line}`).join("\n")}` : "";
  return redactText(`${best.source} · ${best.scope}\n${best.file}\n\n${sliceNote(safeRead(best.file), q)}${extra}`);
}
