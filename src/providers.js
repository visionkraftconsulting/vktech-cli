// Provider router for vktech.
// Each provider exposes async ask({ prompt, system, model, signal }) -> string.
// Uses native global fetch (Node >=18).
import { codexEnabled, askCodex } from "./codex.js";
export { codexEnabled };

const DEFAULTS = {
  openai: process.env.OPENAI_MODEL || "gpt-5",
  gemini: process.env.GEMINI_MODEL || "gemini-2.5-pro",
  xai: process.env.XAI_MODEL || "grok-4",
};

// Map user-typed aliases to a canonical provider key.
const ALIASES = {
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
};

export function resolveProvider(modelArg) {
  if (!modelArg) return null;
  const key = String(modelArg).toLowerCase().trim();
  // Allow either an alias or a fully-qualified model id matching a provider's family.
  if (ALIASES[key]) return ALIASES[key];
  if (key.startsWith("gpt")) return "openai";
  if (key.startsWith("gemini")) return "gemini";
  if (key.startsWith("grok")) return "xai";
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

// ---- OpenAI (Chat Completions, or Codex CLI when OPENAI_BACKEND=codex) ----
async function askOpenAI({ prompt, system, model, signal }) {
  // Subscription path: serve OpenAI via the Codex CLI (uses a ChatGPT login
  // when `codex` is signed in that way) instead of the billed HTTP API.
  if (codexEnabled()) {
    return askCodex({ prompt, system, model, signal });
  }
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

const IMPL = { openai: askOpenAI, gemini: askGemini, xai: askXai };

export async function ask({ modelArg, prompt, system, signal }) {
  const provider = resolveProvider(modelArg);
  if (!provider) {
    throw new Error(
      `Unknown model "${modelArg}". Use one of: gpt-5/openai, gemini, grok/xai (or an explicit model id like gpt-4o).`
    );
  }
  const model = modelIdFor(provider, modelArg);
  const out = await IMPL[provider]({ prompt, system, model, signal });
  return { provider, model, text: out };
}

// Which providers have a key configured (i.e. are actually runnable).
// OpenAI is also runnable in Codex mode (OPENAI_BACKEND=codex), which uses the
// `codex` CLI's own auth (a ChatGPT login) instead of OPENAI_API_KEY.
const KEY_ENV = { openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", xai: "XAI_API_KEY" };
export function availableProviders() {
  return Object.keys(IMPL).filter((p) => {
    if (p === "openai" && codexEnabled()) return true;
    return !!process.env[KEY_ENV[p]];
  });
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
