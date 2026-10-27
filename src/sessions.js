// Saved REPL conversations. One JSON file per session under
// ~/.config/vktech/sessions/. The REPL resumes the newest session for the
// current directory so the chat is still there after you quit.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TRANSCRIPT_CAP = 200;
// Same-millisecond saves still sort newest-first. String timestamps compare
// correctly once the milliseconds differ.
let savedAt = 0;
function stamp() {
  const ms = Math.max(Date.now(), savedAt + 1);
  savedAt = ms;
  return new Date(ms).toISOString();
}

function configDir() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".config", "vktech");
}

export function sessionsDir() {
  return join(configDir(), "sessions");
}

function sessionPath(id) {
  return join(sessionsDir(), `${id}.json`);
}

export function createSession(cwd) {
  const now = new Date().toISOString();
  return {
    id: `${now.replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}`,
    cwd,
    title: "",
    model: "",
    created: now,
    updated: now,
    transcript: [],
    messages: [],
  };
}

export function saveSession(session) {
  if (!session?.id) return;
  mkdirSync(sessionsDir(), { recursive: true });
  session.updated = stamp();
  if (session.transcript && session.transcript.length > TRANSCRIPT_CAP) {
    session.transcript.splice(0, session.transcript.length - TRANSCRIPT_CAP);
  }
  // Write aside and rename so a crash mid-save cannot tear the session the
  // next launch resumes.
  const file = sessionPath(session.id);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(session));
  renameSync(tmp, file);
}

export function loadSession(id) {
  const file = sessionPath(id);
  if (!id || !existsSync(file)) return null;
  try {
    const session = JSON.parse(readFileSync(file, "utf8"));
    if (!session || session.id !== id) return null;
    session.transcript ||= [];
    session.messages ||= [];
    // A kill mid-turn leaves the in-progress row marked live. It is history now.
    for (const row of session.transcript) {
      if (row && row.live) delete row.live;
    }
    return session;
  } catch {
    return null;
  }
}

export function listSessions(cwd) {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const session = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (cwd && session.cwd !== cwd) continue;
      if (!session.id) continue;
      rows.push({
        id: session.id,
        title: session.title || "(untitled)",
        updated: session.updated || "",
        cwd: session.cwd || "",
        turns: Array.isArray(session.transcript) ? session.transcript.length : 0,
      });
    } catch {
      // Skip a torn write. The next save replaces it.
    }
  }
  rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return rows;
}

export function latestSession(cwd) {
  const [newest] = listSessions(cwd);
  return newest ? loadSession(newest.id) : null;
}

// meta.via ("provider:model") is shown as the turn's tag when it is replayed.
export function appendTranscript(session, role, text, meta = {}) {
  const body = String(text || "").trim();
  if (!body) return;
  session.transcript ||= [];
  const row = { role, text: body, at: new Date().toISOString() };
  if (meta.via) row.via = String(meta.via);
  session.transcript.push(row);
  if (!session.title && role === "user") session.title = body.slice(0, 80);
  if (session.transcript.length > TRANSCRIPT_CAP) {
    session.transcript.splice(0, session.transcript.length - TRANSCRIPT_CAP);
  }
}

// One assistant row for the turn that is still running. Later checkpoints
// replace it so a quit mid-command resumes that same turn, and a finished
// turn does not stack a second copy.
export function upsertLiveTranscript(session, text, final = false) {
  const body = String(text || "").trim();
  if (!body) return;
  session.transcript ||= [];
  const last = session.transcript[session.transcript.length - 1];
  if (last?.role === "assistant" && last.live) {
    last.text = body;
    last.at = new Date().toISOString();
    if (final) delete last.live;
    return;
  }
  const row = { role: "assistant", text: body, at: new Date().toISOString() };
  if (!final) row.live = true;
  session.transcript.push(row);
  if (session.transcript.length > TRANSCRIPT_CAP) {
    session.transcript.splice(0, session.transcript.length - TRANSCRIPT_CAP);
  }
}

function lineHistoryPath() {
  return join(configDir(), "line-history.json");
}

export function loadLineHistory() {
  try {
    const rows = JSON.parse(readFileSync(lineHistoryPath(), "utf8"));
    return Array.isArray(rows) ? rows.filter((row) => typeof row === "string").slice(-200) : [];
  } catch {
    return [];
  }
}

export function saveLineHistory(lines) {
  mkdirSync(configDir(), { recursive: true });
  const rows = (lines || []).filter((row) => typeof row === "string" && row.trim()).slice(-200);
  writeFileSync(lineHistoryPath(), JSON.stringify(rows));
}
