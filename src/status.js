// Built-in progress check for ANY repo: "status", "progress", "catch me up",
// "what did claude work on last", "check on <topic>". Gathers, read-only:
//   - git + GitHub: branch, uncommitted work, recent commits, open/merged PRs
//   - Claude's memory for this repo (newest notes, or notes on the topic)
//   - the last Claude Code sessions run here: title, what was asked, files
//     touched, commits/PRs/deploys, and the final summary it wrote
//   - prod health for the repo's known URLs
// The local model then writes the report from those facts.
import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { encodePath, readMemory, redactText } from "./memories.js";

const GENERAL = /^\s*(?:(?:give me (?:a |the )?)?(?:status|progress|recap|summary)(?: (?:report|update|check))?|where are we(?: at)?|what'?s (?:the )?(?:status|progress|next|left|outstanding)|catch me up|what (?:did|has) (?:claude|you|codex) (?:work(?:ed)? on|do(?:ne)?|been doing)(?: last| lately| recently)?|what was (?:claude|i|codex) (?:working on|doing)(?: last)?|(?:check|show) (?:the )?(?:status|progress))\s*(?:of|on|for|in)?\s*(?:this|the)?\s*(?:repo|project|app)?\s*[?.!]*\s*$/i;
const TOPIC = /^\s*(?:check on|status (?:of|on)|progress (?:of|on)|follow[\s-]*up on|update on|what'?s (?:new|up) with|where are we (?:on|with))\s+(?:the\s+)?(.{2,60}?)\s*[?.!]*\s*$/i;

export function statusIntent(prompt) {
  const p = String(prompt || "");
  if (GENERAL.test(p)) return { topic: null };
  const m = p.match(TOPIC);
  if (!m) return null;
  const topic = m[1].trim();
  // A real topic is a few words, not a coding instruction ("check on the bug in x.js and fix it").
  if (topic.split(/\s+/).length > 5 || /\.(?:js|ts|tsx|py|md|json)\b|\bfix\b/i.test(topic)) return null;
  if (/^(?:status|progress|this repo|the repo|things)$/i.test(topic)) return { topic: null };
  return { topic };
}

function sh(cmd, args, cwd, timeout = 15_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout).trim());
    });
  });
}

// ── git + GitHub ─────────────────────────────────────────────────────────────
async function gitFacts(root) {
  const [branch, ahead, dirty, log, branches, worktrees] = await Promise.all([
    sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], root),
    sh("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], root),
    sh("git", ["status", "--porcelain"], root),
    sh("git", ["log", "-8", "--date=short", "--format=%h %ad %s"], root),
    sh("git", ["for-each-ref", "--sort=-committerdate", "--count=6", "--format=%(refname:short) %(committerdate:short)", "refs/heads"], root),
    sh("git", ["worktree", "list"], root),
  ]);
  if (!branch) return "== GIT\n(not a git repo)";
  const [a, b] = (ahead || "").split(/\s+/);
  const dirtyLines = dirty ? dirty.split("\n") : [];
  const lines = [
    "== GIT",
    `branch ${branch}${ahead ? ` · ${a} ahead / ${b} behind upstream` : " · no upstream"}`,
    `uncommitted: ${dirtyLines.length} file(s)${dirtyLines.length ? ` — ${dirtyLines.slice(0, 8).map((l) => l.trim()).join(", ")}${dirtyLines.length > 8 ? ", …" : ""}` : ""}`,
    "recent commits:", ...log.split("\n").filter(Boolean).map((l) => `  ${l}`),
    "recent branches:", ...branches.split("\n").filter(Boolean).map((l) => `  ${l}`),
  ];
  const wt = worktrees.split("\n").filter(Boolean);
  if (wt.length > 1) lines.push(`extra worktrees: ${wt.length - 1}`, ...wt.slice(1).map((l) => `  ${l}`));
  return lines.join("\n");
}

async function prFacts(root) {
  const [open, merged, issues] = await Promise.all([
    sh("gh", ["pr", "list", "--limit", "8", "--json", "number,title,headRefName,updatedAt,isDraft"], root),
    sh("gh", ["pr", "list", "--state", "merged", "--limit", "6", "--json", "number,title,mergedAt"], root),
    sh("gh", ["issue", "list", "--limit", "6", "--json", "number,title,updatedAt"], root),
  ]);
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const o = parse(open);
  const m = parse(merged);
  if (!o && !m) return "== PULL REQUESTS\n(gh unavailable or no GitHub remote)";
  const lines = ["== PULL REQUESTS", `open: ${o?.length || 0}`];
  for (const pr of (o || []).slice(0, 6)) lines.push(`  #${pr.number} ${pr.isDraft ? "[draft] " : ""}${pr.title} (${pr.headRefName}, updated ${String(pr.updatedAt).slice(0, 10)})`);
  if ((o || []).length > 6) lines.push(`  … ${o.length - 6} more`);
  const iss = parse(issues);
  if (iss) {
    lines.push(`open issues: ${iss.length}${iss.length === 6 ? "+" : ""}`);
    for (const i of iss) lines.push(`  #${i.number} ${i.title} (updated ${String(i.updatedAt).slice(0, 10)})`);
  }
  lines.push("recently merged:");
  for (const pr of (m || []).slice(0, 5)) lines.push(`  #${pr.number} ${pr.title} (merged ${String(pr.mergedAt).slice(0, 10)})`);
  return lines.join("\n");
}

// ── Claude memory + sessions ─────────────────────────────────────────────────
function projectDirs(root, cwd) {
  const base = join(homedir(), ".claude", "projects");
  return [...new Set([root, cwd])].map((p) => join(base, encodePath(p))).filter((d) => existsSync(d));
}

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const get = (k) => (m?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1] || "").replace(/^["']|["']$/g, "");
  return { name: get("name"), description: get("description") };
}

function memoryFacts(dirs, topic, root) {
  const files = [];
  for (const d of dirs) {
    const md = join(d, "memory");
    if (!existsSync(md)) continue;
    for (const f of readdirSync(md)) {
      if (!f.endsWith(".md") || f === "MEMORY.md") continue;
      const p = join(md, f);
      try { files.push({ p, f, mtime: statSync(p).mtimeMs }); } catch { /* skip */ }
    }
  }
  if (!files.length) return "== CLAUDE MEMORY\n(no Claude memory for this repo)";
  files.sort((a, b) => b.mtime - a.mtime);
  const lines = ["== CLAUDE MEMORY (newest notes first)"];
  for (const { p, f, mtime } of files.slice(0, 6)) {
    const fm = frontmatter(readFileSync(p, "utf8"));
    lines.push(`- ${new Date(mtime).toISOString().slice(0, 10)} ${fm.name || f}: ${(fm.description || "").slice(0, 130)}`);
  }
  // The newest note's own latest section is usually the current state.
  const newest = readFileSync(files[0].p, "utf8");
  const tail = newest.split(/\n(?=## )/).pop().trim().slice(0, 700);
  lines.push(`newest note (${files[0].f}), latest section:`, tail);
  if (topic) {
    lines.push(`notes on "${topic}":`, String(readMemory(topic, root)).slice(0, 1600));
  }
  return lines.join("\n");
}

// Read only the end of a session log: they reach hundreds of MB.
function readTail(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return size > len ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
}

function summarizeSession(path, root) {
  const out = { title: "", agent: "", prompts: [], files: new Set(), actions: [], prs: new Map(), last: "", first: "", end: "" };
  for (const line of readTail(path, 8 * 1024 * 1024).split("\n")) {
    if (!line || line.length > 400_000) continue;
    if (!/"type":"(?:user|assistant|ai-title|agent-name|pr-link)"/.test(line)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.timestamp) { out.first ||= o.timestamp; out.end = o.timestamp; }
    if (o.type === "ai-title") out.title = o.aiTitle || out.title;
    else if (o.type === "agent-name") out.agent = o.agentName || out.agent;
    else if (o.type === "pr-link") out.prs.set(o.prUrl, `#${o.prNumber} ${o.prRepository || ""}`.trim());
    else if (o.type === "user") {
      const human = o.origin?.kind === "human" || o.promptSource === "typed";
      const t = textOf(o.message?.content);
      if (human && t && !t.startsWith("<")) out.prompts.push(t.replace(/\s+/g, " ").slice(0, 200));
    } else if (o.type === "assistant") {
      for (const c of o.message?.content || []) {
        if (c?.type === "text" && c.text?.trim()) out.last = c.text;
        if (c?.type !== "tool_use") continue;
        const fp = c.input?.file_path;
        // Scratch and temp files are not project work.
        if (fp && /^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && !/^\/(?:private\/)?(?:tmp|var\/folders)\/|\/\.claude\//.test(fp)) out.files.add(fp.startsWith(root) ? relative(root, fp) : fp.replace(homedir(), "~"));
        const cmd = c.name === "Bash" ? String(c.input?.command || "") : "";
        const hit = cmd.match(/(git commit[^\n]{0,90}|gh pr (?:create|merge)[^\n]{0,70}|[\w./-]*deploy[\w.-]*\.sh[^\n]{0,40}|aws ssm send-command[^\n]{0,30})/);
        if (hit) out.actions.push(hit[1].replace(/\s+/g, " "));
      }
    }
  }
  return out;
}

function sessionFacts(dirs, root, topic) {
  const logs = [];
  for (const d of dirs) {
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(d, f);
      try { logs.push({ p, mtime: statSync(p).mtimeMs }); } catch { /* skip */ }
    }
  }
  if (!logs.length) return "== LAST CLAUDE CODE SESSIONS\n(none recorded for this repo)";
  logs.sort((a, b) => b.mtime - a.mtime);
  const lines = ["== LAST CLAUDE CODE SESSIONS IN THIS REPO (newest first; the newest may be the one running now)"];
  const words = topic ? topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2) : [];
  let shown = 0;
  for (const { p, mtime } of logs.slice(0, 8)) {
    if (shown >= 3) break;
    const s = summarizeSession(p, root);
    if (!s.prompts.length && !s.last) continue;
    if (words.length && shown > 0) {
      const hay = `${s.title} ${s.prompts.join(" ")} ${s.last}`.toLowerCase();
      if (!words.some((w) => hay.includes(w))) continue;
    }
    shown += 1;
    // Older sessions get one line; the two newest get the detail.
    if (shown === 3) {
      lines.push(`--- earlier session "${s.title || "untitled"}" · last active ${new Date(mtime).toISOString().slice(0, 10)} · last ask: ${s.prompts.slice(-1)[0] || "?"}`);
      continue;
    }
    lines.push(`--- session "${s.title || "untitled"}"${s.agent ? ` (${s.agent})` : ""} · last active ${new Date(mtime).toISOString().slice(0, 16)}Z`);
    lines.push("asked (latest last):", ...s.prompts.slice(-5).map((t) => `  > ${t}`));
    if (s.files.size) lines.push(`files edited: ${[...s.files].slice(-10).join(", ")}`);
    if (s.actions.length) lines.push("commits / PRs / deploys:", ...[...new Set(s.actions)].slice(-5).map((a) => `  ${a.slice(0, 100)}`));
    if (s.prs.size) lines.push(`PR links: ${[...s.prs.values()].slice(-5).join(", ")}`);
    if (s.last) {
      // Open items ("still waits on…", "next:") sit at the END of a summary.
      const t = s.last.trim();
      const cap = shown === 1 ? 1300 : 600;
      lines.push("its final message:", t.length <= cap ? t : `${t.slice(0, Math.floor(cap * 0.4))}\n[…]\n${t.slice(-Math.ceil(cap * 0.6))}`);
    }
  }
  return lines.join("\n");
}

// ── prod health ──────────────────────────────────────────────────────────────
// Known prod front doors. Override or add per repo with .vktech/status.json
// {"urls": ["https://..."]}.
const KNOWN_URLS = {
  vkworkforce: ["https://workforce.vktech.ai/"],
  sgabackstop: ["https://backstop.vktech.ai/"],
  vkpay: ["https://pay.vktech.ai/"],
  vktech: ["https://vktech.ai/", "https://auth.vktech.ai/"],
  sgastructure: ["https://structure.sgatrader.com/"],
  sgastructurecrypto: ["https://crypto.sgatrader.com/"],
};

function prodUrls(root, memoryText) {
  try {
    const cfg = JSON.parse(readFileSync(join(root, ".vktech", "status.json"), "utf8"));
    if (Array.isArray(cfg.urls) && cfg.urls.length) return cfg.urls;
  } catch { /* no override */ }
  const known = KNOWN_URLS[basename(root).toLowerCase()];
  if (known) return known;
  // Otherwise the domain this repo's memory mentions most.
  const counts = {};
  for (const m of memoryText.matchAll(/https?:\/\/([a-z0-9-]+\.)+(?:vktech\.ai|sgatrader\.com)/gi)) {
    const host = new URL(m[0]).host;
    counts[host] = (counts[host] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => `https://${h}/`);
}

async function prodFacts(urls) {
  if (!urls.length) return "== PROD\n(no known prod URL for this repo; add .vktech/status.json {\"urls\": [...]})";
  const rows = await Promise.all(urls.map(async (u) => {
    const t0 = Date.now();
    try {
      const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      return `${u} → HTTP ${res.status} in ${Date.now() - t0} ms`;
    } catch (err) {
      return `${u} → DOWN (${err.cause?.code || err.name || err.message})`;
    }
  }));
  return ["== PROD (HTTPS from this Mac; 2xx/3xx/401 = up)", ...rows].join("\n");
}

export async function gatherStatus({ cwd, topic = null } = {}) {
  const root = (await sh("git", ["rev-parse", "--show-toplevel"], cwd)) || cwd;
  const dirs = projectDirs(root, cwd);
  const memory = memoryFacts(dirs, topic, root);
  const [git, prs, prod] = await Promise.all([gitFacts(root), prFacts(root), prodFacts(prodUrls(root, memory))]);
  const sessions = sessionFacts(dirs, root, topic);
  const head = `== REPO ${basename(root)} (${root.replace(homedir(), "~")}) · gathered ${new Date().toISOString().slice(0, 16)}Z${topic ? ` · topic "${topic}"` : ""}`;
  return redactText([head, git, prs, prod, sessions, memory].join("\n\n"));
}

export const STATUS_BRIEF = [
  "The facts below were just gathered READ-ONLY from this repo (git, GitHub PRs), Claude's memory for it, the last Claude Code sessions run here, and prod HTTPS health.",
  "Write a progress report. Lead with one or two sentences: where the project stands and what Claude worked on last.",
  "Then short sections: **Last worked on** (the newest session that is not this status check: its title, what was asked, what it changed, and what its final message says was done or left open), **Current state** (branch, uncommitted files, open PRs, prod up or down), **Open / next** (only items the facts name as open, pending, blocked, TODO or next).",
  "If a topic was given, focus on it. Times are UTC. Quote PR numbers, file names and dates exactly.",
  "Report only what the facts show; if something was not gathered, say so. Do not change anything.",
].join(" ");
