// Low-level ffmpeg/ffprobe wrapper for the vktech edit engine.
// Mirrors src/run.js conventions: spawn + Promise-on-close, ENOENT -> clear error.
// No shell interpolation — args are passed as an array.
import { spawn } from "node:child_process";
import { platform } from "node:os";

const NULL_DEVICE = platform() === "win32" ? "NUL" : "/dev/null";
export { NULL_DEVICE };

// Run a binary with an args array. Returns { code, stdout, stderr }.
// stdio is captured (not inherited) so callers can parse output; pass
// onStderr to stream progress lines live.
export function run(bin, args, { signal, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") reject(new Error(`${bin} not found on PATH — install ffmpeg`));
      else reject(err);
    });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

// Run ffmpeg, rejecting on nonzero exit with the tail of stderr for diagnostics.
export async function ffmpeg(args, opts = {}) {
  const r = await run("ffmpeg", ["-nostdin", "-hide_banner", ...args], opts);
  if (r.code !== 0) {
    const tail = r.stderr.trim().split("\n").slice(-6).join("\n");
    throw new Error(`ffmpeg failed (exit ${r.code}):\n${tail}`);
  }
  return r;
}

// ffprobe a file -> parsed JSON (format + streams).
export async function ffprobeJson(file) {
  const r = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    file,
  ]);
  if (r.code !== 0) {
    const tail = r.stderr.trim().split("\n").slice(-3).join("\n");
    throw new Error(`ffprobe failed for ${file} (exit ${r.code}):\n${tail}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`ffprobe returned unparseable JSON for ${file}`);
  }
}

// Detect available encoders/filters once, cached.
let _caps = null;
export async function capabilities() {
  if (_caps) return _caps;
  const enc = await run("ffmpeg", ["-hide_banner", "-encoders"]);
  const filt = await run("ffmpeg", ["-hide_banner", "-filters"]);
  if (enc.code !== 0) throw new Error("ffmpeg not runnable — cannot detect encoders");
  const has = (txt, name) => new RegExp(`\\b${name}\\b`).test(txt);
  _caps = {
    platform: platform(),
    encoders: {
      hevc_videotoolbox: has(enc.stdout, "hevc_videotoolbox"),
      h264_videotoolbox: has(enc.stdout, "h264_videotoolbox"),
      libx265: has(enc.stdout, "libx265"),
      libx264: has(enc.stdout, "libx264"),
    },
    filters: {
      signalstats: has(filt.stdout, "signalstats"),
      overlay: has(filt.stdout, "overlay"),
      drawtext: has(filt.stdout, "drawtext"),
    },
  };
  return _caps;
}

// Pick the best encoder for the platform, honoring an explicit choice.
// videotoolbox encoders only function on macOS even when listed elsewhere,
// so they are gated on platform === 'darwin'.
export async function pickEncoder(choice = "auto") {
  const caps = await capabilities();
  const mac = caps.platform === "darwin";
  const avail = caps.encoders;

  const order = mac
    ? ["hevc_videotoolbox", "libx265", "libx264"]
    : ["libx265", "libx264"];

  let name;
  if (choice && choice !== "auto") {
    const isVT = choice.includes("videotoolbox");
    if (isVT && !mac) throw new Error(`encoder ${choice} requires macOS; use libx265/libx264 on this platform`);
    if (!avail[choice]) throw new Error(`encoder ${choice} not available in this ffmpeg build`);
    name = choice;
  } else {
    name = order.find((e) => avail[e]);
    if (!name) throw new Error("no usable video encoder found (need hevc_videotoolbox/libx265/libx264)");
  }
  return { name, vargs: encoderArgs(name) };
}

// Quality/flag args per encoder. videotoolbox values match the proven NATTY run.
function encoderArgs(name) {
  switch (name) {
    case "hevc_videotoolbox": return ["-c:v", "hevc_videotoolbox", "-q:v", "55", "-tag:v", "hvc1"];
    case "h264_videotoolbox": return ["-c:v", "h264_videotoolbox", "-q:v", "55"];
    case "libx265":           return ["-c:v", "libx265", "-crf", "20", "-preset", "medium", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"];
    case "libx264":           return ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"];
    default: throw new Error(`unknown encoder ${name}`);
  }
}
