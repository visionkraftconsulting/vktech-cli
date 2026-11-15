// vkPilot account for vktech CLI subscribers.
//
// `vktech login` pairs this machine with a vkPilot account (pilot.vktech.ai).
// It works like device pairing: the CLI asks for a 6-digit code, the user
// approves it in the browser, and the CLI receives a personal `vkt_` token.
// The token is stored in ~/.config/vktech/vkpilot.json (mode 0600).
//
// When a token is present, Claude calls go through the vkPilot relay
// (`<base>/api/cli/v1/messages`, an Anthropic Messages-compatible endpoint).
// vkPilot holds the AWS credentials, checks the subscription, and meters
// usage, so subscribers need no AWS account of their own.
// VKTECH_BEDROCK_DIRECT=1 skips the relay and uses the local AWS profile.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PILOT_URL = (process.env.VKTECH_PILOT_URL || "https://pilot.vktech.ai").replace(/\/+$/, "");
export const SUBSCRIBE_URL = `${PILOT_URL}/vktech`;
const FILE = process.env.VKTECH_PILOT_FILE || join(homedir(), ".config", "vktech", "vkpilot.json");

export function loadAccount() {
  if (process.env.VKTECH_PILOT_TOKEN) {
    return { baseUrl: PILOT_URL, token: process.env.VKTECH_PILOT_TOKEN };
  }
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8"));
    return data?.token ? { baseUrl: PILOT_URL, ...data } : null;
  } catch {
    return null;
  }
}

function saveAccount(data) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

export function useRelay() {
  if (/^(1|true|yes)$/i.test(process.env.VKTECH_BEDROCK_DIRECT || "")) return false;
  return Boolean(loadAccount()?.token);
}

async function api(path, { method = "GET", body, token, signal } = {}) {
  const res = await fetch(`${PILOT_URL}${path}`, {
    method,
    signal: signal || AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.raw || res.statusText;
    const err = new Error(`${res.status} ${typeof msg === "string" ? msg.slice(0, 300) : JSON.stringify(msg)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* the URL is printed anyway */ }
}

/** Pair this machine with a vkPilot account. `print` writes a line. */
export async function login({ print = console.log, version = "", noBrowser = false } = {}) {
  const start = await api("/api/cli/pair/start", { method: "POST", body: { client: "vktech-cli", version } });
  const url = start.verifyUrl || `${PILOT_URL}/vktech/pair?code=${start.code}`;
  print(`Your code: ${start.code}`);
  print(`Approve it at ${url}`);
  if (!noBrowser) openBrowser(url);
  const deadline = Date.now() + Number(start.expiresIn || 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let poll;
    try {
      poll = await api("/api/cli/pair/poll", { method: "POST", body: { pollToken: start.pollToken } });
    } catch (err) {
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      continue;
    }
    if (poll.status === "approved" && poll.token) {
      const account = { token: poll.token, email: poll.email || "", pairedAt: new Date().toISOString() };
      saveAccount(account);
      try {
        const info = await me();
        saveAccount({ ...account, email: info.email || account.email, plan: info.plan, defaultModel: info.defaultModel });
        return info;
      } catch {
        return account;
      }
    }
    if (poll.status === "denied" || poll.status === "expired") throw new Error(`pairing ${poll.status}`);
  }
  throw new Error("pairing timed out. Run vktech login again.");
}

export function logout() {
  const had = existsSync(FILE);
  if (had) rmSync(FILE);
  return had;
}

/** { email, plan, models, defaultModel, usage:{usedUsd, includedUsd, resetsAt} } */
export async function me() {
  const account = loadAccount();
  if (!account?.token) throw new Error("not signed in. Run: vktech login");
  return api("/api/cli/me", { token: account.token });
}

// Relay errors, in plain words, with where to fix them.
export function relayError(err) {
  const status = err?.status;
  const msg = String(err?.error?.error?.message || err?.message || err);
  if (status === 401) return new Error(`Your vkPilot sign-in is no longer valid. Run: vktech login`);
  if (status === 402 || (status === 403 && /subscri|usage|plan|credit/i.test(msg))) {
    return new Error(`${msg.replace(/^\d+\s*/, "")} Manage your plan at ${SUBSCRIBE_URL}`);
  }
  return null;
}
