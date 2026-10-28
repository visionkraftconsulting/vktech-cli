// "check replies" for the repo the user launched from.
// Each repo keeps its own Claude project memory. This reads that memory,
// checks the Mailcow mailboxes those notes name, and prints one status.
// It does not ask the local model to go looking. That search was hitting the
// Dell and listing directories.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redactText } from "./memories.js";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const DOMAIN_QUERY_RE = /(?:from|to|cc):([a-z0-9.-]+\.[a-z]{2,})/gi;
const OURS = new Set([
  "vktech.ai",
  "sgainvestments.com",
  "sgatrader.com",
  "chmstaffing.com",
  "heartsunitedcare.com",
  "globalworkforcepartners.co",
]);
// Mailboxes that live on mail.vktech.ai. Gmail domains are named in the
// report and are not queried with doveadm.
const MAILCOW = new Set(["vktech.ai", "sgainvestments.com"]);
// Personal inboxes and our own domains are not a vendor we are waiting on.
const NOISE = new Set([
  ...OURS,
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "hotmail.com",
  "yahoo.com",
  "outlook.com",
  "live.com",
  "vkpay.dev",
  "visionkraftconsulting.com",
]);
const RULE_FILE = /hand-sent|sender-identity|email-signature|subject-encoding|always-check-email|quote-history|outbound-email/;
const GROUPS = [
  ["Remittance", /remit|nium|thunes|cellulant|mpesa|m-pesa/gi],
  ["Payroll", /payroll|everee|gusto|zeal|checkhq|worklio|rollfi|\bsalsa\b/gi],
  ["VA / EDI", /pgba|\bedi\b|va[- ]billing|palmetto|trading partner/gi],
  ["Payment processing", /payment|finix|payfac|\bnmi\b|stax|worldpay|payout/gi],
];

function home() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function encodePath(abs) {
  return String(abs || "").replace(/[^A-Za-z0-9]/g, "-");
}

function safeRead(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function domainOf(address) {
  const at = String(address || "").toLowerCase().lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}

function isOurs(addressOrDomain) {
  const domain = addressOrDomain.includes("@") ? domainOf(addressOrDomain) : String(addressOrDomain || "").toLowerCase();
  if (!domain) return false;
  if (OURS.has(domain)) return true;
  for (const own of OURS) if (domain.endsWith(`.${own}`)) return true;
  return false;
}

function uniq(list) {
  const out = [];
  for (const item of list) {
    const value = String(item || "").trim();
    if (!value) continue;
    if (!out.some((have) => have.toLowerCase() === value.toLowerCase())) out.push(value);
  }
  return out;
}

export function isReplyCheck(input) {
  const text = String(input || "").trim();
  if (!text || text.length > 80 || /[\n/`\\]/.test(text)) return false;
  const match = text.match(/^(?:please\s+)?(?:can you\s+|could you\s+)?check(?:\s+(?:on|for|the))?\s+repl(?:y|ies)\b(.*)$/i);
  if (!match) return false;
  const rest = match[1].trim().replace(/[.!?]+$/, "");
  if (!rest) return true;
  // "check replies for payroll" narrows the report. A coding ask that merely
  // starts with those words does not.
  if (!/^(?:for|on|about|regarding)\s+\S/i.test(rest)) return false;
  if (/\b(handler|function|bug|fix|code|file|component|test|implement|refactor)\b/i.test(rest)) return false;
  return true;
}

// Optional words after the phrase, so "check replies for payroll" narrows
// the tracks. The check still uses only this repo's memory.
export function replyFocus(input) {
  const text = String(input || "").trim();
  const match = text.match(/repl(?:y|ies)\b\s*(.*)$/i);
  return String(match?.[1] || "").replace(/^(?:for|on|about|regarding)\s+/i, "").replace(/[.!?]+$/, "").trim();
}

export function claudeProjectMemory(cwd, { projectsRoot } = {}) {
  if (!cwd) return null;
  let dir;
  try {
    dir = realpathSync(cwd);
  } catch {
    return null;
  }
  const root = projectsRoot || join(home(), ".claude", "projects");
  const stop = dirname(home() || "/");
  while (dir && dir !== stop && dir !== dirname(dir)) {
    const memory = join(root, encodePath(dir), "memory");
    if (existsSync(memory)) {
      return { dir, name: basename(dir), memory };
    }
    dir = dirname(dir);
  }
  return null;
}

function indexHints(memoryDir) {
  const hints = new Map();
  for (const line of safeRead(join(memoryDir, "MEMORY.md")).split("\n")) {
    const match = line.match(/^- \[(.+?)\]\(([^)]+)\)\s*(?:—|–|-)\s*(.*)$/);
    if (!match) continue;
    hints.set(basename(match[2]), { title: match[1].replace(/^⚠️\s*|^⏳\s*/, ""), hint: match[3] || "" });
  }
  return hints;
}

function frontMatter(body) {
  const match = String(body || "").match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const description = match[1].match(/^description:\s*(?:"([\s\S]*?)"|(.+))$/m);
  return { description: (description?.[1] || description?.[2] || "").trim() };
}

function emailsIn(text) {
  return uniq(String(text || "").match(EMAIL_RE) || []).map((address) => address.toLowerCase());
}

function noiseDomain(domain) {
  const name = String(domain || "").toLowerCase();
  if (!name || NOISE.has(name)) return true;
  if (name === "gmail.com" || name.endsWith(".gmail.com")) return true;
  for (const own of OURS) if (name === own || name.endsWith(`.${own}`)) return true;
  return false;
}

function partyDomains(text, emails) {
  const domains = [];
  for (const address of emails) {
    const local = address.split("@")[0];
    if (local.length > 40 || /\d{5,}/.test(local)) continue;
    const domain = domainOf(address);
    if (domain && !noiseDomain(domain)) domains.push(domain);
  }
  for (const match of String(text || "").matchAll(DOMAIN_QUERY_RE)) {
    const domain = match[1].toLowerCase();
    if (!noiseDomain(domain)) domains.push(domain);
  }
  return uniq(domains);
}

// A product note can mention an address in passing. A tracked thread says
// how the mail was sent or where a reply would show up.
function isThread(body) {
  return /doveadm|mailbox INBOX|\bINBOX uid\b|watch replies|replies go to|newer_than:|\bfrom:|sent from|reply sent|no reply yet|outreach\s+20\d{2}/i.test(body);
}

function usableMailbox(address) {
  if (!MAILCOW.has(domainOf(address))) return false;
  const local = address.split("@")[0];
  if (local.length > 32 || /\d{5,}/.test(local)) return false;
  return true;
}

function senderMailboxes(text) {
  const found = [];
  const lower = text.toLowerCase();
  for (const address of emailsIn(text)) {
    if (!usableMailbox(address)) continue;
    let at = 0;
    while (at >= 0) {
      const hit = lower.indexOf(address, at);
      if (hit < 0) break;
      const before = lower.slice(Math.max(0, hit - 48), hit);
      if (/(?:from|mailbox|-u)\b/.test(before)) {
        found.push(address);
        break;
      }
      at = hit + address.length;
    }
  }
  return uniq(found);
}

function hitCount(re, text) {
  const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return (String(text || "").match(copy) || []).length;
}

export function trackGroup(track) {
  const blob = `${track.title} ${track.fileName} ${track.hint} ${track.parties.join(" ")}`;
  let best = "Other";
  let bestHits = 0;
  for (const [name, re] of GROUPS) {
    const hits = hitCount(re, blob);
    if (hits > bestHits) {
      best = name;
      bestHits = hits;
    }
  }
  return best;
}

function trackScore(fileName, body) {
  if (RULE_FILE.test(fileName)) return 0;
  const parties = partyDomains(body, emailsIn(body));
  if (!parties.length || !isThread(body)) return 0;
  let score = 4;
  if (/\b(repl(?:y|ies|ied)|inbox|mailbox|doveadm|outreach|follow[- ]up)\b/i.test(body)) score += 3;
  if (/\b(sent|emailed)\b/i.test(body)) score += 1;
  if (/reply|email|mail|rfp|follow|edi|outreach/i.test(fileName)) score += 1;
  return score;
}

export function selectTracks(memoryDir) {
  if (!memoryDir || !existsSync(memoryDir)) return [];
  const hints = indexHints(memoryDir);
  let names = [];
  try {
    names = readdirSync(memoryDir);
  } catch {
    return [];
  }
  const tracks = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name === "MEMORY.md") continue;
    const body = safeRead(join(memoryDir, name));
    const score = trackScore(name, body);
    if (score < 5) continue;
    const emails = emailsIn(body);
    const parties = partyDomains(body, emails);
    const addresses = emails.filter((address) => !NOISE.has(domainOf(address)) && !isOurs(address));
    const indexed = hints.get(name);
    const meta = frontMatter(body);
    const title = indexed?.title || meta.description?.slice(0, 80) || name.replace(/\.md$/, "").replaceAll("-", " ");
    const mailboxes = senderMailboxes(body);
    const gmail = /\bgmail\b/i.test(body) && !/doveadm|mailcow|mail-vk/i.test(body) && mailboxes.length === 0;
    const track = {
      title,
      hint: indexed?.hint || "",
      fileName: name,
      score,
      parties,
      domainCounts: Object.fromEntries(parties.map((domain) => {
        const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return [domain, (body.toLowerCase().match(new RegExp(escaped, "g")) || []).length];
      })),
      addresses,
      labels: uniq(parties.map((domain) => domain.split(".")[0])).filter((label) => label.length >= 4),
      mailboxes,
      channel: gmail ? "gmail" : (mailboxes.length ? "mailcow" : "unknown"),
      note: lastNoteLine(body),
    };
    track.group = trackGroup(track);
    tracks.push(track);
  }
  tracks.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return tracks.slice(0, 12);
}

function lastNoteLine(body) {
  const lines = String(body || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].replace(/\s+/g, " ").trim();
    if (!raw || raw.startsWith("---") || /^name:|^description:|^metadata:|^type:/.test(raw)) continue;
    if (!/\b20\d{2}-\d{2}-\d{2}\b/.test(raw)) continue;
    if (/doveadm|docker compose|ssh |SELECT |INSERT /i.test(raw)) continue;
    const clean = raw
      .replace(/^[-*]\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`/g, "");
    if (clean.length < 24 || clean.endsWith(":")) continue;
    if (/\b(token|password|secret|api[_-]?key)\b/i.test(clean)) continue;
    return clean.length > 180 ? `${clean.slice(0, 177)}…` : clean;
  }
  return "";
}

function validBox(address) {
  return /^[a-z0-9._+-]+@[a-z0-9.-]+$/i.test(address) && MAILCOW.has(domainOf(address));
}

export function mailcowScript(mailboxes, since) {
  const boxes = uniq(mailboxes).filter(validBox);
  const day = String(since || "").match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  if (!boxes.length || !day) return "";
  const lines = [
    "set +e",
    "cd /opt/mailcow-dockerized 2>/dev/null || exit 3",
    "if docker compose version >/dev/null 2>&1; then DC='docker compose'; else DC='docker-compose'; fi",
  ];
  for (const box of boxes) {
    for (const folder of ["INBOX", "Sent"]) {
      lines.push(`echo @@BEGIN ${box} ${folder}`);
      lines.push(`$DC exec -T dovecot-mailcow doveadm fetch -u ${shellQuote(box)} "uid date.received hdr.from hdr.to hdr.cc hdr.subject" mailbox ${folder} SINCE ${day}`);
      lines.push("echo @@END $?");
    }
  }
  return `${lines.join("\n")}\n`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function parseMailDump(text) {
  const messages = [];
  let mailbox = "";
  let folder = "";
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.from || cur.subject || cur.date) messages.push(cur);
    cur = null;
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const mark = line.match(/^@@BEGIN\s+(\S+)\s+(\S+)\s*$/);
    if (mark) {
      flush();
      mailbox = mark[1];
      folder = mark[2];
      continue;
    }
    if (line.startsWith("@@END")) {
      flush();
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9.]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key === "uid") {
      flush();
      cur = { uid: kv[2].trim(), from: "", to: "", cc: "", subject: "", date: "", mailbox, folder };
      continue;
    }
    if (!cur) cur = { uid: "", from: "", to: "", cc: "", subject: "", date: "", mailbox, folder };
    if (key === "date.received" || key === "date.sent") cur.date = kv[2].trim();
    else if (key === "hdr.from") cur.from = kv[2].trim();
    else if (key === "hdr.to") cur.to = kv[2].trim();
    else if (key === "hdr.cc") cur.cc = kv[2].trim();
    else if (key === "hdr.subject") cur.subject = kv[2].trim();
  }
  flush();
  return messages;
}

function zoneOffset(zone) {
  const text = String(zone || "").replace(/\s/g, "");
  const compact = text.match(/^([+-])(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}${compact[2]}:${compact[3]}`;
  if (/^([+-]\d{2}:\d{2}|Z)$/.test(text)) return text;
  return "Z";
}

function parseWhen(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = text.replace(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*\(([^)]+)\))?/,
    (_, day, time, zone) => `${day}T${time}${zoneOffset(zone)}`,
  );
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWhen(date) {
  if (!date) return "undated";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function decodeWords(value) {
  const text = String(value || "").replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, encoding, data) => {
    try {
      if (String(encoding).toLowerCase() === "q") {
        const raw = data.replace(/_/g, " ");
        const bytes = [];
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(raw.slice(i + 1, i + 3))) {
            bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            bytes.push(raw.charCodeAt(i) & 0xff);
          }
        }
        const label = String(charset || "utf-8").toLowerCase();
        return Buffer.from(bytes).toString(label === "utf-8" || label === "utf8" ? "utf8" : "latin1");
      }
      return Buffer.from(data, "base64").toString("utf8");
    } catch {
      return data;
    }
  });
  return text.replace(/\s+/g, " ").trim();
}

function who(header) {
  const text = decodeWords(header).trim();
  if (!text) return "unknown";
  const named = text.match(/^"?([^"<]+?)"?\s*</);
  if (named && named[1].trim()) return named[1].trim();
  const address = text.match(EMAIL_RE);
  return address ? address[0] : text.slice(0, 48);
}

function direction(message) {
  if (String(message.folder || "").toLowerCase() === "sent") return "out";
  const from = (String(message.from).match(EMAIL_RE) || [])[0] || "";
  if (from && isOurs(from)) return "out";
  return "in";
}

function matchScore(track, message) {
  const blob = `${message.from} ${message.to} ${message.cc} ${message.subject}`.toLowerCase();
  let score = 0;
  for (const address of track.addresses || []) if (blob.includes(address)) score += 5;
  for (const domain of track.parties) if (blob.includes(domain)) score += 3;
  for (const label of track.labels) {
    if (label.length >= 4 && blob.includes(label)) score += 1;
  }
  return score;
}

function assignMessages(tracks, messages) {
  const byTrack = new Map(tracks.map((track) => [track, []]));
  for (const message of messages) {
    const blob = `${message.from} ${message.to} ${message.cc} ${message.subject}`.toLowerCase();
    const scored = [];
    for (const track of tracks) {
      const score = matchScore(track, message);
      if (score <= 0) continue;
      let weight = 0;
      for (const domain of track.parties) {
        if (blob.includes(domain)) weight += track.domainCounts?.[domain] || 1;
      }
      scored.push({ track, score, weight });
    }
    if (!scored.length) continue;
    const best = Math.max(...scored.map((hit) => hit.score));
    const top = scored.filter((hit) => hit.score === best);
    const bestWeight = Math.max(...top.map((hit) => hit.weight));
    for (const hit of top) {
      if (hit.weight === bestWeight) byTrack.get(hit.track).push(message);
    }
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => (parseWhen(b.date)?.getTime() || 0) - (parseWhen(a.date)?.getTime() || 0));
  }
  return byTrack;
}

function clip(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function focusHits(track, focus) {
  if (!focus) return true;
  const blob = `${track.group} ${track.title} ${track.hint} ${track.parties.join(" ")} ${track.fileName}`.toLowerCase();
  return focus.toLowerCase().split(/\s+/).filter((word) => word.length >= 3).every((word) => blob.includes(word));
}

export function formatReport({ project, tracks, messages, mailError, since, checkedAt, focus }) {
  const name = project?.name || "this repo";
  const when = formatWhen(checkedAt || new Date());
  const lines = [
    `Replies · ${name}`,
    project?.dir ? `Memory  ${project.dir}` : "Memory  none",
  ];
  if (mailError) lines.push(`Mail    not checked (${clip(mailError, 140)})`);
  else lines.push(`Mail    mail.vktech.ai · ${when} PT · since ${since}`);
  lines.push("Each repo uses its own Claude memory. Other projects are not included.");
  lines.push("");

  let shown = tracks;
  if (focus) {
    const narrowed = tracks.filter((track) => focusHits(track, focus));
    if (narrowed.length) shown = narrowed;
    else lines.push(`No track matched "${focus}". Showing every tracked thread in this repo.`, "");
  }
  if (!shown.length) {
    lines.push("No tracked integration email in this repo's Claude memory.");
    return redactText(lines.join("\n"));
  }

  const groups = [];
  for (const track of shown) {
    let group = groups.find((item) => item.name === track.group);
    if (!group) {
      group = { name: track.group, tracks: [] };
      groups.push(group);
    }
    group.tracks.push(track);
  }
  const order = ["Payment processing", "Payroll", "Remittance", "VA / EDI", "Other"];
  groups.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  const assigned = assignMessages(shown, messages || []);
  for (const group of groups) {
    lines.push(group.name);
    for (const track of group.tracks) {
      lines.push(`  ${track.title}`);
      if (track.mailboxes.length) lines.push(`  Watching   ${track.mailboxes.join(", ")}`);
      if (track.parties.length) lines.push(`  Parties    ${track.parties.join(", ")}`);
      const hits = assigned.get(track) || [];
      if (track.channel === "gmail") {
        lines.push("  Channel    Gmail. This check reads Mailcow only, so this thread was not fetched.");
      }
      if (mailError && track.channel !== "gmail") {
        lines.push("  Mail       not checked.");
      } else if (!hits.length) {
        lines.push(track.channel === "gmail"
          ? "  Mail       not fetched from Gmail."
          : `  Mail       no matching message since ${since}.`);
      } else {
        for (const message of hits.slice(0, 3)) {
          const way = direction(message) === "out" ? "out" : "in ";
          lines.push(`  ${formatWhen(parseWhen(message.date)).padEnd(18)} ${way}  ${clip(who(message.from), 36)}`);
          lines.push(`  ${"".padEnd(24)}${clip(decodeWords(message.subject) || "(no subject)", 68)}`);
        }
        const newest = hits[0];
        lines.push(direction(newest) === "in"
          ? "  Status     their note is newer. Waiting on us."
          : "  Status     our note is newer. Waiting on them.");
      }
      if (track.note) lines.push(`  Last note  ${track.note}`);
      lines.push("");
    }
  }
  return redactText(lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd());
}

function defaultRun(script) {
  const host = process.env.VKTECH_MAIL_HOST || "mail-vk";
  const timeout = Number(process.env.VKTECH_MAIL_TIMEOUT_MS || 45_000);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("ssh", [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=12",
        host,
        "bash", "-s",
      ], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 1, out: "", err: err.message });
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      err += "\ntimed out";
    }, timeout);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, out, err: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
    child.stdin.end(script);
  });
}

function sinceDay(now, days) {
  const date = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

export async function checkReplies({ cwd = process.cwd(), projectsRoot, run, now = new Date(), days = 45, focus = "", detailed = false } = {}) {
  const project = claudeProjectMemory(cwd, { projectsRoot });
  if (!project) {
    const report = [
      "Replies",
      `No Claude memory for ${cwd} or its parent folders.`,
      "Run this from the repo you want checked. vkPay and vkWorkforce each keep their own notes.",
    ].join("\n");
    return detailed ? { report, notes: "" } : report;
  }
  const tracks = selectTracks(project.memory);
  const since = sinceDay(now, days);
  const mailboxes = uniq(tracks.flatMap((track) => track.mailboxes));
  let messages = [];
  let mailError = "";
  if (mailboxes.length) {
    const script = mailcowScript(mailboxes, since);
    try {
      const result = await (run || defaultRun)(script);
      messages = parseMailDump(result.out);
      if (!messages.length && result.code) {
        const detail = String(result.err || `ssh exited ${result.code}`).split("\n").map((line) => line.trim()).filter(Boolean)[0];
        mailError = detail || "mail host did not answer";
      }
    } catch (err) {
      mailError = err.message;
    }
  } else if (tracks.some((track) => track.channel === "gmail")) {
    mailError = "this repo's threads are in Gmail, not Mailcow";
  }
  const report = formatReport({
    project,
    tracks,
    messages,
    mailError,
    since,
    checkedAt: now,
    focus,
  });
  if (!detailed) return report;
  return { report, notes: trackNotes(project.memory, tracks, focus) };
}

// The memory notes behind the threads in the report, for the summary. The
// report shows one clipped "Last note" per thread; the summary needs the
// recent history (what we asked, what they said, what is blocked).
export function trackNotes(memoryDir, tracks, focus = "", maxPerNote = 2500, maxTotal = 12_000) {
  let shown = tracks || [];
  if (focus) {
    const narrowed = shown.filter((track) => focusHits(track, focus));
    if (narrowed.length) shown = narrowed;
  }
  const parts = [];
  let room = maxTotal;
  for (const track of shown) {
    if (room < 300) break;
    const body = redactText(safeRead(join(memoryDir, track.fileName))).replace(/^---[\s\S]*?\n---\n/, "").trim();
    if (!body) continue;
    const cap = Math.min(maxPerNote, room);
    // Newest facts are appended last, so keep the tail.
    const text = body.length > cap ? `…${body.slice(-cap)}` : body;
    parts.push(`## ${track.title}\n${text}`);
    room -= text.length;
  }
  return parts.join("\n\n");
}

// "check replies" ends with a written answer, like any other agent turn: the
// table above is the evidence, this is the conclusion.
export const SUMMARY_SYSTEM = [
  "You write the closing summary of a \"check replies\" mail report for a small business owner.",
  "Use only facts from the report and the memory notes you are given. Never invent a reply, a date, a person or a deadline.",
  "The report shows each message's sender, date and subject only. Do not claim to know what a message body says.",
  "\"in\" means they wrote to us and \"out\" means we wrote to them. \"Their note is newer\" means we owe a reply.",
  "",
  "Format, in Markdown:",
  "- First line: **Bottom line:** then one or two sentences: which threads are waiting on us, which are waiting on them, and the most urgent item.",
  "- Then one heading per thread: \"### <thread> (<two to five word status>)\".",
  "- Under each heading, two to four bullets that start with \"- \". Name the sender, date and subject when you cite a message.",
  "- Use plain status words in each bullet: confirmed, approved, waiting on us, waiting on them, needs a reply, blocked, not sent, deadline, at risk. Do not type ✓, ✗ or ! yourself; the terminal adds them from those words.",
  "- End with \"### Next steps (proposals, not sent)\" and one to four numbered items, most urgent first.",
  "- Last line: \"I did not send any email or change anything.\"",
  "Keep it short and concrete. Plain words, full sentences, no raw tables.",
].join("\n");

export function summaryPrompt({ report, notes = "" }) {
  return [
    "Mail report:",
    "```",
    String(report || "").trim(),
    "```",
    notes ? `\nMemory notes for these threads (newest facts are usually last):\n\n${notes}` : "",
    "\nWrite the summary now.",
  ].join("\n");
}

// No summary when there is nothing to summarize.
export function wantsSummary(report) {
  const text = String(report || "");
  if (process.env.VKTECH_REPLIES_SUMMARY === "0") return false;
  return !/No tracked integration email|No Claude memory for/.test(text);
}

export async function summarizeReplies({ report, notes, ask, modelArg, signal }) {
  const out = await ask({ modelArg, prompt: summaryPrompt({ report, notes }), system: SUMMARY_SYSTEM, signal });
  return { ...out, text: String(out?.text || "").trim() };
}
