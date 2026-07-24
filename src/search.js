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

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

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
async function fetchPage(url) {
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
      .slice(0, 2000);
  } catch {
    return "";
  }
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
  const model = opts.model || "qwen2.5:7b";
  const fetchN = opts.fetchN ?? 3;

  const { base, results } = opts.native ? await searchNative(query) : await searchSearxng(query);
  if (!results.length) throw new Error(`no results for: ${query}`);
  const backend = opts.native ? "ollama-cloud" : `searxng (${base})`;

  if (opts.raw) return { answer: null, results, backend, model };

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

  const answer = await ollamaAnswer(model, prompt);
  return { answer, results, backend, model };
}
