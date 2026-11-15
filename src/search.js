// vktech search — web search for the local/self-hosted Ollama.
//
// Backends:
//   * SearXNG (default): self-hosted (LAN-first, tailnet fallback) — many results,
//     multi-engine, deep page fetch, no rate limits.
//   * Ollama native web_search API (opts.native): Ollama cloud (needs OLLAMA_API_KEY).
//
// Returns { answer, results, backend, model } (answer null when opts.raw).

const SEARXNG_ENDPOINTS = [
  process.env.SEARXNG_URL,             // explicit override wins
  "http://192.168.0.106:8888",         // Dell LAN
  "http://100.84.124.110:8888",        // Dell tailnet fallback
].filter(Boolean);

// Ollama lives on the rtx5090 GPU box (tailnet), not on the Mac — so default
// there rather than localhost. Matches LOCAL_URL in providers.js.
const OLLAMA_HOST = process.env.OLLAMA_HOST
  || process.env.LOCAL_URL
  || "http://100.80.136.28:11434";

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function pickSearxng() {
  for (const base of SEARXNG_ENDPOINTS) {
    try {
      const r = await fetchWithTimeout(base + "/", {}, 4000);
      if (r.ok) return base;
    } catch { /* try next */ }
  }
  return null;
}

async function searchSearxng(query) {
  const base = await pickSearxng();
  if (!base) throw new Error("SearXNG unreachable (LAN + tailnet). Try --native.");
  const u = new URL(base + "/search");
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");
  const r = await fetchWithTimeout(u, {}, 20000);
  const j = await r.json();
  return { base, results: (j.results || []).map((x) => ({ title: x.title, url: x.url, content: x.content || "" })) };
}

async function searchNative(query) {
  const key = process.env.OLLAMA_API_KEY;
  if (!key) throw new Error("OLLAMA_API_KEY not set (run `ollama signin` + create a key).");
  const r = await fetchWithTimeout("https://ollama.com/api/web_search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: 8 }),
  }, 30000);
  const j = await r.json();
  if (j.error) throw new Error(`web_search: ${j.error}`);
  return { base: "ollama-cloud", results: (j.results || []).map((x) => ({ title: x.title, url: x.url, content: x.content || "" })) };
}

// Deep-fetch a page and crudely strip it to plain-ish text.
async function fetchPage(url, max = 2000) {
  try {
    const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0 vktech-search" } }, 12000);
    const html = await r.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  } catch {
    return "";
  }
}

// Web search on AWS through the vkPilot relay (Bedrock Nova grounding).
// Returns a short cited answer plus the cited pages. Needs `vktech login`.
async function searchRelay(query, { recent = false, limit = 8 } = {}) {
  const { loadAccount, relayError } = await import("./vkpilot.js");
  const account = loadAccount();
  if (!account?.token) throw new Error("web search needs a vkPilot sign-in. Run: vktech login (or VKTECH_SEARCH=searxng)");
  const res = await fetch(`${account.baseUrl}/api/cli/v1/search`, {
    method: "POST",
    signal: AbortSignal.timeout(Number(process.env.VKTECH_SEARCH_TIMEOUT_MS || 90_000)),
    headers: { "Content-Type": "application/json", "x-api-key": account.token },
    body: JSON.stringify({ query, recent: Boolean(recent), limit: Math.max(1, Math.min(10, Number(limit) || 8)) }),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${res.status} ${data?.error?.message || data?.raw?.slice?.(0, 200) || res.statusText}`);
    err.status = res.status;
    throw relayError(err) || err;
  }
  return {
    base: `vkpilot (${data.provider || "bedrock"})`,
    answer: String(data.answer || "").trim(),
    costUsd: data.costUsd,
    results: (data.results || []).map((r) => ({ title: r.title, url: r.url, content: r.snippet || "", published: r.published })),
  };
}

// Which search backend runs: VKTECH_SEARCH=relay|searxng|native. Default:
// the vkPilot relay when signed in, else the self-hosted SearXNG.
export async function searchBackend(opts = {}) {
  if (opts.native) return "native";
  const pick = String(process.env.VKTECH_SEARCH || "").toLowerCase();
  if (["relay", "searxng", "native"].includes(pick)) return pick;
  const { useRelay } = await import("./vkpilot.js");
  return useRelay() ? "relay" : "searxng";
}

async function runSearch(query, opts) {
  const which = await searchBackend(opts);
  if (which === "relay") return { which, ...(await searchRelay(query, opts)) };
  if (which === "native") return { which, answer: "", ...(await searchNative(query)) };
  return { which, answer: "", ...(await searchSearxng(query)) };
}

// Search hits (plus the relay's short cited answer, when it gives one).
// No second model call: the REPL agent reads these and answers.
export async function searchResults(query, opts = {}) {
  const { which, base, results, answer } = await runSearch(query, opts);
  const limit = opts.limit ?? 8;
  if (which === "relay") return { backend: base, answer, results: (results || []).slice(0, limit) };
  return {
    backend: which === "native" ? "ollama-cloud" : `searxng (${base})`,
    results: (results || []).slice(0, limit),
  };
}

// Plain text of one http(s) page, for the agent to read.
export async function fetchWebText(url, max = 8000) {
  const u = new URL(String(url || ""));
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http and https URLs");
  }
  const text = await fetchPage(u.toString(), max);
  return text || "(empty page)";
}

async function ollamaAnswer(model, prompt) {
  const r = await fetchWithTimeout(OLLAMA_HOST + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  }, 300000);
  const j = await r.json();
  if (j.error) throw new Error(`ollama: ${j.error}`);
  return (j.response || "").trim();
}

/**
 * @param {string} query
 * @param {object} opts { model, fetchN, raw, native }
 */
export async function webSearch(query, opts = {}) {
  // Claude on Bedrock (or the vkPilot relay) writes the answer by default.
  // An Ollama id (qwen2.5:7b) or -m local uses the self-hosted box instead.
  const wantsOllama = opts.model && (/^(local|ollama)$/i.test(opts.model) || (/:/.test(opts.model) && !/anthropic\./.test(opts.model)));
  const { askBedrock, bedrockActiveModel, isBedrockModel } = await import("./bedrock.js");
  const model = wantsOllama
    ? (/^(local|ollama)$/i.test(opts.model) ? "qwen2.5:7b" : opts.model)
    : (opts.model && isBedrockModel(opts.model) ? opts.model : null);
  const fetchN = opts.fetchN ?? 3;

  const found = await runSearch(query, opts);
  const { base, results } = found;
  if (!results.length && !found.answer) throw new Error(`no results for: ${query}`);
  const backend = found.which === "relay" ? base : found.which === "native" ? "ollama-cloud" : `searxng (${base})`;

  if (opts.raw) return { answer: null, results, backend, model: model || "bedrock" };
  // The relay already wrote a cited answer. Use it unless a model was asked for.
  if (found.which === "relay" && !opts.model) {
    const sources = results.map((r) => `- ${r.title || r.url}: ${r.url}`).join("\n");
    return { answer: sources ? `${found.answer}\n\nSources:\n${sources}` : found.answer, results, backend, model: "nova-grounding" };
  }

  // Deep-fetch top N pages, snippets for the rest, build cited context.
  const parts = [];
  for (let i = 0; i < results.length; i++) {
    const { title, url, content } = results[i];
    if (!url) continue;
    const body = i < fetchN ? (await fetchPage(url)) || content : content;
    parts.push(`[${title}] (${url})\n${body}\n`);
  }
  const prompt =
    `Answer the question using the web results below. Cite sources by URL. ` +
    `If the results don't cover it, say so.\n\n` +
    `QUESTION: ${query}\n\nWEB RESULTS:\n${parts.join("\n")}`;

  if (wantsOllama) {
    const answer = await ollamaAnswer(model, prompt);
    return { answer, results, backend, model };
  }
  const answer = await askBedrock({ prompt, model: model || undefined });
  return { answer, results, backend, model: bedrockActiveModel() };
}
