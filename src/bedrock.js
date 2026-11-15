// Claude on Amazon Bedrock. Used for the default `bedrock` provider and as the
// coding agent behind the REPL and `vktech code`.
//
// Bedrock calls go through the Anthropic Bedrock SDK (bedrock-runtime, SigV4)
// with credentials from the AWS profile in VKTECH_BEDROCK_PROFILE, else
// VKTECH_AWS_PROFILE, else `vk-admin`. An expired SSO session fails with a
// hint to run `aws sso login`.
//
// The model is BEDROCK_MODEL (default Claude Fable 5.2, the strongest coding
// model on Bedrock). If the account has no access to it yet, the request drops
// to the next id in BEDROCK_FALLBACK_MODELS, and the model that works is kept
// for the rest of the process.
//
// The agent loop in agent.js keeps its Ollama-style thread
// ({role, content, tool_calls}, {role:"tool", tool_call_id}). bedrockChat()
// converts that thread to Messages API blocks and returns an Ollama-shaped
// message, so sessions, trimming and the tool loop work unchanged.

import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

export const BEDROCK_MODEL = process.env.BEDROCK_MODEL || "us.anthropic.claude-fable-5-2";
const FALLBACKS = (process.env.BEDROCK_FALLBACK_MODELS
  ?? "us.anthropic.claude-opus-5-5,us.anthropic.claude-opus-4-6-v1")
  .split(",").map((s) => s.trim()).filter(Boolean);
export const BEDROCK_REGION = process.env.VKTECH_BEDROCK_REGION || process.env.VKTECH_AWS_REGION || "us-west-2";
export const BEDROCK_PROFILE = process.env.VKTECH_BEDROCK_PROFILE || process.env.VKTECH_AWS_PROFILE || "vk-admin";
// Bedrock models have 1M context. The agent budget stays well under that to
// keep a long tool loop affordable.
export const BEDROCK_CONTEXT_TOKENS = Number(process.env.VKTECH_BEDROCK_CONTEXT_TOKENS || 160_000);
const MAX_TOKENS = Number(process.env.VKTECH_BEDROCK_MAX_TOKENS || 32_000);
const EFFORT = process.env.VKTECH_BEDROCK_EFFORT || "high";

// Models that run the preserved-thinking history check. They get the
// drop_block opt-in so an edited history degrades instead of returning 400.
const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const bindsThinking = (model) => /claude-(fable|mythos)-5|claude-opus-5|claude-sonnet-5-5|claude-haiku-5-5/.test(model);

// A provider-alias or id that means "Claude on Bedrock".
export function isBedrockModel(model) {
  return /^(us|global|eu|apac)\.anthropic\.|^anthropic\.claude/.test(String(model || ""));
}

let client;
function bedrock() {
  if (!client) {
    client = new AnthropicBedrock({
      awsRegion: BEDROCK_REGION,
      providerChainResolver: async () => fromNodeProviderChain(BEDROCK_PROFILE ? { profile: BEDROCK_PROFILE } : {}),
      // Bedrock on-demand quotas throttle bursts (429); the SDK backs off.
      maxRetries: Number(process.env.VKTECH_BEDROCK_RETRIES || 6),
    });
  }
  return client;
}

// The model that answered last time, so later calls skip known 403s.
let working = null;
function modelChain(model) {
  const first = model || working || BEDROCK_MODEL;
  // An explicit non-default id is a deliberate choice: no silent fallback.
  if (model && model !== BEDROCK_MODEL) return [model];
  return [...new Set([first, BEDROCK_MODEL, ...FALLBACKS])];
}

export function bedrockActiveModel() {
  return working || BEDROCK_MODEL;
}

function noAccess(err) {
  const msg = String(err?.message || "");
  return (err?.status === 403 && /not available for this account|access/i.test(msg))
    || (err?.status === 404 && /model/i.test(msg))
    || (err?.status === 400 && /Invalid API version/i.test(msg));
}

function friendly(err) {
  const msg = String(err?.message || err);
  if (err?.status === 429) {
    return new Error("Bedrock is throttling this account (429 after retries). Wait a minute, or ask AWS for a higher on-demand quota for this model.");
  }
  if (/resolve AWS credentials|token has expired|SSO session|ExpiredToken|refresh token/i.test(msg)) {
    return new Error(`AWS credentials for Bedrock are missing or expired. Run: aws sso login --profile ${BEDROCK_PROFILE}`);
  }
  return err instanceof Error ? err : new Error(msg);
}

// ---- thread conversion --------------------------------------------------

function toolDefs(tools) {
  return (tools || []).map((t) => {
    const fn = t.function || t;
    const schema = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : {};
    return {
      name: fn.name,
      description: fn.description || fn.name,
      input_schema: { type: "object", properties: {}, ...schema },
    };
  });
}

function argsObject(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const textBlock = (text) => ({ type: "text", text });

// Ollama-style thread -> { system, messages }. Thinking blocks are replayed
// only for the current request (after the last real user message): earlier
// turns were built on a system prompt that is rebuilt every run, so their
// signatures no longer match. Removing a leading run of them is allowed.
export function toAnthropicThread(thread, { keepThinkingFrom = 0 } = {}) {
  const system = [];
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  let pending = []; // tool_use ids waiting for a result, in order
  let seq = 0;
  thread.forEach((m, idx) => {
    if (!m) return;
    if (m.role === "system") {
      if (out.length === 0) system.push(String(m.content || ""));
      else push("user", [textBlock(String(m.content || ""))]);
      return;
    }
    if (m.role === "user") {
      // A user turn before every pending result arrived: close them first.
      if (pending.length) {
        push("user", pending.map((id) => ({ type: "tool_result", tool_use_id: id, content: "(no result)" })));
        pending = [];
      }
      const text = String(m.content || "");
      if (text.trim()) push("user", [textBlock(text)]);
      return;
    }
    if (m.role === "assistant") {
      if (pending.length) {
        push("user", pending.map((id) => ({ type: "tool_result", tool_use_id: id, content: "(no result)" })));
        pending = [];
      }
      let blocks;
      const usable = Array.isArray(m._blocks) && m._blocks.some((b) => b.type === "tool_use" || (b.type === "text" && String(b.text || "").trim()));
      if (usable) {
        blocks = m._blocks
          .filter((b) => idx >= keepThinkingFrom || (b.type !== "thinking" && b.type !== "redacted_thinking"))
          .map((b) => ({ ...b }));
      } else {
        blocks = [];
        const text = String(m.content || "").trim();
        if (text) blocks.push(textBlock(text));
        for (const call of m.tool_calls || []) {
          const id = call.id || `toolu_vk${idx}_${seq++}`;
          call.id ||= id;
          blocks.push({ type: "tool_use", id, name: call.function?.name || "unknown", input: argsObject(call.function?.arguments) });
        }
      }
      blocks = blocks.filter((b) => b.type !== "text" || String(b.text || "").trim());
      if (!blocks.length) return;
      // The first message must be a user turn.
      if (!out.length) push("user", [textBlock("(conversation resumed)")]);
      push("assistant", blocks);
      pending = blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
      return;
    }
    if (m.role === "tool") {
      let id = m.tool_call_id && pending.includes(m.tool_call_id) ? m.tool_call_id : pending[0];
      if (!id) return; // orphaned result (its call was trimmed away)
      pending = pending.filter((p) => p !== id);
      const content = String(m.content ?? "") || "(empty)";
      push("user", [{ type: "tool_result", tool_use_id: id, content }]);
    }
  });
  if (pending.length) {
    push("user", pending.map((id) => ({ type: "tool_result", tool_use_id: id, content: "(no result)" })));
  }
  // tool_result blocks must lead their user message.
  for (const msg of out) {
    if (msg.role !== "user") continue;
    const results = msg.content.filter((b) => b.type === "tool_result");
    if (results.length) msg.content = [...results, ...msg.content.filter((b) => b.type !== "tool_result")];
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: [textBlock("(start)")] });
  return { system: system.join("\n\n"), messages: out };
}

// Cache the stable prefix (system + tools) and the conversation so far.
function withCacheMarks(messages) {
  const last = messages[messages.length - 1];
  if (last?.content?.length) {
    const block = last.content[last.content.length - 1];
    last.content[last.content.length - 1] = { ...block, cache_control: { type: "ephemeral" } };
  }
  return messages;
}

function stripThinking(messages) {
  for (const m of messages) {
    if (m.role === "assistant") m.content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
  }
  return messages.filter((m) => m.content.length);
}

// ---- requests -----------------------------------------------------------

// Set once Bedrock rejects the binding beta, so later calls skip it.
let bindingRejected = false;

async function streamOnce(opts) {
  try {
    return await streamRaw({ ...opts, binding: !bindingRejected && bindsThinking(opts.model) });
  } catch (err) {
    if (err?.status === 400 && !bindingRejected && bindsThinking(opts.model) && /block_binding|beta/i.test(err.message || "")) {
      bindingRejected = true;
      return streamRaw({ ...opts, binding: false });
    }
    throw err;
  }
}

async function streamRaw({ model, system, messages, tools, noTools, signal, timeoutMs, onDelta, maxTokens, binding }) {
  const params = {
    model,
    max_tokens: maxTokens || MAX_TOKENS,
    thinking: {
      type: "adaptive",
      display: "summarized",
      ...(binding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {}),
    },
    output_config: { effort: EFFORT },
    ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
    messages,
    ...(tools?.length ? { tools, tool_choice: { type: noTools ? "none" : "auto" } } : {}),
    ...(binding ? { betas: [BINDING_BETA] } : {}),
  };
  const stream = bedrock().beta.messages.stream(params, { signal, timeout: timeoutMs });
  for await (const ev of stream) {
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      onDelta?.({ tool: ev.content_block.name });
    } else if (ev.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta" && ev.delta.text) onDelta?.({ content: ev.delta.text });
      else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) onDelta?.({ thinking: ev.delta.thinking });
    }
  }
  return stream.finalMessage();
}

// Try each model in the chain until one is enabled for this account.
async function withModels(model, run) {
  const chain = modelChain(model);
  const denied = [];
  for (const id of chain) {
    try {
      const res = await run(id);
      working = id;
      return { id, res };
    } catch (err) {
      if (err?.name === "AbortError" || /abort/i.test(err?.message || "")) throw err;
      if (noAccess(err) && id !== chain[chain.length - 1]) {
        denied.push(id);
        continue;
      }
      if (noAccess(err)) denied.push(id);
      const base = friendly(err);
      if (denied.length && noAccess(err)) {
        throw new Error(`No Bedrock model in the chain is enabled for this account (${denied.join(", ")}). Last error: ${base.message}`);
      }
      throw base;
    }
  }
  throw new Error("no Bedrock model configured");
}

/**
 * One agent turn on Bedrock. `messages` is the Ollama-style thread; `tools`
 * are Ollama function tools. `noTools` keeps the tool list (so earlier
 * tool_use blocks stay valid) but forbids new calls.
 * Returns { message: {role, content, thinking?, tool_calls?, _blocks}, model }.
 */
export async function bedrockChat({ model, messages, tools, allTools, noTools = false, signal, timeoutMs, onDelta, isControl = () => false }) {
  // Thinking is replayed from the last real user request onward (control
  // prompts such as the wrap-up note are part of that request).
  let keepFrom = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && !isControl(messages[i].content)) { keepFrom = i; break; }
  }
  const { system, messages: converted } = toAnthropicThread(messages, { keepThinkingFrom: keepFrom });
  const defs = toolDefs(allTools || tools);
  const forbid = noTools || !(tools && tools.length);
  const send = (id, msgs) => streamOnce({ model: id, system, messages: withCacheMarks(msgs), tools: defs, noTools: forbid, signal, timeoutMs, onDelta });
  const { id, res } = await withModels(model, async (id) => {
    const copy = structuredClone(converted);
    try {
      return await send(id, copy);
    } catch (err) {
      // Older models do not run the binding check and may reject a block
      // from another model: answer this turn without the old reasoning.
      if (err?.status === 400 && /thinking|signature/i.test(err.message || "")) {
        return send(id, stripThinking(structuredClone(converted)));
      }
      throw err;
    }
  });
  const blocks = (res.content || []).map((b) => {
    const { citations, ...rest } = b;
    return rest;
  });
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const thinking = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking || "").join("");
  const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
    id: b.id,
    function: { name: b.name, arguments: b.input || {} },
  }));
  const message = { role: "assistant", content: text, _blocks: blocks };
  if (thinking) message.thinking = thinking;
  if (calls.length) message.tool_calls = calls;
  if (res.stop_reason === "refusal") {
    const why = res.stop_details?.category ? ` (${res.stop_details.category})` : "";
    message.content = text || `The model declined this request${why}.`;
    delete message.tool_calls;
    message._blocks = [{ type: "text", text: message.content }];
  } else if (res.stop_reason === "max_tokens" && !calls.length) {
    message.content = `${text}\n\n(reply cut off at the ${MAX_TOKENS}-token limit)`;
  }
  return { message, model: id };
}

/** Plain one-shot text (analysis `ask`). Images are [{mime, dataB64}]. */
export async function askBedrock({ prompt, system, model, images, signal }) {
  const content = [
    ...(images || []).map((img) => ({ type: "image", source: { type: "base64", media_type: img.mime, data: img.dataB64 } })),
    textBlock(String(prompt)),
  ];
  const timeoutMs = Number(process.env.VKTECH_TIMEOUT_MS || 600_000);
  const { res } = await withModels(model, (id) => streamOnce({
    model: id, system, messages: [{ role: "user", content }], signal, timeoutMs,
  }));
  if (res.stop_reason === "refusal") return "(the model declined this request)";
  return (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim() || "(empty response)";
}
