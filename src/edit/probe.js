// Stage 1 — probe every clip in the input dir, sort chronologically.
import { readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { ffprobeJson } from "./ffmpeg.js";

const VIDEO_EXT = new Set([".mov", ".mp4", ".m4v", ".avi", ".mkv", ".hevc", ".webm"]);

// List candidate video files in a directory (non-recursive), case-insensitive ext.
export function listClips(dir) {
  return readdirSync(dir)
    .filter((f) => !f.startsWith(".") && VIDEO_EXT.has(extname(f).toLowerCase()))
    .map((f) => join(dir, f));
}

function fps(rate) {
  if (!rate || !rate.includes("/")) return 0;
  const [n, d] = rate.split("/").map(Number);
  return d > 0 ? Math.round(n / d) : 0;
}

function rotationOf(vstream) {
  // Newer ffmpeg exposes rotation in side_data_list; older in tags.rotate.
  for (const sd of vstream.side_data_list || []) {
    if (sd.rotation != null) return Number(sd.rotation) || 0;
  }
  const t = (vstream.tags || {}).rotate;
  return t != null ? Number(t) || 0 : 0;
}

// Probe a single clip into a normalized descriptor.
export async function probeClip(file) {
  const j = await ffprobeJson(file);
  const v = (j.streams || []).find((s) => s.codec_type === "video") || {};
  const a = (j.streams || []).find((s) => s.codec_type === "audio") || null;
  const ct =
    (j.format?.tags || {}).creation_time ||
    (v.tags || {}).creation_time ||
    null;
  return {
    file,
    duration: Number(j.format?.duration || 0),
    width: Number(v.width || 0),
    height: Number(v.height || 0),
    fps: fps(v.r_frame_rate),
    codec: v.codec_name || "?",
    rotation: rotationOf(v),
    hasAudio: !!a,
    creation_time: ct,
  };
}

// Probe all clips in a dir and return them sorted chronologically.
// Primary sort: creation_time (ISO). Fallback / tiebreak: filename.
export async function probeDir(dir, { signal } = {}) {
  const files = listClips(dir);
  if (files.length === 0) throw new Error(`no video clips found in ${dir}`);
  const clips = [];
  for (const f of files) {
    if (signal?.aborted) throw new Error("probe aborted");
    clips.push(await probeClip(f));
  }
  clips.sort((x, y) => {
    const tx = x.creation_time ? Date.parse(x.creation_time) : NaN;
    const ty = y.creation_time ? Date.parse(y.creation_time) : NaN;
    if (!Number.isNaN(tx) && !Number.isNaN(ty) && tx !== ty) return tx - ty;
    return x.file.localeCompare(y.file);
  });
  return clips;
}
