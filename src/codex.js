// OpenAI via the Codex CLI (`codex exec`) instead of the billed HTTP API.
//
// When OPENAI_BACKEND=codex (or OPENAI_USE_CODEX=true), vktech routes its
// OpenAI provider through the locally-installed `codex` CLI. If that CLI is
// logged in with a ChatGPT account (`codex login`, auth_mode "chatgpt"),
// requests are served by the ChatGPT subscription rather than API credits.
//
// We shell out to `codex exec` in non-interactive mode, capture the agent's
// final message via `-o <file>`, and return it as plain text — matching the
// async ({ prompt, system, model, signal }) -> string shape of the HTTP
// providers in providers.js.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const TIMEOUT_MS = Number(process.env.VKTECH_TIMEOUT_MS || 180_000);

// True when the OpenAI provider should be served by the Codex CLI.
export function codexEnabled() {
  const v = String(
    process.env.OPENAI_BACKEND || (process.env.OPENAI_USE_CODEX ? "codex" : "")
  )
    .toLowerCase()
    .trim();
  return v === "codex";
}

// Run `codex exec` once and resolve with the agent's final message.
// system + prompt are concatenated since codex exec takes a single prompt;
// the system text is framed so the model treats it as instructions.
export function askCodex({ prompt, system, model, signal }) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "vktech-codex-"));
    const outFile = join(dir, "last.txt");

    const args = [
      "exec",
      "--skip-git-repo-check", // analysis prompts aren't tied to a repo
      "-s",
      "read-only", // never let the agent mutate the filesystem
      "-o",
      outFile,
      "--color",
      "never",
    ];
    if (model) args.push("-m", model);

    const fullPrompt = system
      ? `<system_instructions>\n${system}\n</system_instructions>\n\n${prompt}`
      : prompt;

    const child = spawn(CODEX_BIN, args, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;
    const cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      cleanup();
      fn(arg);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`codex timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(reject, signal?.reason || new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        finish(
          reject,
          new Error(
            `Could not find the Codex CLI ("${CODEX_BIN}"). Install it (npm i -g @openai/codex) or set CODEX_BIN, or unset OPENAI_BACKEND to use the HTTP API.`
          )
        );
      } else {
        finish(reject, err);
      }
    });

    child.on("close", (code) => {
      let text = "";
      try {
        text = readFileSync(outFile, "utf8").trim();
      } catch {
        /* no output file written */
      }
      if (code !== 0 && !text) {
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        return finish(
          reject,
          new Error(
            `codex exec failed (exit ${code})${tail ? `: ${tail}` : ""}`
          )
        );
      }
      finish(resolve, text || "(empty response)");
    });

    child.stdin.end(fullPrompt);
  });
}
