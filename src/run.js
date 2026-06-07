// `vktech run` / `vktech remote` — paste a multi-line snippet and execute it,
// locally with Node or on a remote host over SSH. Avoids shell-quoting pain:
// the snippet is read from stdin/heredoc/file, never re-parsed by your shell.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Read the snippet from: --file <path>, or a trailing inline arg, else stdin (paste).
export async function readSnippet({ file, inline, promptHint }) {
  if (file) return readFileSync(file, "utf8");
  if (inline) return inline;
  if (process.stdin.isTTY && promptHint) process.stderr.write(promptHint);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// Wrap a snippet so top-level await works and a trailing expression isn't required.
// `fetch`, `process`, `console` are already global in Node 18+.
function wrapJs(snippet) {
  return `(async () => {\n${snippet}\n})().catch((e) => { console.error(e?.stack || e?.message || e); process.exit(1); });\n`;
}

// Run a JS snippet locally with Node. Inherits stdio so output streams live.
export function runLocalJs(snippet, { nodeArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "vktech-run-"));
    const f = join(dir, "snippet.mjs");
    writeFileSync(f, wrapJs(snippet));
    const child = spawn(process.execPath, [...nodeArgs, f], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

// Run a shell snippet locally via bash.
export function runLocalShell(snippet) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", snippet], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

// Run a snippet on a remote host over SSH. lang: 'node' wraps + pipes to `node`,
// 'shell' pipes to the remote default shell. The snippet is sent over stdin so it
// is never interpolated into a shell command line (no quoting/escaping issues).
export function runRemote(snippet, { host, lang = "node", sshArgs = [] }) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error("remote: --host is required (e.g. root@1.2.3.4)"));
    const remoteCmd = lang === "node" ? "node --input-type=module" : "bash -s";
    const payload = lang === "node" ? wrapJs(snippet) : snippet;
    // -T: no pseudo-tty (we're piping a script, not interacting).
    const child = spawn("ssh", ["-T", ...sshArgs, host, remoteCmd], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") reject(new Error("ssh not found on PATH"));
      else reject(err);
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.stdin.write(payload);
    child.stdin.end();
  });
}
