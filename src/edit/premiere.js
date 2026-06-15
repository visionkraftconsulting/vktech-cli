// Premiere Pro project export — generate an importable timeline (FCPXML + EDL)
// from the edit plan, so users can open and keep editing in Premiere.
//
// FCPXML notes (learned the hard way — Premiere's parser is strict):
//   - file source goes in a nested <media-rep kind="original-media">, NOT a src attr on <asset>
//   - times are reduced rationals "n/ds"; whole values collapse to "Ns"
//   - a clip's start+duration must NOT exceed its asset duration, or Premiere rejects it
//     (we give the asset a few frames of headroom and keep the out 1 frame inside media)
import { writeFileSync } from "node:fs";
import { join, basename } from "node:path";

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

// frames -> reduced rational time string at fps.
function T(frames, fps) {
  if (frames <= 0) return "0s";
  const g = gcd(frames, fps);
  const n = frames / g, d = fps / g;
  return d === 1 ? `${n}s` : `${n}/${d}s`;
}

// frames -> HH:MM:SS:FF timecode.
function tc(frames, fps) {
  const h = Math.floor(frames / (fps * 3600));
  const m = Math.floor(frames / (fps * 60)) % 60;
  const s = Math.floor(frames / fps) % 60;
  const f = frames % fps;
  const p = (x) => String(x).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

function fileURL(absPath) {
  return "file://" + absPath.split("/").map(encodeURIComponent).join("/");
}

// Build FCPXML. plan: [{file(abs), in, out}], clipFrames: { file: totalFrames }.
export function buildFcpxml(plan, { fps, width, height, projectName }) {
  const assets = [], clips = [];
  let pos = 0;
  plan.forEach((p, i) => {
    const id = `r${i + 2}`;
    const total = clipFramesOf(p);
    const assetDur = total + 3;                       // headroom so clip never exceeds asset
    const inF = Math.round(p.in * fps);
    const outF = Math.min(Math.round(p.out * fps), total - 1);
    const seg = Math.max(1, outF - inF);
    assets.push(
`    <asset id="${id}" name="${basename(p.file)}" start="0s" hasVideo="1" hasAudio="1" format="r1" duration="${T(assetDur, fps)}" audioSources="1" audioChannels="2" audioRate="44100">
      <media-rep kind="original-media" src="${fileURL(p.file)}"/>
    </asset>`);
    clips.push(
`        <asset-clip name="${basename(p.file)}" ref="${id}" offset="${T(pos, fps)}" start="${T(inF, fps)}" duration="${T(seg, fps)}" audioRole="dialogue" tcFormat="NDF"/>`);
    pos += seg;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="FFVideoFormat${width}x${height}p${fps}" frameDuration="1/${fps}s" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>
${assets.join("\n")}
  </resources>
  <library>
    <event name="${projectName}">
      <project name="${projectName}">
        <sequence format="r1" duration="${T(pos, fps)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="44100">
          <spine>
${clips.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

// Build a CMX3600 EDL — the most universally-imported edit format.
export function buildEdl(plan, { fps, projectName }) {
  const lines = [`TITLE: ${projectName}`, "FCM: NON-DROP FRAME", ""];
  let rec = 0;
  plan.forEach((p, i) => {
    const srcIn = Math.round(p.in * fps), srcOut = Math.round(p.out * fps);
    const dur = srcOut - srcIn, recIn = rec, recOut = rec + dur; rec = recOut;
    const n = String(i + 1).padStart(3, "0");
    lines.push(`${n}  ${n} V     C        ${tc(srcIn, fps)} ${tc(srcOut, fps)} ${tc(recIn, fps)} ${tc(recOut, fps)}`);
    lines.push(`* FROM CLIP NAME: ${basename(p.file)}`);
    lines.push("");
  });
  return lines.join("\n");
}

// clipFramesOf is injected per-call so we don't re-probe here; the orchestrator
// passes total frames via p._frames (from probe stage).
function clipFramesOf(p) {
  if (p._frames) return p._frames;
  // fallback: estimate from out point with headroom (orchestrator should set _frames)
  return Math.round((p.out + 5) * 30);
}

// Write both files next to the output. Returns their paths.
export function writePremiere(plan, cfg, { fps, width, height }) {
  const projectName = (cfg.project_name || basename(cfg.output).replace(/\.[^.]+$/, "")) || "vktech edit";
  const dir = cfg.work_dir;
  const base = join(dir, projectName.replace(/[^\w.-]+/g, "_"));
  const fcpxml = buildFcpxml(plan, { fps, width, height, projectName });
  const edl = buildEdl(plan, { fps, projectName });
  const fcpxmlPath = `${base}.fcpxml`, edlPath = `${base}.edl`;
  writeFileSync(fcpxmlPath, fcpxml);
  writeFileSync(edlPath, edl);
  return { fcpxmlPath, edlPath, projectName };
}
