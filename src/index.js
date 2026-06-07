// vktech — public library entry point.
//
// Programmatic API for the multi-provider AI analysis layer. The CLI
// (`src/cli.js`, exposed as the `vktech` bin) is a thin wrapper over these.
//
//   import { ask, askAll, availableProviders, loadEnv } from "vktech";
//   loadEnv();                                  // optional: read .env files
//   const { provider, model, text } = await ask({ modelArg: "gpt-5", prompt: "…" });
//
// Keys are read from process.env (OPENAI_API_KEY / GEMINI_API_KEY / XAI_API_KEY).
// Call loadEnv() first if you want the same .env discovery the CLI uses.
import { existsSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";

// Discover and load .env files the same way the CLI does. Idempotent; dotenv
// never overrides an already-set variable, so real process.env always wins.
export function loadEnv() {
  const HOME = process.env.HOME || process.env.USERPROFILE || "";
  const sources = [
    process.env.VKTECH_ENV,
    join(process.cwd(), ".env"),
    HOME && join(HOME, ".config", "vktech", ".env"),
    HOME && join(HOME, ".vktech.env"),
  ].filter(Boolean);
  for (const path of sources) {
    if (existsSync(path)) dotenv.config({ path });
  }
  return process.env;
}

// Provider router: single-shot + fan-out analysis, provider discovery, model aliasing.
export {
  ask,
  askAll,
  availableProviders,
  resolveProvider,
  PROVIDERS,
  DEFAULTS,
} from "./providers.js";

// Audit templates: list/load saved prompt templates and build a bundled prompt.
export { listTemplates, loadTemplate, buildPrompt } from "./templates.js";

// Industry detection used by `vktech audit auto`.
export { detectIndustry, INDUSTRIES } from "./industry.js";

// Claude Code handoff (shells out to the `claude` CLI).
export { runClaude } from "./claude.js";
