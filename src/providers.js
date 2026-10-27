// Provider router for vktech.
// Each provider exposes async ask({ prompt, system, model, signal }) -> string.
// Uses native global fetch (Node >=18).

import { askGrokCli, useGrokCli } from "./grok.js";

const DEFAULTS = {
  openai: process.env.OPENAI_MODEL || "gpt-5",
  gemini: process.env.GEMINI_MODEL || "gemini-2.5-pro",
  // In CLI mode leave this unset so the `grok` CLI picks its own current
  // default (grok-4.6 today) — the old hardcoded "grok-4" is not a model the
  // CLI offers. Pin an explicit id with XAI_MODEL. `null` means "let the CLI
  // decide"; XAI_DISPLAY_MODEL below is what the UI shows for it.
  xai: process.env.XAI_MODEL || (useGrokCli() ? null : "grok-4"),
  anthropic: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
  // Self-hosted Ollama on the rtx5090 GPU box (free, private, GPU-backed) —
  // the DEFAULT provider, see PRIORITY below, and the model behind `vktech code`.
  // qwen3.8:27b (Q4_K_M, tools + vision) is already on the box. Reached over the
  // tailnet (CLI on the Mac -> Ollama on rtx5090, GPU 0).
  local: process.env.LOCAL_MODEL || "qwen3.8:27b",
};

// Ollama text endpoint (OpenAI-compatible /v1). Same host as vision by default.
// `rtx5090` on the tailnet — needs Tailscale up on the Mac.
export const LOCAL_URL = process.env.LOCAL_URL
  || process.env.LOCAL_VISION_URL
  || "http://100.80.136.28:11434";

// Context shared with every other caller of qwen3.8:27b. Ollama reloads the
// whole model when num_ctx changes (15–40s) and will not reload while another
// request holds the runner — a vktech call at a different size queues forever
// behind sgaBackstop's live CAPTCHA / browser agent. 32768 is the size that
// client pins (sgaBackstop lib/localLlm.ts). 128k fits the card, but it is a
// different runner, so it is not the default. Set LOCAL_NUM_CTX to force one.
const SHARED_NUM_CTX = 32768;

export function localTextOptions() {
  const ctx = Number(process.env.LOCAL_NUM_CTX || SHARED_NUM_CTX);
  const temperature = process.env.LOCAL_TEMPERATURE === undefined || process.env.LOCAL_TEMPERATURE === ""
    ? 0.3
    : Number(process.env.LOCAL_TEMPERATURE);
  const num_predict = Number(process.env.LOCAL_NUM_PREDICT || 4096);
  return {
    num_ctx: Number.isFinite(ctx) && ctx >= 2048 ? ctx : SHARED_NUM_CTX,
    temperature: Number.isFinite(temperature) ? temperature : 0.3,
    num_predict: Number.isFinite(num_predict) && num_predict > 0 ? num_predict : 4096,
  };
}

// Prefer the context the model is already loaded with, so this call joins the
// hot runner instead of reloading it. An explicit LOCAL_NUM_CTX wins.
export async function localNumCtx(model) {
  const pinned = Number(process.env.LOCAL_NUM_CTX || 0);
  if (Number.isFinite(pinned) && pinned >= 2048) return pinned;
  try {
    const res = await fetch(`${LOCAL_URL.replace(/\/+$/, "")}/api/ps`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      const want = model || DEFAULTS.local;
      const hit = (data.models || []).find((m) => m.name === want || m.model === want);
      const ctx = Number(hit?.context_length);
      if (Number.isFinite(ctx) && ctx >= 2048) return ctx;
    }
  } catch {
    /* unloaded, or the box didn't answer — fall through to the shared size */
  }
  return SHARED_NUM_CTX;
}

export function localKeepAlive() {
  return process.env.LOCAL_KEEP_ALIVE || "30m";
}

function localBodyExtras(numCtx) {
  return {
    // Thinking models put the answer in `thinking` and leave `content` empty
    // unless this is explicit. Tool calls were verified with think off.
    think: /^(1|true|yes)$/i.test(process.env.LOCAL_THINK || ""),
    keep_alive: localKeepAlive(),
    options: { ...localTextOptions(), num_ctx: numCtx },
  };
}

// Vision-capable model per provider (used by `ask --image`). Separate from the
// text DEFAULTS because not every text model accepts images. Override via env.
// `local` is a self-hosted Ollama vision model (zero per-call API cost) —
// see LOCAL_VISION_URL / LOCAL_VISION_MODEL below.
const VISION_DEFAULTS = {
  local: process.env.LOCAL_VISION_MODEL || "qwen2.5vl:7b",
  xai: process.env.XAI_VISION_MODEL || "grok-4.3",
  anthropic: process.env.ANTHROPIC_VISION_MODEL || "claude-opus-4-8",
  openai: process.env.OPENAI_VISION_MODEL || "gpt-5",
};

// Self-hosted Ollama endpoint for `local` vision — the rtx5090 GPU box on the
// tailnet. Override with LOCAL_VISION_URL=http://<host>:11434
const LOCAL_VISION_URL = process.env.LOCAL_VISION_URL || "http://100.80.136.28:11434";

// VKTECH_VISION_LOCAL_ONLY=true → use ONLY the self-hosted model, never fall
// back to paid APIs. This enforces strictly $0 per-call vision (the default
// posture for this CLI). Set to false to allow the grok→claude→openai cascade.
const VISION_LOCAL_ONLY = /^(1|true|yes)$/i.test(
  process.env.VKTECH_VISION_LOCAL_ONLY || "true"
);
export { VISION_LOCAL_ONLY };

// Fallback order for vision requests. Self-hosted `local` is tried first so
// vision is free by default; the paid cascade (grok→claude→openai) follows
// only when VKTECH_VISION_LOCAL_ONLY=false. Override via
// VKTECH_VISION_PRIORITY="local,anthropic,openai,xai".
const VISION_PRIORITY = (process.env.VKTECH_VISION_PRIORITY
  ? process.env.VKTECH_VISION_PRIORITY.split(",").map((s) => s.trim()).filter(Boolean)
  : (VISION_LOCAL_ONLY ? ["local"] : ["local", "xai", "anthropic", "openai"]));
export { VISION_PRIORITY };

// Map user-typed aliases to a canonical provider key.
const ALIASES = {
  local: "local",
  ollama: "local",
  "self-hosted": "local",
  openai: "openai",
  gpt: "openai",
  "gpt-5": "openai",
  "gpt5": "openai",
  chatgpt: "openai",
  gemini: "gemini",
  google: "gemini",
  grok: "xai",
  xai: "xai",
  x: "xai",
  claude: "anthropic",
  anthropic: "anthropic",
  opus: "anthropic",
  sonnet: "anthropic",
  haiku: "anthropic",
};

// Default analysis-provider priority order (highest first). The REPL boots on the
// first entry whose key is configured; aggregate runs iterate in this order.
// Override with VKTECH_PRIORITY="local,anthropic,xai,openai,gemini".
// Self-hosted `local` (Ollama on the rtx5090) LEADS: it's free, private, and
// GPU-backed, so it's the default for everything. The paid cloud cascade
// (claude→grok→gpt→gemini) follows for the heavier asks `local` can't carry.
const PRIORITY = (process.env.VKTECH_PRIORITY
  ? process.env.VKTECH_PRIORITY.split(",").map((s) => s.trim()).filter(Boolean)
  : ["local", "anthropic", "xai", "openai", "gemini"]);
export { PRIORITY };

export function resolveProvider(modelArg) {
  if (!modelArg) return null;
  const key = String(modelArg).toLowerCase().trim();
  // Allow either an alias or a fully-qualified model id matching a provider's family.
  if (ALIASES[key]) return ALIASES[key];
  if (key.startsWith("gpt")) return "openai";
  if (key.startsWith("gemini")) return "gemini";
  if (key.startsWith("grok")) return "xai";
  if (key.startsWith("claude")) return "anthropic";
  return null;
}

// True when modelArg is a bare provider alias ("local", "claude") rather than a
// concrete model id ("qwen2.5vl:7b") — i.e. it names WHICH provider to use, not
// WHICH model. Callers pick the right per-mode default for those.
function isProviderAlias(provider, modelArg) {
  const key = String(modelArg || "").toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(ALIASES, key) && ALIASES[key] === provider;
}

// Lets `--model gpt-5` or `--model gpt-4o` pass the exact id through to the API,
// while a bare alias (`openai`) falls back to the configured TEXT default.
// The vision path resolves aliases against VISION_DEFAULTS instead — see askVision.
function modelIdFor(provider, modelArg) {
  if (!modelArg || isProviderAlias(provider, modelArg)) return DEFAULTS[provider];
  return modelArg; // explicit model id, pass through
}

// Human-readable model label for a provider, for --help / `vktech providers` /
// the REPL prompt. DEFAULTS.xai is deliberately null in grok-CLI mode (the CLI
// picks its own default), so show that rather than printing "null".
export function displayModel(provider) {
  const id = DEFAULTS[provider];
  if (id) return id;
  if (provider === "xai" && useGrokCli()) return "grok CLI default";
  return "(provider default)";
}

const TIMEOUT_MS = Number(process.env.VKTECH_TIMEOUT_MS || 180_000); // 3 min for large audits
const RETRIES = Number(process.env.VKTECH_RETRIES || 2);

async function httpJson(url, options) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    // Per-attempt timeout. Honor a caller-provided signal too.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    const onAbort = () => ac.abort(options.signal?.reason);
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { ...options, signal: ac.signal });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      if (!res.ok) {
        const msg = body?.error?.message || body?.error || body?.raw || res.statusText;
        const err = new Error(`${res.status} ${res.statusText}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
        // Retry only on transient statuses.
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < RETRIES) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
      return body;
    } catch (err) {
      // Caller cancelled (Ctrl-C): propagate immediately, do NOT retry.
      if (options.signal?.aborted) throw options.signal.reason || err;
      // Network/timeout errors: surface the real cause and retry.
      const cause = err?.cause?.message || err?.cause?.code || err?.message || String(err);
      lastErr = new Error(`request failed (${cause})`);
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr;
}

// Retry wrapper for streaming — large requests intermittently get connection resets
// ("other side closed" / "fetch failed") mid-flight; just retry the whole stream.
async function streamChatCompletions(opts) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await streamOnce(opts);
    } catch (err) {
      // Caller cancelled (Ctrl-C): propagate immediately, do NOT retry.
      if (opts.signal?.aborted) throw opts.signal.reason || err;
      const cause = err?.cause?.message || err?.cause?.code || err?.message || String(err);
      lastErr = new Error(`stream failed (${cause})`);
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

async function streamOnce({ url, key, model, prompt, system, signal, extra }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("stream timeout")), TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => ac.abort(signal.reason), { once: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ],
        ...(extra || {}),
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${t.slice(0, 500)}`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    let out = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) out += delta;
        } catch {
          /* ignore keep-alive / partial lines */
        }
      }
    }
    return out.trim() || "(empty response)";
  } finally {
    clearTimeout(timer);
  }
}

// Use streaming once the prompt is large enough that a single response may be slow.
const STREAM_THRESHOLD = Number(process.env.VKTECH_STREAM_THRESHOLD || 60_000);

// ---- OpenAI (Chat Completions) ----
async function askOpenAI({ prompt, system, model, signal }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set in .env");
  const url = "https://api.openai.com/v1/chat/completions";
  if (prompt.length >= STREAM_THRESHOLD) {
    return streamChatCompletions({ url, key, model, prompt, system, signal });
  }
  const body = await httpJson(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }),
  });
  return body?.choices?.[0]?.message?.content?.trim() || "(empty response)";
}

// ---- Google Gemini (generateContent) ----
async function askGemini({ prompt, system, model, signal }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set in .env");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${key}`;
  const body = await httpJson(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });
  const parts = body?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim() || "(empty response)";
}

// ---- xAI Grok (`grok` CLI by default; OpenAI-compatible HTTP as fallback) ----
// ---- Local Ollama (OpenAI-compatible /v1, no key, self-hosted) ----
// Native /api/chat, not /v1. The OpenAI shim drops `options.num_ctx`, so a /v1
// call falls back to the server's 8192 and then waits to reload the model while
// another caller holds qwen3.8:27b at a different context.
async function streamNativeChat({ url, body, signal }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("stream timeout")), TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => ac.abort(signal.reason), { once: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${t.slice(0, 500)}`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    let out = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const json = JSON.parse(line);
          const delta = json?.message?.content;
          if (delta) out += delta;
        } catch {
          /* partial line */
        }
      }
    }
    return out.trim() || "(empty response)";
  } finally {
    clearTimeout(timer);
  }
}

async function askLocal({ prompt, system, model, signal }) {
  const url = `${LOCAL_URL.replace(/\/+$/, "")}/api/chat`;
  const payload = {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
    ...localBodyExtras(await localNumCtx(model)),
  };
  if (prompt.length >= STREAM_THRESHOLD) return streamNativeChat({ url, body: payload, signal });
  const body = await httpJson(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, stream: false }),
  });
  const msg = body?.message;
  return msg?.content?.trim() || msg?.thinking?.trim() || "(empty response)";
}

async function askXai({ prompt, system, model, signal }) {
  // Subscription path: shell out to the `grok` CLI, which carries its own auth
  // (`grok login`) and so needs no XAI_API_KEY. XAI_BACKEND=api opts back out.
  if (useGrokCli()) return askGrokCli({ prompt, system, model, signal });
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY is not set in .env");
  const url = "https://api.x.ai/v1/chat/completions";
  if (prompt.length >= STREAM_THRESHOLD) {
    return streamChatCompletions({ url, key, model, prompt, system, signal });
  }
  const body = await httpJson(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }),
  });
  return body?.choices?.[0]?.message?.content?.trim() || "(empty response)";
}

// ---- Anthropic Claude (Messages API) ----
async function askAnthropic({ prompt, system, model, signal }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const url = "https://api.anthropic.com/v1/messages";
  const body = await httpJson(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 8192),
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const parts = body?.content || [];
  return parts.map((p) => p.text || "").join("").trim() || "(empty response)";
}

// Which env var holds each provider's API key (also used by availableProviders).
// `local` (Ollama) needs no key — it's gated on reachability, not credentials.
const KEY_ENV = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

// True when a provider is usable: keyless providers are always "configured";
// the rest require their API key. `local` (Ollama) is self-hosted, and `xai` in
// CLI mode carries its own `grok login` auth — neither needs a key here.
export function providerConfigured(provider) {
  if (provider === "local") return true;
  if (provider === "xai" && useGrokCli()) return true;
  return !!process.env[KEY_ENV[provider]];
}

// True when a vision provider is usable. The grok CLI has no image-input path,
// so xAI vision still needs XAI_API_KEY even when text runs through the CLI.
function visionConfigured(provider) {
  if (provider === "local") return true;
  return !!process.env[KEY_ENV[provider]];
}

// ---- Vision (image input) ----------------------------------------------
// Each takes images: [{ mime, dataB64 }]. xAI + OpenAI share the Chat
// Completions image_url shape; Anthropic uses its own image block.
async function visionOpenAICompatible({ url, key, model, prompt, system, images, signal }) {
  const content = [
    { type: "text", text: prompt },
    ...images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mime};base64,${img.dataB64}` },
    })),
  ];
  const body = await httpJson(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content },
      ],
    }),
  });
  return body?.choices?.[0]?.message?.content?.trim() || "(empty response)";
}

async function askXaiVision({ prompt, system, model, images, signal }) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY is not set in .env");
  return visionOpenAICompatible({
    url: "https://api.x.ai/v1/chat/completions",
    key, model, prompt, system, images, signal,
  });
}

async function askOpenAIVision({ prompt, system, model, images, signal }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set in .env");
  return visionOpenAICompatible({
    url: "https://api.openai.com/v1/chat/completions",
    key, model, prompt, system, images, signal,
  });
}

async function askAnthropicVision({ prompt, system, model, images, signal }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const content = [
    ...images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mime, data: img.dataB64 },
    })),
    { type: "text", text: prompt },
  ];
  const body = await httpJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 8192),
      ...(system ? { system } : {}),
      messages: [{ role: "user", content }],
    }),
  });
  const parts = body?.content || [];
  return parts.map((p) => p.text || "").join("").trim() || "(empty response)";
}

// ---- Self-hosted Ollama vision (zero per-call API cost) ----------------
// Talks to Ollama's /api/chat. Ollama wants images as bare base64 strings on
// the message (NOT the OpenAI image_url shape), so we build its native body.
// No API key — availability is purely "is the server reachable".
async function askLocalVision({ prompt, system, model, images, signal }) {
  const url = `${LOCAL_VISION_URL.replace(/\/+$/, "")}/api/chat`;
  const body = await httpJson(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt, images: images.map((img) => img.dataB64) },
      ],
    }),
  });
  return body?.message?.content?.trim() || "(empty response)";
}

const VISION_IMPL = { local: askLocalVision, xai: askXaiVision, anthropic: askAnthropicVision, openai: askOpenAIVision };

// Run a vision prompt, trying providers in VISION_PRIORITY (grok→claude→openai)
// until one with a configured key succeeds. Returns { provider, model, text }.
// `images` is [{ mime, dataB64 }]. Throws only if every configured provider fails.
export async function askVision({ prompt, system, images, modelArg, signal }) {
  if (!images || !images.length) throw new Error("askVision requires at least one image");
  // Explicit --model picks the provider; otherwise cascade.
  const order = modelArg
    ? [resolveProvider(modelArg)].filter((p) => p && VISION_IMPL[p])
    : VISION_PRIORITY.filter((p) => VISION_IMPL[p] && visionConfigured(p));
  if (!order.length) {
    throw new Error(
      "No vision-capable provider configured. Run a self-hosted model (set LOCAL_VISION_URL) " +
      "or set one of XAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY."
    );
  }
  const errors = [];
  for (const provider of order) {
    if (!visionConfigured(provider)) { errors.push(`${provider}: not configured`); continue; }
    // A bare alias (`-m local`) only selects the provider — still use that
    // provider's VISION model, not its text default, or Ollama rejects the
    // request ("model does not support multimodal requests").
    const explicitId = modelArg
      && resolveProvider(modelArg) === provider
      && !isProviderAlias(provider, modelArg);
    const model = explicitId ? modelArg : VISION_DEFAULTS[provider];
    try {
      const text = await VISION_IMPL[provider]({ prompt, system, model, images, signal });
      return { provider, model, text };
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(`${provider} (${model}): ${e.message}`);
    }
  }
  throw new Error(`All vision providers failed:\n  ${errors.join("\n  ")}`);
}

const IMPL = { openai: askOpenAI, gemini: askGemini, xai: askXai, anthropic: askAnthropic, local: askLocal };

export async function ask({ modelArg, prompt, system, signal }) {
  const provider = resolveProvider(modelArg);
  if (!provider) {
    throw new Error(
      `Unknown model "${modelArg}". Use one of: local/ollama, grok/xai, claude/anthropic, gpt-5/openai, gemini (or an explicit model id like qwen3.8:27b or gpt-4o).`
    );
  }
  const model = modelIdFor(provider, modelArg);
  const out = await IMPL[provider]({ prompt, system, model, signal });
  // `model` is null when the provider picks its own (grok CLI); report the
  // display label so callers never render "xai:null".
  return { provider, model: model || displayModel(provider), text: out };
}

// Runnable providers, returned in PRIORITY order (entries not in PRIORITY trail after).
export function availableProviders() {
  // `local` (Ollama) and `xai` in grok-CLI mode are keyless — always runnable;
  // the rest need their API key.
  const runnable = Object.keys(IMPL).filter((p) => providerConfigured(p));
  const ranked = PRIORITY.filter((p) => runnable.includes(p));
  const rest = runnable.filter((p) => !PRIORITY.includes(p));
  return [...ranked, ...rest];
}

// Run the prompt against EVERY configured provider (or a given subset) in parallel.
// Returns [{ provider, model, ok, text|error }] — never throws; failures are captured
// so Claude still gets the providers that succeeded.
export async function askAll({ prompt, system, providers, signal }) {
  const targets = (providers && providers.length ? providers : availableProviders());
  const results = await Promise.all(
    targets.map(async (provider) => {
      const model = DEFAULTS[provider];
      // As in `ask`: null means the provider chooses (grok CLI), so report a
      // label rather than null in the consolidated report.
      const label = model || displayModel(provider);
      try {
        const text = await IMPL[provider]({ prompt, system, model, signal });
        return { provider, model: label, ok: true, text };
      } catch (err) {
        return { provider, model: label, ok: false, error: err.message };
      }
    })
  );
  return results;
}

export const PROVIDERS = Object.keys(IMPL);
export { DEFAULTS };
