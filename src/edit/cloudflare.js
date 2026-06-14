// Cloudflare DNS provisioning for the vktech edit engine (premium feature).
// Upserts a proxied A record so a freshly-rendered video site/preview gets a
// live subdomain automatically. Mirrors vkTech infra/cloudflare/dns.sh.
//
// Env (loaded by the CLI from ~/.config/vktech/.env or the project .env):
//   CLOUDFLARE_API_TOKEN   (required) — scoped DNS-edit token
//   CLOUDFLARE_ZONE_ID     (required) — the vktech.ai zone
//   CLOUDFLARE_DOMAIN      (optional) — apex, default vktech.ai
// Paid gate: VKTECH_LICENSE (or VKTECH_PRO=1) must be set.

const API = "https://api.cloudflare.com/client/v4";

export function isLicensed() {
  return !!(process.env.VKTECH_LICENSE || process.env.VKTECH_PRO);
}

function requireLicense() {
  if (!isLicensed()) {
    throw new Error(
      "Cloudflare publishing is a paid feature. Set VKTECH_LICENSE (or VKTECH_PRO=1) in your vktech env."
    );
  }
}

function cfg() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  const domain = process.env.CLOUDFLARE_DOMAIN || "vktech.ai";
  if (!token || !zone) {
    throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID in your vktech env.");
  }
  return { token, zone, domain };
}

async function cf(path, { token, method = "GET", body, signal } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const msg = (json.errors || []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API: ${msg}`);
  }
  return json.result;
}

// Resolve a possibly-bare name into a FQDN under the zone domain.
// "video" -> "video.vktech.ai"; "video.vktech.ai" stays as-is.
export function fqdn(name, domain) {
  const n = String(name).trim().replace(/\.$/, "");
  if (n === domain || n.endsWith(`.${domain}`)) return n;
  return `${n}.${domain}`;
}

// Create or update a proxied A record `name` -> `ip`. Idempotent.
export async function upsertA(name, ip, { proxied = true, signal } = {}) {
  requireLicense();
  const { token, zone, domain } = cfg();
  const fqn = fqdn(name, domain);

  const existing = await cf(`/zones/${zone}/dns_records?type=A&name=${encodeURIComponent(fqn)}`, { token, signal });
  const record = { type: "A", name: fqn, content: ip, proxied, ttl: 1 };

  let result, action;
  if (existing.length) {
    action = "updated";
    result = await cf(`/zones/${zone}/dns_records/${existing[0].id}`, { token, method: "PUT", body: record, signal });
  } else {
    action = "created";
    result = await cf(`/zones/${zone}/dns_records`, { token, method: "POST", body: record, signal });
  }
  return { action, name: result.name, content: result.content, proxied: result.proxied };
}

// Remove an A record by name (for teardown). No-op if absent.
export async function removeA(name, { signal } = {}) {
  requireLicense();
  const { token, zone, domain } = cfg();
  const fqn = fqdn(name, domain);
  const existing = await cf(`/zones/${zone}/dns_records?type=A&name=${encodeURIComponent(fqn)}`, { token, signal });
  if (!existing.length) return { action: "absent", name: fqn };
  await cf(`/zones/${zone}/dns_records/${existing[0].id}`, { token, method: "DELETE", signal });
  return { action: "deleted", name: fqn };
}
