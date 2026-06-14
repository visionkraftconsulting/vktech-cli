// Stage 8 — full-decode integrity check. Decodes the whole file to null and
// reports any decode errors (0 = clean).
import { run, NULL_DEVICE } from "./ffmpeg.js";

export async function verify(file, { signal } = {}) {
  const r = await run("ffmpeg", ["-nostdin", "-v", "error", "-i", file, "-f", "null", NULL_DEVICE], { signal });
  const errors = r.stderr.trim();
  const count = errors ? errors.split("\n").length : 0;
  return { ok: count === 0, count, errors };
}
