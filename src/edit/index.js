// vktech edit engine — orchestrates the 8-stage automated pipeline.
// Config-driven, zero interactive prompts. Returns a result summary.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeDir } from "./probe.js";
import { buildPlan, writePlan, totalRuntime } from "./plan.js";
import { darkScan } from "./darkscan.js";
import { buildCaptions, buildCaptionFilter } from "./captions.js";
import { buildSegments, concat } from "./render.js";
import { gradeFilter } from "./presets.js";
import { pickEncoder, ffmpeg } from "./ffmpeg.js";
import { verify } from "./verify.js";
import { applyAudio } from "./audio.js";

const noop = () => {};

// Render the concatenated master + caption overlays in one graded pass.
async function renderWithCaptions(masterPath, cards, cfg, outPath, { log, signal }) {
  const grade = gradeFilter(cfg.tone_preset);
  const fg = buildCaptionFilter(cards, grade);
  const inputs = ["-i", masterPath];
  for (const png of fg.inputs) inputs.push("-loop", "1", "-i", png);
  const scriptPath = join(cfg.work_dir, "caption_filter.txt");
  writeFileSync(scriptPath, fg.filterScript);
  log.info(`  compositing ${cards.length} caption card(s) + grade…`);
  const enc = await pickEncoder(cfg.encoder);
  const a = cfg.audio;
  await ffmpeg([
    "-loglevel", "error", "-y",
    ...inputs,
    "-filter_complex_script", scriptPath,
    "-map", "[v]", "-map", "0:a",
    ...enc.vargs,
    "-c:a", "aac", "-b:a", a.bitrate,
    "-movflags", "+faststart", "-shortest",
    outPath,
  ], { signal });
  return outPath;
}

export async function runEdit(cfg, { log = {}, signal } = {}) {
  const L = { info: log.info || noop, warn: log.warn || noop, step: log.step || log.info || noop };
  mkdirSync(cfg.work_dir, { recursive: true });

  // Stage 1 — probe
  L.step("Probing clips…");
  const clips = await probeDir(cfg.input, { signal });
  L.info(`  ${clips.length} clips, ${(clips.reduce((s, c) => s + c.duration, 0) / 60).toFixed(1)} min raw`);

  // Stage 2 — plan
  L.step("Building edit plan…");
  let plan = buildPlan(clips, cfg);
  L.info(`  ${plan.length} segments, ${(totalRuntime(plan) / 60).toFixed(1)} min`);

  // Stage 3 — dark scan
  if (cfg.dark.mode !== "off") {
    L.step("Scanning for dark/blocked shots…");
    const ds = await darkScan(plan, cfg, { log: L, signal });
    plan = ds.plan;
  }
  const planPath = writePlan(plan, cfg.work_dir);

  if (cfg.dry_run) {
    L.step("Dry run — plan only.");
    return { dryRun: true, planPath, segments: plan.length, runtimeSec: totalRuntime(plan) };
  }

  const encInfo = await pickEncoder(cfg.encoder);
  L.info(`  encoder: ${encInfo.name}`);

  // Stage 4 — captions (content + PNGs)
  let cards = [];
  if (cfg.captions.mode !== "off") {
    L.step("Generating captions…");
    const cap = await buildCaptions(plan, cfg, { log: L, signal });
    cards = cap.cards;
  }

  // Stages 5-6 — segments + concat
  L.step("Encoding segments…");
  const { listPath } = await buildSegments(plan, cfg, encInfo, { log: L, signal });
  const master = join(cfg.work_dir, "master.mp4");
  await concat(listPath, master, { log: L, signal });

  // Stage 7 — captions overlay (or just promote master if none)
  let finalPath = cfg.output;
  if (cards.length) {
    L.step("Rendering captions + grade…");
    await renderWithCaptions(master, cards, cfg, finalPath, { log: L, signal });
  } else {
    // No captions: the grade is already baked into segments, just move master.
    await ffmpeg(["-loglevel", "error", "-y", "-i", master, "-c", "copy", "-movflags", "+faststart", finalPath], { signal });
  }

  // Stage 7.5 — apply user music track (questionnaire): replace_all|bed|opening.
  let audioApplied = "off";
  if (cfg.audio && cfg.audio.mode && cfg.audio.mode !== "off" && cfg.audio.track) {
    L.step("Applying music track…");
    const withAudio = join(cfg.work_dir, "with_audio.mp4");
    await applyAudio(finalPath, withAudio, cfg, { log: L, signal });
    // promote the audio-applied file to the output path
    await ffmpeg(["-loglevel", "error", "-y", "-i", withAudio, "-c", "copy", "-movflags", "+faststart", finalPath], { signal });
    audioApplied = cfg.audio.mode;
  }

  // Stage 8 — verify
  L.step("Verifying integrity…");
  const v = await verify(finalPath, { signal });
  if (!v.ok) L.warn(`  ${v.count} decode error(s) — see output`);
  else L.info("  0 decode errors");

  return {
    output: finalPath, planPath, segments: plan.length,
    runtimeSec: totalRuntime(plan), encoder: encInfo.name,
    captions: cards.length, audio: audioApplied, verified: v.ok, decodeErrors: v.count,
  };
}
