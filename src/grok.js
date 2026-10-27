// xAI Grok via the `grok` CLI (subscription path) instead of api.x.ai.
//
// Mirrors src/claude.js in spirit (shell out to an installed CLI) but captures
// stdout rather than inheriting the terminal, because callers want the text.
// Enabled with XAI_BACKEND=grok-cli (the default) or XAI_USE_CLI=true; askXai
// in providers.js then routes here instead of the HTTP API. Uses grok's OWN
// auth — run `grok login` to spend the subscription instead of API credits, so
// no XAI_API_KEY is needed in this mode.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GROK_BIN = process.env.GROK_BIN || "grok";

// True when the CLI (subscription) backend should be used instead of api.x.ai.
// Defaults ON: the CLI is the intended path now, and it needs no API key.
// Opt back out with XAI_BACKEND=api.
export function useGrokCli() {
  const backend = (process.env.XAI_BACKEND || "").toLowerCase().trim();
  if (backend) return backend !== "api" && backend !== "http";
  if (process.env.XAI_USE_CLI) return /^(1|true|yes)$/i.test(process.env.XAI_USE_CLI);
  return true;
}

// Spawn grok and capture stdout. Split out from askGrokCli so the temp-file
// cleanup below stays a plain try/finally.
function runGrok(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(GROK_BIN, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      if (e.name === "AbortError" || signal?.aborted) return reject(e);
      if (e.code === "ENOENT") {
        return reject(new Error(
          `Could not find the Grok CLI ("${GROK_BIN}"). Install it and run \`grok login\`, ` +
          `set GROK_BIN, or set XAI_BACKEND=api to use api.x.ai with XAI_API_KEY.`
        ));
      }
      reject(e);
    });
    child.on("close", (code) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      if (code !== 0) {
        const detail = (err.trim() || out.trim() || `exit code ${code}`).slice(0, 2000);
        // The CLI exits non-zero when it has no credentials of its own.
        const hint = /not logged in|unauthor|login|credential/i.test(detail)
          ? " — run `grok login` to authenticate the CLI."
          : "";
        return reject(new Error(`grok CLI failed: ${detail}${hint}`));
      }
      resolve(out.trim() || "(empty response)");
    });
  });
}

// Single-turn headless run: grok prints the response to stdout and exits.
// The prompt goes via --prompt-file, not argv, so large audit bundles can't
// blow the ~1MB single-argument limit (E2BIG) — the same reason the HTTP path
// switches to streaming on big prompts. `--verbatim` sends the prompt exactly
// as given, and web search / subagents are off: this is an ANALYSIS call, not
// an interactive agent session.
// NOTE: do NOT add `--max-turns 1` — grok treats hitting the cap as a failure
// ("Error: max turns reached") and exits before printing the answer.
export async function askGrokCli({ prompt, system, model, signal }) {
  const dir = await mkdtemp(join(tmpdir(), "vktech-grok-"));
  const promptFile = join(dir, "prompt.txt");
  try {
    await writeFile(promptFile, prompt ?? "", "utf8");
    const args = [
      "--prompt-file", promptFile,
      "--verbatim",
      "--output-format", "plain",
      "--disable-web-search",
      "--no-subagents",
    ];
    if (model) args.push("--model", model);
    if (system) args.push("--system-prompt-override", system);
    return await runGrok(args, signal);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
