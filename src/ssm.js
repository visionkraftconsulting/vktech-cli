// Run a shell script on an AWS box through SSM (send-command + poll).
// For boxes with no inbound SSH, this is how the agent looks at them.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const SSM_PROFILE = process.env.VKTECH_AWS_PROFILE || "vk-admin";
export const SSM_REGION = process.env.VKTECH_AWS_REGION || "us-west-2";

// Friendly box names → instance ids. They are private, so they live in
// ~/.config/vktech/ssm-hosts.json ({"name": "i-..."}), extended or overridden
// by VKTECH_SSM_HOSTS='{"name":"i-..."}'.
export function ssmHosts() {
  const read = (text) => {
    try { return JSON.parse(text || "{}"); } catch { return {}; }
  };
  const file = join(homedir(), ".config", "vktech", "ssm-hosts.json");
  const local = existsSync(file) ? read(readFileSync(file, "utf8")) : {};
  return { ...local, ...read(process.env.VKTECH_SSM_HOSTS) };
}

export function defaultSsmHost() {
  return Object.keys(ssmHosts())[0] || "";
}

export function resolveSsmTarget(host) {
  const name = String(host || defaultSsmHost()).trim();
  if (!name) throw new Error("no SSM host given and none configured in ~/.config/vktech/ssm-hosts.json");
  if (/^i-[0-9a-f]{8,}$/.test(name)) return name;
  const id = ssmHosts()[name];
  if (!id) throw new Error(`unknown SSM host "${name}" (known: ${Object.keys(ssmHosts()).join(", ")})`);
  return id;
}

function aws(args, { signal, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("aws", [...args, "--profile", SSM_PROFILE, "--region", SSM_REGION, "--output", "json"],
      { signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || "").trim();
          if (/expired|sso|UnauthorizedSSOToken|Unable to locate credentials|token/i.test(msg)) {
            return reject(new Error(`AWS SSO session for profile ${SSM_PROFILE} is missing or expired. Ask the user to run: aws sso login --profile ${SSM_PROFILE}`));
          }
          if (err.code === "ENOENT") return reject(new Error("the aws CLI is not on PATH"));
          return reject(new Error(msg.split("\n").slice(-3).join(" ") || err.message));
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : {});
        } catch {
          resolve({ raw: stdout });
        }
      });
  });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("cancelled")); }, { once: true });
});

// Returns { status, stdout, stderr, exitCode }. The script runs as root under
// bash on the instance. SSM truncates each stream at ~24 KB.
export async function ssmRun({ host = defaultSsmHost(), script, timeoutMs = 180_000, signal } = {}) {
  if (!script || !String(script).trim()) throw new Error("empty script");
  const target = resolveSsmTarget(host);
  // A parameters file keeps quoting exact: the script reaches bash byte for byte.
  const dir = mkdtempSync(join(tmpdir(), "vktech-ssm-"));
  const file = join(dir, "params.json");
  let id;
  try {
    const seconds = String(Math.max(30, Math.ceil(timeoutMs / 1000)));
    writeFileSync(file, JSON.stringify({ commands: [String(script)], executionTimeout: [seconds] }));
    const sent = await aws(["ssm", "send-command", "--instance-ids", target,
      "--document-name", "AWS-RunShellScript", "--parameters", `file://${file}`,
      "--comment", "vktech agent"], { signal });
    id = sent?.Command?.CommandId;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!id) throw new Error("SSM did not return a command id");
  const deadline = Date.now() + timeoutMs + 15_000;
  let wait = 1500;
  while (Date.now() < deadline) {
    await sleep(wait, signal);
    wait = Math.min(5000, wait + 1000);
    let inv;
    try {
      inv = await aws(["ssm", "get-command-invocation", "--command-id", id, "--instance-id", target], { signal });
    } catch (err) {
      if (/InvocationDoesNotExist/.test(err.message)) continue;
      throw err;
    }
    if (["Pending", "InProgress", "Delayed"].includes(inv.Status)) continue;
    return {
      status: inv.Status,
      exitCode: inv.ResponseCode,
      stdout: inv.StandardOutputContent || "",
      stderr: inv.StandardErrorContent || "",
    };
  }
  throw new Error(`SSM command ${id} on ${host} did not finish in time`);
}

export function formatSsmResult(host, res) {
  const parts = [`${host} · ${res.status} · exit ${res.exitCode}`];
  if (res.stdout.trim()) parts.push(res.stdout.trimEnd());
  if (res.stderr.trim()) parts.push(`stderr:\n${res.stderr.trimEnd()}`);
  return parts.join("\n");
}
