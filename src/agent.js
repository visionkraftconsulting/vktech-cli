// Local coding agent. Talks to Ollama on the rtx5090 (native /api/chat + tools)
// and edits the working tree. The REPL uses this for plain text on `local`.
// `vktech code` is the one-shot. `--claude` still shells out to Claude Code.
//
// Context joins whatever runner is already hot (see localNumCtx). A different
// num_ctx reloads qwen3.8:27b and stalls sgaBackstop's live agent. The server
// default stays 8192 for the smaller fleet models. Do not raise
// OLLAMA_CONTEXT_LENGTH — KV is reserved up front as ctx * NUM_PARALLEL.

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { DEFAULTS, LOCAL_URL, localKeepAlive, localNumCtx, localTextOptions } from "./providers.js";
import { memoryBrief, memoriesForPrompt, readMemory, redactText } from "./memories.js";
import { checkReplies, isReplyCheck, replyFocus } from "./replies.js";
import { fetchWebText, searchResults } from "./search.js";
import { defaultSsmHost, formatSsmResult, ssmHosts, ssmRun } from "./ssm.js";
import { loadChecks } from "./checks.js";
import { STATUS_BRIEF, gatherStatus, statusIntent } from "./status.js";
import { createMarkdownStream } from "./render.js";

const TOOL_RESULT_CHARS = 12_000;
const READ_LINES = 400;
const MAX_WRITE_CHARS = 200_000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "aws_ssm",
      description: "Run a bash script as root on an AWS box through SSM and return its output. This machine has SSM access (VKTECH_AWS_PROFILE / VKTECH_AWS_REGION). Read freely; anything that changes prod (restarts, DB writes, deploys, sending mail) needs the user's OK first.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: `Box name or instance id. Configured: ${Object.keys(ssmHosts()).join(", ") || "none (~/.config/vktech/ssm-hosts.json)"}. Default: the first one.` },
          script: { type: "string", description: "Bash script to run on the box. To run an app's own code, run it as that app's service user with its env file (CLAUDE.md names them), e.g. systemd-run --quiet --uid=<user> -p EnvironmentFile=<env> --working-directory=<dir> --pipe --wait node <file>." },
        },
        required: ["script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories at a path inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory relative to the workspace. Omit for the root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file inside the workspace. Use offset and limit for large files. The bytes are exact — copy them into edit_file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", description: "1-based start line. Default 1." },
          limit: { type: "integer", description: "Max lines. Default 400." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents under the workspace. Respects .gitignore.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "File or directory to search. Omit to search the workspace." },
          glob: { type: "string", description: "Optional ripgrep glob, for example *.js" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace one exact occurrence of old_string with new_string in a workspace file. old_string must match the file bytes, including whitespace, and must be unique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file inside the workspace with the full contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run",
      description: "Run a shell command with the workspace as the working directory. Use it for tests, typechecks, and short inspections.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the live web. Use this whenever the user asks to browse, look something up, or needs current information. Returns titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Open one http or https page and return its text. Use it after web_search when a snippet is not enough.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rtx_status",
      description: "Check the RTX 5090 Ollama box this agent is already running on. Reports whether it is reachable, which models are loaded, their context length, and how much of each model is on the GPU.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_memory",
      description: "Read one memory saved by Claude, Grok, Codex, Cursor, or Gemini. A search of those notes is already attached to the latest user request. Call this to open a title that search did not include.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Title, filename, or memory-folder path." },
        },
        required: ["query"],
      },
    },
  },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

// Commands that would wreck the machine. Returned to the model as a tool
// error so it can pick a different command. Everything else runs.
const BLOCKED_SHELL = [
  // rm of the filesystem root only (`rm -rf /`, `rm -rf /*`). A path like
  // `rm -rf /tmp/build` is a normal cleanup and is allowed.
  /\brm\s+(?:-[^\s]+\s+)*\/(\s|$|\*)/,
  /\bmkfs(\.\w+)?\b/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\bdd\b[^;&|\n]*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
];

export function blockedShellCommand(command) {
  const cmd = String(command || "");
  return BLOCKED_SHELL.some((re) => re.test(cmd));
}

function staysInside(base, real, p) {
  const rel = relative(base, real);
  // `relative` yields "" for the root itself and "../…" once a path leaves it.
  // A name like "..keep" stays allowed: only ".." and "../…" escape.
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${p}`);
  }
  return real;
}

// Resolve `p` and require the real path to stay inside `root`. Symlinks are
// followed, so a link that points outside the workspace is rejected. With
// allowMissing, a new file is accepted when its nearest existing parent is
// inside the workspace.
export function resolveInside(root, p, allowMissing = false) {
  const base = realpathSync(root);
  const abs = resolve(base, p || ".");
  if (existsSync(abs)) return staysInside(base, realpathSync(abs), p);
  let parent = dirname(abs);
  const tail = [basename(abs)];
  while (!existsSync(parent)) {
    if (!allowMissing) break;
    tail.push(basename(parent));
    const next = dirname(parent);
    if (next === parent) throw new Error(`path escapes the workspace: ${p}`);
    parent = next;
  }
  if (!existsSync(parent)) {
    const err = new Error(`not found: ${p}`);
    err.code = "ENOENT";
    throw err;
  }
  const realParent = staysInside(base, realpathSync(parent), p);
  if (!allowMissing) {
    const err = new Error(`not found: ${p}`);
    err.code = "ENOENT";
    throw err;
  }
  return resolve(realParent, ...tail.reverse());
}

function clip(text, max = TOOL_RESULT_CHARS) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

function argObject(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function listDir(root, path) {
  const dir = resolveInside(root, path || ".");
  const st = lstatSync(dir);
  if (!st.isDirectory()) return `${path || "."} is not a directory`;
  const names = readdirSync(dir);
  const lines = names.slice(0, 500).map((name) => {
    try {
      const s = lstatSync(resolve(dir, name));
      return `${s.isDirectory() ? "d" : s.isSymbolicLink() ? "l" : "f"} ${name}`;
    } catch {
      return `? ${name}`;
    }
  });
  if (names.length > 500) lines.push(`…[${names.length - 500} more]`);
  return lines.join("\n") || "(empty)";
}

function readFile(root, path, offset, limit) {
  const file = resolveInside(root, path);
  const st = lstatSync(file);
  if (st.isDirectory()) return `${path} is a directory — use list_dir`;
  const buf = readFileSync(file);
  if (buf.includes(0)) return `${path} looks binary — not read`;
  const lines = buf.toString("utf8").split("\n");
  const start = Math.max(1, Number(offset) || 1);
  const n = Math.min(800, Math.max(1, Number(limit) || READ_LINES));
  const slice = lines.slice(start - 1, start - 1 + n);
  const header = `${path}  lines ${start}-${start - 1 + slice.length} of ${lines.length}`;
  return `${header}\n${slice.join("\n")}`;
}

function grep(root, pattern, path, glob) {
  const target = path ? resolveInside(root, path) : realpathSync(root);
  const args = ["-n", "--max-count", "40", "--heading", "-g", "!node_modules/**", "-g", "!.git/**"];
  if (glob) args.push("-g", glob);
  args.push(String(pattern), target);
  return runProcess("rg", args, realpathSync(root), 20_000).then((r) => {
    if (r.code === 0 || r.code === 1) return r.out.trim() || "(no matches)";
    // rg missing: a small in-process scan, source files only.
    if (r.err && /ENOENT/.test(r.err)) return grepFallback(root, pattern, target);
    return clip(r.out || r.err || `rg exited ${r.code}`);
  });
}

function grepFallback(root, pattern, target) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return `bad pattern: ${err.message}`;
  }
  const hits = [];
  const walk = (dir, depth) => {
    if (hits.length >= 40 || depth > 6) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue;
      const full = resolve(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile() && st.size < 1_000_000) {
        let text;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && hits.length < 40; i++) {
          if (re.test(lines[i])) hits.push(`${relative(root, full)}:${i + 1}:${lines[i].slice(0, 240)}`);
        }
      }
    }
  };
  try {
    const st = lstatSync(target);
    if (st.isFile()) {
      const text = readFileSync(target, "utf8").split("\n");
      text.forEach((line, i) => {
        if (hits.length < 40 && re.test(line)) hits.push(`${relative(root, target)}:${i + 1}:${line.slice(0, 240)}`);
      });
    } else walk(target, 0);
  } catch (err) {
    return err.message;
  }
  return hits.join("\n") || "(no matches)";
}

function editFile(root, path, oldString, newString) {
  if (typeof oldString !== "string" || typeof newString !== "string") {
    return "old_string and new_string must be strings";
  }
  if (oldString === newString) return "old_string and new_string are identical — nothing to do";
  const file = resolveInside(root, path);
  const text = readFileSync(file, "utf8");
  const n = text.split(oldString).length - 1;
  if (n === 0) return "old_string was not found. Read the file and copy the exact text.";
  if (n > 1) return `old_string matched ${n} times. Include more surrounding lines so it is unique.`;
  writeFileSync(file, text.replace(oldString, newString));
  return `edited ${path}`;
}

function writeFile(root, path, content) {
  if (typeof content !== "string") return "content must be a string";
  if (content.length > MAX_WRITE_CHARS) return `content is ${content.length} chars; the limit is ${MAX_WRITE_CHARS}`;
  const file = resolveInside(root, path, true);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return `wrote ${path} (${content.length} chars)`;
}

// Drop pty control bytes (the macOS `script` prefix, backspaces, ANSI) so a
// line on screen matches what the program printed.
function visibleLine(raw) {
  const cr = String(raw).lastIndexOf("\r");
  let slice = cr >= 0 ? String(raw).slice(cr + 1) : String(raw);
  slice = slice
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  let s = "";
  for (const ch of slice) {
    if (ch === "\b" || ch === "\x7f") s = s.slice(0, -1);
    else if (ch === "\t" || ch >= " ") s += ch;
  }
  return s;
}

function cleanStream(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => visibleLine(line))
    .join("\n")
    .trim();
}

function createOutputPump(onLine) {
  let buf = "";
  const emit = (raw) => {
    const line = visibleLine(raw);
    if (line.trim()) onLine(line);
  };
  return {
    push(text) {
      buf += String(text);
      buf = buf.replace(/\r\n/g, "\n");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        emit(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    partial() {
      if (!buf) return "";
      return visibleLine(buf);
    },
    flush() {
      if (!buf) return;
      const rest = buf;
      buf = "";
      emit(rest);
    },
  };
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

// A tty so line-buffered programs (gh, test runners) flush as they print.
// VKTECH_AGENT_NO_PTY=1 forces a plain pipe. GNU script is not this argv.
function shellInvocation(command) {
  if (process.env.VKTECH_AGENT_NO_PTY !== "1" && process.platform === "darwin" && existsSync("/usr/bin/script")) {
    return ["/usr/bin/script", ["-q", "-F", "/dev/null", "bash", "-lc", command]];
  }
  return ["bash", ["-lc", command]];
}

/**
 * Run a process. `onOutput` fires for each complete line while it is still
 * running. `onPartial` is the current line when the program has not ended it
 * yet (progress bars). `signal` kills the process group. A timeout is exit
 * 124, never a fake success.
 */
export function runProcess(cmd, args, cwd, timeoutMs, hooks = {}) {
  return new Promise((resolvePromise) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          PAGER: "cat",
          GIT_PAGER: "cat",
          GH_PAGER: "cat",
          MANPAGER: "cat",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolvePromise({ code: 127, out: "", err: e.message });
      return;
    }
    let settled = false;
    let reason = "";
    let killTimer = null;
    const stdout = createOutputPump((line) => hooks.onOutput?.(line, "stdout"));
    const stderr = createOutputPump((line) => hooks.onOutput?.(line, "stderr"));
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      hooks.signal?.removeEventListener("abort", onAbort);
      try { stdout.flush(); stderr.flush(); } catch { /* the display hook owns its errors */ }
      resolvePromise(value);
    };
    const onAbort = () => {
      if (reason) return;
      reason = "abort";
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 400);
      if (killTimer.unref) killTimer.unref();
    };
    const timer = setTimeout(() => {
      if (reason) return;
      reason = "timeout";
      killProcessGroup(child, "SIGKILL");
    }, timeoutMs);
    if (hooks.signal) {
      if (hooks.signal.aborted) onAbort();
      else hooks.signal.addEventListener("abort", onAbort, { once: true });
    }
    const take = (buf, chunk) => (buf + chunk).slice(-TOOL_RESULT_CHARS * 2);
    const pump = (which, target) => (chunk) => {
      const text = String(chunk);
      if (which === "stdout") out = take(out, text);
      else err = take(err, text);
      target.push(text);
      const partial = target.partial();
      if (partial) hooks.onPartial?.(partial, which);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", pump("stdout", stdout));
    child.stderr?.on("data", pump("stderr", stderr));
    child.on("error", (e) => {
      finish({ code: 127, out, err: e.message, cancelled: reason === "abort", timedOut: reason === "timeout" });
    });
    child.on("close", (code, sig) => {
      if (reason === "timeout") finish({ code: 124, out, err, timedOut: true });
      else if (reason === "abort") finish({ code: 130, out, err, cancelled: true });
      else if (code == null) {
        finish({ code: 1, out, err: [err, sig ? `killed by ${sig}` : "no exit status"].filter(Boolean).join("\n") });
      } else finish({ code, out, err });
    });
  });
}

export async function runShell(root, command, hooks) {
  const cmd = String(command || "").trim();
  if (!cmd) return "command is empty";
  if (blockedShellCommand(cmd)) return "refused: that command is destructive. Pick a narrower one.";
  const timeout = Number(process.env.VKTECH_AGENT_CMD_TIMEOUT_MS || 120_000);
  const [bin, args] = shellInvocation(cmd);
  const r = await runProcess(bin, args, realpathSync(root), timeout, hooks);
  const body = cleanStream([r.out, r.err].filter(Boolean).join("\n"));
  if (r.cancelled) return clip(`cancelled\n${body || "(no output)"}`);
  if (r.timedOut) return clip(`exit ${r.code}\ntimed out after ${timeout}ms\n${body || "(no output)"}`);
  return clip(`exit ${r.code}\n${body || "(no output)"}`);
}

async function dispatch(root, name, args, touched, hooks) {
  try {
    switch (name) {
      case "list_dir":
        return listDir(root, args.path);
      case "read_file":
        return readFile(root, args.path, args.offset, args.limit);
      case "grep":
        return await grep(root, args.pattern, args.path, args.glob);
      case "edit_file": {
        const res = editFile(root, args.path, args.old_string, args.new_string);
        if (res.startsWith("edited ")) touched.add(String(args.path));
        return res;
      }
      case "write_file": {
        const res = writeFile(root, args.path, args.content);
        if (res.startsWith("wrote ")) touched.add(String(args.path));
        return res;
      }
      case "run":
        return await runShell(root, args.command, hooks);
      case "web_search":
        return await webSearchTool(args.query);
      case "web_fetch":
        return await fetchWebText(args.url);
      case "rtx_status":
        return await rtxStatus();
      case "read_memory":
        return readMemory(args.query, root);
      case "aws_ssm": {
        if (blockedShellCommand(args.script)) return "blocked: that command is not allowed";
        const host = args.host || defaultSsmHost();
        return formatSsmResult(host, await ssmRun({ host, script: args.script, signal: hooks?.signal }));
      }
      default:
        return `unknown tool ${name}`;
    }
  } catch (err) {
    return `error: ${err.message}`;
  }
}

function systemPrompt(cwd, numCtx = 32768) {
  const rules = [
    "You are vktech, the user's coding agent. You are already running on their RTX 5090 through Ollama.",
    "You can edit files, run commands, search the web, open pages, inspect that GPU, and read memories from Claude, Grok, Codex, Cursor, and Gemini. Do those things with the tools.",
    "When asked to fix code, fix it. When asked to browse, call web_search and web_fetch. When asked if you can reach the RTX, call rtx_status and report what it returns.",
    "Every user prompt already includes a memory check for the words they used, such as edit or replies. Use those notes. Call read_memory to open a title the check did not include.",
    "A bare request to check replies is answered before you run, from this repo's Claude memory and the Mailcow host mail-vk. Do not SSH to the Dell to look for that mail.",
    "Do not claim you cannot edit, run commands, browse, connect to the RTX, or read those memories.",
    `The workspace root is ${cwd}. Every file path is relative to that root. A path outside it is rejected.`,
    "Read a file before you change it. Never invent file contents.",
    "Prefer edit_file for changes. Use write_file only when creating a file or replacing one wholesale.",
    "After you change behavior, run the project's check when one exists.",
    "Earlier turns of this conversation are in the message history. Continue from them. When a follow-up question can be answered from facts or a report already in this conversation, answer from those first and say so, before running anything new.",
    `A running command's output is shown as it prints. Commands stop after ${Math.round(Number(process.env.VKTECH_AGENT_CMD_TIMEOUT_MS || 120_000) / 1000)} seconds and a timeout is a failure. Check status directly.`,
    "Follow the CLAUDE.md instructions below. They are newer than the memories. When the two disagree, for example a memory names a host that has since moved, CLAUDE.md wins.",
    `Boxes with no inbound SSH are reached with the aws_ssm tool (configured: ${Object.keys(ssmHosts()).join(", ") || "none"}). CLAUDE.md says which app runs where. You DO have SSM access from this machine; never say you lack it unless aws_ssm returned an error, and then quote that error. A copy CLAUDE.md calls frozen or rollback-only is not live state.`,
    "If one approach fails twice, stop retrying it. Try a different route or report what blocked you.",
    "When the task is done, stop calling tools and write the report.",
  ].join(" ");
  let memories = "";
  try {
    memories = memoryBrief(cwd, Math.min(Number(process.env.VKTECH_MEMORY_CHARS || 6000), Math.max(2000, Math.floor(Number(numCtx) * 3 * 0.1))));
  } catch (err) {
    memories = `CLI memories could not be read (${err.message}).`;
  }
  // CLAUDE.md gets about a quarter of the context (≈3 chars/token), so a
  // 16k runner still leaves room for the task and the gathered facts.
  const instructionChars = Math.min(
    Number(process.env.VKTECH_INSTRUCTIONS_CHARS || 28_000),
    Math.max(4000, Math.floor(Number(numCtx) * 3 * 0.25)),
  );
  return `${rules}\n\n${REPORT_STYLE}\n\n${instructionFiles(cwd, instructionChars)}\n\n${memories}`;
}

// How a finished task is reported. Modeled on Claude Code's status replies:
// the answer first, then evidence, then what is still open.
const REPORT_STYLE = [
  "How to write the final report:",
  "- Start with the answer in one or two sentences, such as the status, the result, or what changed.",
  "- Then give short bullets with bold leads: what you confirmed and how you know, what is still blocking or open, and anything that failed or that you could not check.",
  "- Report only what you saw in tool output. If you did not check something, say so. Do not guess.",
  "- If you were blocked, say what you tried, why it failed, and the one thing the user can do to unblock it.",
  "- Use plain words and full sentences. Name files, hosts, and IDs exactly. Do not paste raw logs or file listings.",
  "- Keep it short: a few bullets, not a transcript of every step.",
].join("\n");

// CLAUDE.md files hold the user's standing instructions and current facts
// (prod hosts, deploy paths). The nearest project file goes first, then
// parents, then ~/.claude/CLAUDE.md. Each is redacted and the total is capped.
function instructionFiles(cwd, maxChars = Number(process.env.VKTECH_INSTRUCTIONS_CHARS || 28_000)) {
  const files = [];
  const home = homedir();
  let dir = cwd;
  for (let i = 0; i < 12 && dir; i++) {
    files.push(resolve(dir, "CLAUDE.md"));
    if (dir === home) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  files.push(resolve(home, ".claude", "CLAUDE.md"));
  const parts = [];
  let room = maxChars;
  for (const file of [...new Set(files)]) {
    if (room < 200 || !existsSync(file)) continue;
    let body;
    try {
      body = redactText(readFileSync(file, "utf8")).trim();
    } catch {
      continue;
    }
    if (!body) continue;
    const head = `## CLAUDE.md · ${file.replace(home, "~")}\n`;
    const slice = body.length + head.length > room ? `${body.slice(0, room - head.length - 20)}\n…(truncated)` : body;
    parts.push(head + slice);
    room -= head.length + slice.length;
  }
  return parts.length
    ? `Standing instructions from CLAUDE.md files:\n\n${parts.join("\n\n")}`
    : "No CLAUDE.md files were found.";
}

const FACTS_RETRY = "No tools are available, and none are needed. The facts gathered from prod are in the previous user message. Write the report from those facts now, following the report rules.";

const CONTROL_PROMPTS = new Set();
const MAX_MEMORY_READS = Number(process.env.VKTECH_AGENT_MEMORY_READS || 6);

const WRAP_UP = "You have used your tool budget. Do not call tools. Write the final report now from what the tools showed, following the report rules: the answer first, then what you confirmed, what is still open, and what you could not check.";
CONTROL_PROMPTS.add(WRAP_UP).add(FACTS_RETRY);

function messageChars(m) {
  let n = String(m?.content || "").length + String(m?.thinking || "").length;
  // Tool-call arguments are part of the prompt and were missing from the budget,
  // so a long shell session overflowed the loaded context and the model
  // answered with an empty message.
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) n += JSON.stringify(m.tool_calls).length;
  return n;
}

// Keep the thread inside the loaded runner. A bigger prompt waits on a reload
// and stalls other callers of the same model. Old tool output is shortened
// first, then whole earlier turns are dropped. The system prompt stays.
export function trimThread(messages, maxChars = Number(process.env.VKTECH_AGENT_HISTORY_CHARS || 32000)) {
  for (const m of messages) {
    if (m?.role === "assistant" && !String(m.content || "").trim() && !(m.tool_calls || []).length) {
      m.content = "(empty response)";
    }
  }
  // The system prompt is already outside the budget (historyBudget subtracts
  // it). Counting it again here wiped every earlier turn once it grew.
  const size = () => messages.reduce((n, m, i) => n + (i === 0 && m?.role === "system" ? 0 : messageChars(m)), 0);
  for (let i = 1; i < messages.length - 1 && size() > maxChars; i++) {
    const m = messages[i];
    if (m?.role === "tool" && String(m.content || "").length > 400) {
      messages[i] = { ...m, content: String(m.content).slice(0, 400) + "\n…[trimmed]" };
    }
  }
  while (messages.length > 2 && size() > maxChars) {
    let end = 2;
    while (end < messages.length && (messages[end].role !== "user" || CONTROL_PROMPTS.has(messages[end].content))) end++;
    if (end >= messages.length) break;
    messages.splice(1, end - 1);
  }
  // One long turn can still overflow (dozens of tool calls). Drop its oldest
  // assistant call + tool results as a group, keeping the request itself:
  // if Ollama has to truncate instead, it cuts the user message and qwen's
  // template fails with "no user query found in messages".
  const firstUser = messages.findIndex((m, i) => i > 0 && m.role === "user");
  const TRIMMED = "(earlier tool calls trimmed to fit the context)";
  while (firstUser > 0 && size() > maxChars) {
    // The oldest assistant tool call after the request, with its results.
    let start = firstUser + 1;
    while (start < messages.length && !(messages[start].role === "assistant" && (messages[start].tool_calls || []).length)) start++;
    let stop = start + 1;
    while (stop < messages.length && messages[stop].role === "tool") stop++;
    // Keep the latest exchange so the model sees its last result.
    if (stop >= messages.length) break;
    const marker = messages[start - 1]?.content === TRIMMED;
    messages.splice(start, stop - start, ...(marker ? [] : [{ role: "assistant", content: TRIMMED }]));
  }
  return messages;
}

// Chars of history that fit in the loaded context with room left to answer.
function historyBudget(numCtx, overheadChars) {
  const pinned = Number(process.env.VKTECH_AGENT_HISTORY_CHARS || 0);
  const fit = Math.max(4000, (Number(numCtx) - 2048) * 3 - overheadChars);
  return pinned > 0 ? Math.min(pinned, fit) : fit;
}

async function ollamaChat({ model, messages, signal, timeoutMs, onDelta, tools = TOOLS }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ac.abort(signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const think = /^(1|true|yes)$/i.test(process.env.LOCAL_THINK || "");
  const options = {
    ...localTextOptions(),
    num_ctx: await localNumCtx(model),
    num_predict: Number(process.env.LOCAL_AGENT_NUM_PREDICT || 8192),
  };
  try {
    const res = await fetch(`${LOCAL_URL.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        think,
        keep_alive: localKeepAlive(),
        messages,
        ...(tools?.length ? { tools } : {}),
        options,
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      const msg = body?.error || body?.raw || res.statusText;
      const detail = typeof msg === "string" ? msg : JSON.stringify(msg);
      if (res.status === 404 && /model/i.test(detail)) {
        throw new Error(
          `${model} is not loaded on the RTX. On the box: ollama pull ${model}`
        );
      }
      throw new Error(`${res.status} ${detail.slice(0, 500)}`);
    }
    const acc = { role: "assistant", content: "", thinking: "", tool_calls: [] };
    const reader = res.body.getReader();
    const decode = new TextDecoder();
    let pending = "";
    const take = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let chunk;
      try {
        chunk = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (chunk.error) throw new Error(typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error));
      const msg = chunk.message || {};
      if (msg.thinking) {
        acc.thinking += msg.thinking;
        onDelta?.({ thinking: msg.thinking });
      }
      // Chunks are token deltas. A final recap that repeats the whole answer
      // is ignored so the screen does not print it twice.
      if (msg.content && !(chunk.done && msg.content === acc.content)) {
        acc.content += msg.content;
        onDelta?.({ content: msg.content });
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        if (!chunk.done || acc.tool_calls.length === 0) {
          mergeToolCalls(acc.tool_calls, msg.tool_calls);
          const named = [...acc.tool_calls].reverse().find((call) => call?.function?.name);
          if (named?.function?.name) onDelta?.({ tool: named.function.name });
        }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decode.decode(value, { stream: true });
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        take(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    }
    pending += decode.decode();
    if (pending.trim()) take(pending);
    if (!acc.tool_calls.length) delete acc.tool_calls;
    if (!acc.thinking) delete acc.thinking;
    return { message: acc };
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    const cause = err?.cause?.code || err?.cause?.message || "";
    if (err?.name === "AbortError" || /timeout/.test(err?.message || "")) throw err;
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|network/i.test(`${err.message} ${cause}`)) {
      throw new Error(
        `RTX Ollama is unreachable at ${LOCAL_URL}. Check Tailscale (tailscale status | grep rtx5090) and that ollama is serving on the box.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function chatWithRetry(opts) {
  const mark = { emitted: false };
  const onDelta = opts.onDelta;
  const wrapped = {
    ...opts,
    onDelta(delta) {
      mark.emitted = true;
      onDelta?.(delta);
    },
  };
  try {
    return await ollamaChat(wrapped);
  } catch (err) {
    if (mark.emitted || opts.signal?.aborted) throw err;
    if (/unreachable|not loaded|timeout/i.test(err.message || "")) throw err;
    // The prompt overflowed num_ctx and Ollama cut the user message off.
    if (/no user query found/i.test(err.message || "")) {
      trimThread(opts.messages, Math.max(3000, Math.floor((opts.budget || 24000) / 2)));
    }
    return ollamaChat(wrapped);
  }
}

// One rewriting status line on stdout. stderr is the same cursor in the VS
// Code terminal, so a spinner there erases the tool lines. This line is only
// `\r` plus clear-to-end, never a cursor-up, so the conversation above stays.
function createActivity(write) {
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  const accent = (s) => (tty ? `\x1b[38;5;141m${s}\x1b[0m` : s);
  let timer = null;
  let alive = false;
  let open = false;
  let label = "";
  let t0 = Date.now();
  const paint = () => {
    if (!alive) return;
    const sec = Math.max(0, Math.round((Date.now() - t0) / 1000));
    const suffix = ` · ${sec}s · Ctrl-C cancels`;
    const width = Math.max(20, process.stdout.columns || 80);
    // One physical row. A wrapped status line makes the next `\r` clear only
    // the tail, which leaves a ghost of the previous label.
    const room = Math.max(4, width - 1 - 2 - suffix.length);
    const shown = oneLine(label, room);
    const frame = frames[Math.floor(Date.now() / 80) % frames.length];
    write(`\r${accent(frame)} ${dim(shown)} ${dim(suffix)}\x1b[K`);
    open = true;
  };
  return {
    set(text, reset = false) {
      label = oneLine(text, 160) || "working";
      if (reset) t0 = Date.now();
      if (!tty) {
        if (reset) write(`… ${label}\n`);
        return;
      }
      alive = true;
      if (!timer) {
        paint();
        timer = setInterval(paint, 200);
        if (timer.unref) timer.unref();
      }
    },
    stop() {
      alive = false;
      if (timer) clearInterval(timer);
      timer = null;
      if (open) {
        write("\r\x1b[K");
        open = false;
      }
    },
    line(text) {
      this.stop();
      const width = Math.max(20, (process.stdout.columns || 80) - 1);
      const raw = String(text || "");
      const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
      write(clipAnsi(body, width) + "\n");
    },
  };
}

function oneLine(text, max = 120) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

// Keep a colored status row on one screen line. Escape sequences do not count.
function clipAnsi(text, max) {
  const src = String(text ?? "");
  const limit = Math.max(1, max);
  let vis = 0;
  let out = "";
  let cut = false;
  const isEsc = (i) => src[i] === "\x1b" && src[i + 1] === "[";
  const hasMoreVisible = (from) => {
    for (let j = from; j < src.length; j++) {
      if (isEsc(j)) {
        const end = src.indexOf("m", j);
        if (end < 0) return false;
        j = end;
        continue;
      }
      return true;
    }
    return false;
  };
  for (let i = 0; i < src.length; i++) {
    if (isEsc(i)) {
      const end = src.indexOf("m", i);
      if (end < 0) break;
      out += src.slice(i, end + 1);
      i = end;
      continue;
    }
    if (vis + 1 >= limit && hasMoreVisible(i + 1)) {
      out += "…";
      cut = true;
      break;
    }
    out += src[i];
    vis++;
  }
  if (cut) out += "\x1b[0m";
  return out;
}

function toolLabel(name, args) {
  if (name === "run") return `run ${oneLine(args.command, 100)}`;
  if (name === "grep") return `grep ${oneLine(args.pattern, 80)}${args.path ? " " + args.path : ""}`;
  if (name === "web_search") return `web_search ${oneLine(args.query, 80)}`;
  if (name === "web_fetch") return `web_fetch ${oneLine(args.url, 80)}`;
  if (name === "rtx_status") return "rtx_status";
  if (name === "read_memory") return `read_memory ${oneLine(args.query, 80)}`;
  const path = args.path || args.pattern || "";
  return path ? `${name} ${path}` : name;
}

// An aborted turn must still be a valid Ollama thread: every tool call has a
// tool result. Resume calls this before the next user message.
export function closeDanglingTools(messages, note = "(cancelled)") {
  if (!Array.isArray(messages) || !messages.length) return messages;
  let assistantIdx = -1;
  for (let j = messages.length - 1; j >= 0; j--) {
    const role = messages[j]?.role;
    if (role === "tool") continue;
    if (role === "assistant" && Array.isArray(messages[j].tool_calls) && messages[j].tool_calls.length) {
      assistantIdx = j;
    }
    break;
  }
  if (assistantIdx < 0) return messages;
  const calls = messages[assistantIdx].tool_calls;
  const tools = messages.slice(assistantIdx + 1).filter((m) => m?.role === "tool");
  const used = new Set();
  for (const call of calls) {
    const id = call?.id;
    let found = -1;
    if (id) found = tools.findIndex((m, idx) => !used.has(idx) && m.tool_call_id === id);
    if (found < 0) found = tools.findIndex((m, idx) => !used.has(idx) && !m.tool_call_id);
    if (found >= 0) {
      used.add(found);
      continue;
    }
    messages.push({
      role: "tool",
      tool_name: call?.function?.name || "unknown",
      ...(id ? { tool_call_id: id } : {}),
      content: note,
    });
  }
  return messages;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("cancelled");
}

// One screen line so a finished tool shows what it found, not only that it ran.
export function toolResultPreview(result) {
  const lines = String(result || "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "(no output)";
  const detail = lines.slice(1).find((line) => !/^loaded:?$/i.test(line));
  if (/^exit \d+$/.test(lines[0]) && detail) return oneLine(`${lines[0]} · ${detail}`, 180);
  if (detail) return oneLine(`${lines[0]} · ${detail}`, 180);
  return oneLine(lines[0], 180);
}

// Ollama may send a tool call whole, or stream the name and arguments in pieces.
export function mergeToolCalls(dst, incoming) {
  for (const call of incoming || []) {
    const fn = call?.function || {};
    const idx = Number.isInteger(call?.index) ? call.index : dst.findIndex((row) => !row?.function?.name);
    const at = idx >= 0 ? idx : dst.length;
    const prev = dst[at]?.function;
    if (!prev) {
      dst[at] = {
        ...call,
        function: { name: fn.name || "", arguments: fn.arguments ?? {} },
      };
      continue;
    }
    if (fn.name && fn.name.length >= String(prev.name || "").length) prev.name = fn.name;
    prev.arguments = mergeArgs(prev.arguments, fn.arguments);
    if (call.id) dst[at].id = call.id;
  }
  return dst;
}

function mergeArgs(prev, next) {
  if (next == null || next === "") return prev ?? {};
  if (typeof next === "string") {
    const base = typeof prev === "string" ? prev : "";
    return base + next;
  }
  if (typeof next === "object") return next;
  return prev ?? next;
}

async function webSearchTool(query) {
  const q = String(query || "").trim();
  if (!q) return "query is empty";
  const { backend, results } = await searchResults(q, { limit: 6 });
  if (!results.length) return `no results for: ${q}`;
  const lines = results.map((hit, i) => {
    const snippet = String(hit.content || "").replace(/\s+/g, " ").slice(0, 400);
    return `${i + 1}. ${hit.title || "(no title)"}\n   ${hit.url || ""}\n   ${snippet}`;
  });
  return `backend: ${backend}\n${lines.join("\n")}`;
}

async function rtxStatus() {
  const base = LOCAL_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) return `RTX Ollama at ${base} answered HTTP ${res.status}`;
  const body = await res.json();
  const models = Array.isArray(body.models) ? body.models : [];
  if (!models.length) return `connected to RTX Ollama at ${base}\nloaded: (none)`;
  const lines = models.map((m) => {
    const size = Number(m.size) || 0;
    const vram = Number(m.size_vram) || 0;
    const pct = size ? Math.round((1000 * vram) / size) / 10 : 0;
    const name = m.name || m.model || "(unnamed)";
    return `${name} ctx=${m.context_length ?? "?"} vram=${pct}%`;
  });
  return `connected to RTX Ollama at ${base}\nloaded:\n${lines.join("\n")}`;
}

/**
 * Run the local coding agent.
 * @returns {Promise<{model:string, text:string, turns:number, files:string[], messages:object[]}>}
 */
export async function runLocalAgent({ prompt, cwd = process.cwd(), model, signal, spin, log, write, messages: prior, onTrace }) {
  if (!prompt || !String(prompt).trim()) throw new Error("empty prompt");
  if (!existsSync(cwd)) throw new Error(`workspace not found: ${cwd}`);
  const root = realpathSync(cwd);
  const outEarly = write || ((s) => process.stdout.write(s));
  if (isReplyCheck(prompt)) {
    const text = await checkReplies({ cwd: root, focus: replyFocus(prompt) });
    const mdEarly = createMarkdownStream(outEarly);
    mdEarly.push(text.endsWith("\n") ? text : `${text}\n`);
    mdEarly.flush();
    const messages = Array.isArray(prior) ? prior : [];
    messages.push({ role: "user", content: String(prompt) });
    messages.push({ role: "assistant", content: text });
    onTrace?.({ phase: "done", text, messages });
    return { model: model || DEFAULTS.local, text, turns: 0, files: [], messages };
  }
  const usedModel = model || DEFAULTS.local;
  const maxTurns = Math.max(1, Number(process.env.VKTECH_AGENT_TURNS || 24));
  const timeoutMs = Math.max(
    Number(process.env.VKTECH_TIMEOUT_MS || 0),
    Number(process.env.VKTECH_AGENT_TIMEOUT_MS || 300_000),
  );
  const out = write || ((s) => process.stdout.write(s));
  // Callers still pass log/spin. The trace is drawn on stdout so it shares a
  // cursor with the reply in terminals that merge the two streams.
  void log;
  void spin;
  const activity = createActivity(out);
  const dim = (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[2m${s}\x1b[0m` : s);
  // A status redraw uses `\r`. If the reply is still mid-line, that `\r`
  // erases the tail of the answer. Finish the line before any status row.
  let atBol = true;
  const emit = (chunk) => {
    const s = String(chunk ?? "");
    if (!s) return;
    out(s);
    atBol = s.endsWith("\n");
  };
  const bol = () => {
    if (atBol) return;
    out("\n");
    atBol = true;
  };
  // `prior` is the saved conversation. The same array is appended and returned
  // so the REPL can persist it and continue next turn.
  const messages = Array.isArray(prior) ? prior : [];
  const ctxLen = await localNumCtx(usedModel);
  const promptText = systemPrompt(root, ctxLen);
  if (messages[0]?.role === "system") messages[0] = { ...messages[0], content: promptText };
  else messages.unshift({ role: "system", content: promptText });
  // A previous quit may have saved an assistant tool call with no result.
  closeDanglingTools(messages, "(cancelled)");
  let memoryNote = "";
  try {
    const found = memoriesForPrompt(prompt, root);
    memoryNote = found.text;
    if (found.terms.length) {
      const notes = found.count ? `${found.count} note${found.count === 1 ? "" : "s"}` : "none";
      activity.line(dim(`→ memory ${found.terms.join(", ")} · ${notes}`));
    }
  } catch (err) {
    activity.line(dim(`→ memory lookup failed (${err.message})`));
  }
  // A follow-up right after a built-in check is usually about that report.
  // Memory hits for its words (e.g. "reply") pull the model elsewhere.
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && !CONTROL_PROMPTS.has(m.content));
  const checks = await loadChecks();
  const priorBrief = lastUser && [...checks.map((c) => c.brief), STATUS_BRIEF].find((b) => String(lastUser.content).includes(b));
  // Built-in checks gather the facts first, so the model reports from them
  // instead of hunting for hosts, logs and credentials:
  //   private plugins in ~/.config/vktech/checks (checks.js), e.g. "check on edi"
  //   "status" / "check on X" → this repo's git, PRs, Claude memory and
  //                             sessions, and prod health (status.js), any repo
  let gathered = "";
  const plugin = checks.find((c) => { try { return c.match(prompt, { cwd: root }); } catch { return false; } });
  const statusAsk = plugin ? null : statusIntent(prompt);
  if (plugin || statusAsk) {
    activity.line(dim(plugin
      ? `→ ${plugin.label}`
      : `→ status check · git, PRs, Claude memory + sessions, prod health${statusAsk.topic ? ` · "${statusAsk.topic}"` : ""}`));
    activity.set(`${usedModel} · gathering ${plugin ? plugin.name : "repo status"}`, true);
    try {
      gathered = plugin
        ? `${plugin.brief}\n\n${await plugin.gather({ signal, cwd: root, ssmRun })}`
        : `${STATUS_BRIEF}\n\n${await gatherStatus({ cwd: root, topic: statusAsk.topic })}`;
    } catch (err) {
      gathered = plugin
        ? (plugin.onError ? plugin.onError(err) : `The ${plugin.name} check failed: ${err.message}. Report that error.`)
        : `The status check failed: ${err.message}. Report that error.`;
    } finally {
      activity.stop();
    }
    activity.line(dim(`  ${toolResultPreview(gathered)}`));
  }
  // A status check stands alone. Earlier turns (often failed attempts on the
  // wrong host) only steer the model away from the fresh facts, so drop them.
  if (gathered) messages.splice(1);
  // The gathered facts carry their own brief; the memory hits would only
  // crowd a small context.
  if (gathered) memoryNote = "";
  if (priorBrief && !gathered) {
    // The raw facts are ~8 KB and the report above already carries them. On a
    // 16k runner keeping both would push the report out of the context.
    lastUser.content = `${priorBrief}\n\n(The raw facts were here. They are summarised in your report below.)`;
    memoryNote = "This is a follow-up to the report you just wrote from freshly gathered facts (above). Answer from that report first, and say that is where the answer comes from. Only look further if it truly does not cover the question.";
  }
  const userContent = [memoryNote, gathered, memoryNote || gathered ? `User request:\n${String(prompt)}` : String(prompt)]
    .filter(Boolean).join("\n\n");
  messages.push({ role: "user", content: userContent });
  const overhead = JSON.stringify(TOOLS).length + promptText.length + 800;
  const budget = historyBudget(ctxLen, overhead);
  trimThread(messages, budget);
  onTrace?.({ phase: "start", messages });
  const touched = new Set();
  let lastText = "";
  let failed = null;
  let emptyPass = 0;
  // Identical tool calls (name + args) seen this run. A local model can loop
  // on one command whose answer will not change.
  const seenCalls = new Map();
  let bogusPass = 0;
  let memoryReads = 0;
  let repeats = 0;

  try {
  for (let turn = 1; turn <= maxTurns; turn++) {
    throwIfAborted(signal);
    trimThread(messages, budget);
    let wrote = false;
    let thought = "";
    // Replies render Markdown in the theme, colour-coded by status.
    // The status row redraws with \r, so stop it before any reply line lands.
    const md = createMarkdownStream((chunk) => { activity.stop(); emit(chunk); });
    // The last turn gets no tools, so a long investigation still ends in a
    // report instead of "(stopped: turn limit reached)".
    // A built-in check already gathered the facts, so its first turn is the
    // report. A repeated identical tool call also means it is time to report.
    const factsFirst = turn === 1 && Boolean(gathered);
    const wrapUp = (turn === maxTurns && maxTurns > 1) || repeats >= 2;
    if (wrapUp) messages.push({ role: "user", content: WRAP_UP });
    activity.set(`${usedModel} · turn ${turn} · ${wrapUp ? "writing report" : "thinking"}`, true);
    const body = await chatWithRetry({
      model: usedModel,
      messages,
      signal,
      timeoutMs,
      tools: wrapUp || factsFirst ? [] : TOOLS,
      budget,
      onDelta(delta) {
        if (delta.tool) {
          activity.set(`${usedModel} · turn ${turn} · ${delta.tool}`);
          return;
        }
        if (delta.thinking) {
          thought = (thought + delta.thinking).replace(/\s+/g, " ").trim();
          activity.set(`${usedModel} · turn ${turn} · ${thought.slice(-120)}`);
          return;
        }
        if (delta.content) {
          if (!wrote) activity.stop();
          wrote = true;
          md.push(delta.content);
        }
      },
    });
    md.flush();
    activity.stop();
    const msg = body?.message || {};
    let calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    // A no-tools turn (report) or a made-up tool name (qwen once called
    // "Skill" after reading a memory that mentions it): drop the calls rather
    // than run them, and ask for the text report again.
    const offered = wrapUp || factsFirst ? new Set() : TOOL_NAMES;
    const bogus = calls.filter((c) => !offered.has(c?.function?.name));
    if (bogus.length) {
      calls = calls.filter((c) => offered.has(c?.function?.name));
      if (calls.length) msg.tool_calls = calls;
      else delete msg.tool_calls;
      if (!calls.length && !String(msg.content || "").trim() && bogusPass < 1) {
        bogusPass += 1;
        bol();
        activity.line(dim(`→ ignored call to ${bogus.map((c) => c?.function?.name || "?").join(", ")} (not available this turn)`));
        messages.push({ role: "user", content: factsFirst ? FACTS_RETRY : WRAP_UP });
        turn -= 1;
        continue;
      }
    }
    const text = String(msg.content || "").trim();
    const thinking = String(msg.thinking || "").trim();
    // Thinking is not part of the next request. qwen3.8 puts the answer there
    // when think is on, and a long trace blows the shared context.
    if (msg.thinking) delete msg.thinking;
    // An empty message with no tool call is what produced the blank screen.
    // Shorten the thread once and ask again before giving up.
    if (!text && !thinking && !calls.length && !lastText && emptyPass < 1) {
      emptyPass += 1;
      trimThread(messages, Math.max(3000, Math.floor(budget / 2)));
      continue;
    }
    emptyPass = 0;
    const finalText = text || thinking || (calls.length ? "" : (lastText || "The model returned an empty reply. Ask that again."));
    if (!text && !calls.length) msg.content = finalText;
    messages.push(msg);
    if (text) {
      lastText = text;
      if (!wrote) { md.push(text.endsWith("\n") ? text + "\n" : text + "\n\n"); md.flush(); }
    } else if (!calls.length && finalText && !wrote) {
      lastText = finalText;
      md.push(finalText.endsWith("\n") ? finalText + "\n" : finalText + "\n\n");
      md.flush();
    }
    onTrace?.({ phase: "assistant", messages, text: text || finalText });
    if (!calls.length) {
      onTrace?.({ phase: "done", messages, text: finalText });
      return { model: usedModel, text: finalText, turns: turn, files: [...touched], messages };
    }
    for (const call of calls) {
      throwIfAborted(signal);
      const fn = call?.function || {};
      const name = fn.name || "unknown";
      const args = argObject(fn.arguments);
      const label = toolLabel(name, args);
      const callKey = `${name}:${JSON.stringify(args)}`;
      if (name === "read_memory" && ++memoryReads > MAX_MEMORY_READS) {
        repeats += 1;
        messages.push({
          role: "tool",
          tool_name: name,
          ...(call.id ? { tool_call_id: call.id } : {}),
          content: `read_memory limit (${MAX_MEMORY_READS}) reached for this request. Answer from the notes you already have.`,
        });
        continue;
      }
      if (seenCalls.has(callKey)) {
        repeats += 1;
        bol();
        activity.line(dim(`→ ${label} · repeated, skipped`));
        messages.push({
          role: "tool",
          tool_name: name,
          ...(call.id ? { tool_call_id: call.id } : {}),
          content: `You already ran this exact call. Its result has not changed:\n${seenCalls.get(callKey)}\nDo not repeat it. Use what you have or try something different.`,
        });
        continue;
      }
      bol();
      activity.line(dim(`→ ${label}`));
      activity.set(`${usedModel} · ${label}`, true);
      let result;
      let streamed = 0;
      try {
        const runHooks = name === "run" ? {
          signal,
          onOutput(line) {
            streamed += 1;
            if (streamed > 500) {
              if (streamed === 501) {
                activity.stop();
                out(dim("  … further lines are kept for the model\n"));
                activity.set(`${usedModel} · ${label}`);
              }
              return;
            }
            // A real newline, never cursor-up. The status line redraws under it.
            activity.stop();
            emit(`  ${redactText(line).slice(0, 500)}\n`);
            activity.set(`${usedModel} · ${label}`);
          },
          onPartial(partial) {
            const bit = oneLine(partial, 80);
            activity.set(bit ? `${usedModel} · ${label} · ${bit}` : `${usedModel} · ${label}`);
          },
        } : name === "aws_ssm" ? { signal } : undefined;
        result = redactText(clip(await dispatch(root, name, args, touched, runHooks)));
        seenCalls.set(callKey, oneLine(result, 2000));
      } finally {
        activity.stop();
      }
      if (streamed) {
        const head = String(result).split("\n").find((line) => line.trim()) || "done";
        activity.line(dim(`  ${oneLine(head, 180)}`));
      } else {
        activity.line(dim(`  ${toolResultPreview(result)}`));
      }
      messages.push({
        role: "tool",
        tool_name: name,
        ...(call.id ? { tool_call_id: call.id } : {}),
        content: result,
      });
      onTrace?.({ phase: "tool", messages, text: lastText, label, result });
    }
  }
  } catch (err) {
    failed = err instanceof Error ? err : new Error(String(err));
    const note = failed.message === "cancelled" ? "(cancelled)" : `(error: ${failed.message})`;
    closeDanglingTools(messages, note);
    try { onTrace?.({ phase: "cancel", messages, text: lastText, error: note }); } catch { /* keep the original error */ }
  } finally {
    bol();
    activity.stop();
  }
  if (failed) throw failed;
  const limited = lastText
    ? `${lastText}\n\n(stopped: turn limit reached)`
    : "(stopped: turn limit reached)";
  onTrace?.({ phase: "done", messages, text: limited });
  return {
    model: usedModel,
    text: limited,
    turns: maxTurns,
    files: [...touched],
    messages,
  };
}
