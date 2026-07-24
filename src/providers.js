// Provider router for vktech.
// Each provider exposes async ask({ prompt, system, model, signal }) -> string.
// Uses native global fetch (Node >=18).

const DEFAULTS = {
  openai: process.env.OPENAI_MODEL || "gpt-5",
  gemini: process.env.GEMINI_MODEL || "gemini-2.5-pro",
  xai: process.env.XAI_MODEL || "grok-4",
  anthropic: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
  // Self-hosted Ollama on the WINDOWS box (free, private). Coding-tuned by
  // default. NOT a Claude replacement — for quick/offline/private analysis.
  // Reached over the tailnet (CLI on the Mac -> Ollama on sga-bridge).
  local: process.env.LOCAL_MODEL || "qwen2.5-coder:7b",
};

// Ollama text endpoint (OpenAI-compatible /v1). Same host as vision by default.
const LOCAL_URL = process.env.LOCAL_URL
  || process.env.LOCAL_VISION_URL
  || "http://100.119.9.25:11434";

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

// Self-hosted Ollama endpoint for `local` vision. Defaults to localhost; point
// at a GPU droplet, e.g. LOCAL_VISION_URL=http://<gpu-droplet-ip>:11434
const LOCAL_VISION_URL = process.env.LOCAL_VISION_URL || "http://100.119.9.25:11434";

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
// Override with VKTECH_PRIORITY="anthropic,xai,openai,gemini,local".
// Claude (anthropic) leads for coding/analysis quality; self-hosted `local`
// (Ollama) trails as the free fallback / second opinion.
const PRIORITY = (process.env.VKTECH_PRIORITY
  ? process.env.VKTECH_PRIORITY.split(",").map((s) => s.trim()).filter(Boolean)
  : ["anthropic", "xai", "openai", "gemini", "local"]);
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

// Lets `--model gpt-5` or `--model gpt-4o` pass the exact id through to the API,
// while a bare alias (`openai`) falls back to the configured default.
function modelIdFor(provider, modelArg) {
  const key = String(modelArg || "").toLowerCase().trim();
  const isAlias = Object.prototype.hasOwnProperty.call(ALIASES, key) && ALIASES[key] === provider;
  if (!modelArg || isAlias) return DEFAULTS[provider];
  return modelArg; // explicit model id, pass through
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

async function streamOnce({ url, key, model, prompt, system, signal }) {
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

// ---- xAI Grok (OpenAI-compatible Chat Completions) ----
// ---- Local Ollama (OpenAI-compatible /v1, no key, self-hosted) ----
async function askLocal({ prompt, system, model, signal }) {
  const url = `${LOCAL_URL.replace(/\/+$/, "")}/v1/chat/completions`;
  const key = "ollama"; // ignored by Ollama, required by the OpenAI shape
  if (prompt.length >= STREAM_THRESHOLD) {
    return streamChatCompletions({ url, key, model, prompt, system, signal });
  }
  const body = await httpJson(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
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

async function askXai({ prompt, system, model, signal }) {
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

// True when a vision provider is usable: keyless providers (local) are always
// "configured"; the rest require their API key to be present.
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
    const model = modelArg && resolveProvider(modelArg) === provider
      ? modelIdFor(provider, modelArg)
      : VISION_DEFAULTS[provider];
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
      `Unknown model "${modelArg}". Use one of: grok/xai, claude/anthropic, gpt-5/openai, gemini (or an explicit model id like gpt-4o or claude-opus-4-8).`
    );
  }
  const model = modelIdFor(provider, modelArg);
  const out = await IMPL[provider]({ prompt, system, model, signal });
  return { provider, model, text: out };
}

// Runnable providers, returned in PRIORITY order (entries not in PRIORITY trail after).
export function availableProviders() {
  // `local` (Ollama) is keyless — always runnable; the rest need their API key.
  const runnable = Object.keys(IMPL).filter((p) => p === "local" || !!process.env[KEY_ENV[p]]);
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
      try {
        const text = await IMPL[provider]({ prompt, system, model, signal });
        return { provider, model, ok: true, text };
      } catch (err) {
        return { provider, model, ok: false, error: err.message };
      }
    })
  );
  return results;
}

export const PROVIDERS = Object.keys(IMPL);
export { DEFAULTS };
