// Hands code-implementation work off to the installed Claude Code CLI.
import { spawn } from "node:child_process";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// Run Claude Code interactively (inherits the terminal) with an initial prompt.
// Extra args (e.g. --print, --permission-mode) are passed through.
export function runClaude(prompt, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [...extraArgs];
    if (prompt) args.push(prompt);
    const child = spawn(CLAUDE_BIN, args, { stdio: "inherit" });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `Could not find the Claude Code CLI ("${CLAUDE_BIN}"). Install it or set CLAUDE_BIN in .env.`
          )
        );
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}
