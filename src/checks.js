// Private check plugins. A built-in check gathers facts before the model
// answers ("check on edi", ...). Site-specific checks hold internal hosts,
// mailbox ids and case details, so they live OUTSIDE this public repo:
//   ~/.config/vktech/checks/*.mjs   (or VKTECH_CHECKS_DIR)
// Each module's default export:
//   { name, report, label, match(prompt, { cwd }) → bool,
//     gather({ signal, cwd, ssmRun }) → Promise<string>, brief, onError?(err) }
// `brief` is prepended to the facts and is how a follow-up question is
// recognised as being about that report.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let cache = null;

export async function loadChecks() {
  if (cache) return cache;
  const dir = process.env.VKTECH_CHECKS_DIR || join(homedir(), ".config", "vktech", "checks");
  const found = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs")).sort()) {
      try {
        const mod = (await import(pathToFileURL(join(dir, f)).href)).default;
        if (mod && typeof mod.match === "function" && typeof mod.gather === "function" && mod.brief) {
          found.push({ name: f.replace(/\.mjs$/, ""), report: "report", label: `${f} check`, ...mod });
        }
      } catch (err) {
        process.stderr.write(`vktech: skipped check ${f} (${err.message})\n`);
      }
    }
  }
  cache = found;
  return found;
}
