// Stage 4 — captions. Renders caption cards as transparent PNGs via canvas
// (this ffmpeg has no drawtext), composited later with overlay+fade.
// Content comes from grok-vision analysis of sampled frames (safe_mode: never
// asserts unverified facts); config overrides (verified facts) always win.
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "./ffmpeg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_FAMILY = "VkEditSerif";
let _fontReady = false;
function ensureFont(fontPath) {
  if (_fontReady) return;
  const p = fontPath || join(__dirname, "assets", "NotoSerif-VF.ttf");
  if (!existsSync(p)) throw new Error(`caption font not found: ${p}`);
  GlobalFonts.registerFromPath(p, FONT_FAMILY);
  _fontReady = true;
}

// ---- PNG rendering (ports make_caps.py: layered shadow + faded scrim band) ----

function drawScrim(ctx, W, H, yTop, yBot, maxAlpha) {
  // Vertical band, alpha faded over 80px at top/bottom edges.
  for (let y = yTop; y <= yBot; y++) {
    const d = Math.min(y - yTop, yBot - y, 80) / 80;
    ctx.fillStyle = `rgba(0,0,0,${(maxAlpha / 255) * Math.min(d, 1)})`;
    ctx.fillRect(0, y, W, 1);
  }
}

function drawCentered(ctx, text, size, weight, W, y) {
  ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  // layered shadow for legibility over any footage (matches proven look)
  for (const [dx, dy, a] of [[4, 4, 200], [3, 3, 180]]) {
    ctx.fillStyle = `rgba(0,0,0,${a / 255})`;
    ctx.fillText(text, W / 2 + dx, y + dy);
  }
  ctx.fillStyle = "white";
  ctx.fillText(text, W / 2, y);
}

// Render one card { id, lines:[{text,size,weight}], band:[topFrac,botFrac,alpha] } -> PNG path.
export function renderCard(card, W, H, workDir, fontPath) {
  ensureFont(fontPath);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  if (card.band) drawScrim(ctx, W, H, Math.round(H * card.band[0]), Math.round(H * card.band[1]), card.band[2]);
  for (const ln of card.lines) {
    drawCentered(ctx, ln.text, ln.size, ln.weight || "400", W, Math.round(H * ln.y));
  }
  const out = join(workDir, `cap_${card.id}.png`);
  writeFileSync(out, canvas.toBuffer("image/png"));
  return out;
}

// ---- Vision: sample a frame per clip, ask for a caption structure ----

async function sampleFrame(file, atSec, workDir, idx, signal) {
  const out = join(workDir, `_frame_${idx}.png`);
  await ffmpeg(["-loglevel", "error", "-y", "-ss", String(atSec), "-i", file,
    "-frames:v", "1", "-vf", "scale=1280:-1", out], { signal });
  return out;
}

const VISION_SYSTEM =
  "You are titling a respectful video. Look at the sampled frames and propose tasteful, " +
  "generic on-screen caption cards that describe MOOD and SCENE only. " +
  "CRITICAL: never state names, dates, relationships, or any specific fact you cannot see — " +
  "those are supplied separately. Return ONLY JSON: " +
  '{"title":"...","subtitle":"...","lower_thirds":["...","..."],"closing":"..."}.';

// Build caption cards. Returns { cards:[...], source }.
// mode: vision | metadata | off.
export async function buildCaptions(plan, cfg, { log, signal } = {}) {
  const capCfg = cfg.captions;
  if (capCfg.mode === "off") return { cards: [], source: "off" };

  const { w: W, h: H } = cfg.resolution;
  const total = plan.reduce((s, p) => s + (p.out - p.in), 0);

  // Caption text: overrides (verified) first; vision fills any gaps.
  let title = "", subtitle = "", lowers = [], closing = "";
  const overrides = capCfg.overrides || [];

  if (capCfg.mode === "vision") {
    try {
      const { askVision } = await import("../providers.js");
      // Sample up to 6 representative frames across the timeline.
      const pick = plan.filter((_, i) => i % Math.max(1, Math.floor(plan.length / 6)) === 0).slice(0, 6);
      const images = [];
      for (let i = 0; i < pick.length; i++) {
        const f = await sampleFrame(pick[i].file, pick[i].in + Math.min(2, (pick[i].out - pick[i].in) / 2), cfg.work_dir, i, signal);
        images.push({ mime: "image/png", dataB64: readFileSync(f).toString("base64") });
      }
      const facts = capCfg.facts_file && existsSync(capCfg.facts_file) ? readFileSync(capCfg.facts_file, "utf8") : "";
      const prompt = "Propose caption cards for this video." + (facts ? `\nVerified context (use only if clearly supported): ${facts}` : "");
      const res = await askVision({ prompt, system: VISION_SYSTEM, images, modelArg: capCfg.vision_model, signal });
      const j = JSON.parse(res.text.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
      title = j.title || ""; subtitle = j.subtitle || "";
      lowers = Array.isArray(j.lower_thirds) ? j.lower_thirds : [];
      closing = j.closing || "";
      log.info(`  captions: vision (${res.provider}) -> title="${title}"`);
    } catch (e) {
      log.warn(`  captions: vision failed (${e.message}); using overrides only`);
    }
  }

  // Assemble timed cards. Overrides by id replace anything generated.
  const byId = Object.fromEntries(overrides.map((o) => [o.id, o]));
  const cards = [];
  const fade = 1;

  const push = (id, atSec, durSec, lines, band) => {
    if (byId[id]) {
      const o = byId[id];
      cards.push({ id, at: o.at_sec ?? atSec, dur: o.dur_sec ?? durSec, lines: o.lines, band: o.band ?? band, fade });
    } else if (lines.some((l) => l.text)) {
      cards.push({ id, at: atSec, dur: durSec, lines: lines.filter((l) => l.text), band, fade });
    }
  };

  // Opening title (0-9s), a couple of lower-thirds spread out, closing card.
  push("open", 0.5, 8, [
    { text: title || subtitle || "", size: Math.round(H * 0.05), weight: "700", y: 0.40 },
    { text: subtitle && title ? subtitle : "", size: Math.round(H * 0.027), weight: "400", y: 0.50 },
  ], [0.30, 0.60, 110]);

  lowers.slice(0, 3).forEach((t, i) => {
    const at = total * (0.3 + 0.2 * i);
    push(`lt${i}`, at, 8, [{ text: t, size: Math.round(H * 0.030), weight: "400", y: 0.80 }], [0.74, 0.88, 120]);
  });

  push("close", Math.max(0, total - 9), 8, [
    { text: closing || "", size: Math.round(H * 0.031), weight: "700", y: 0.46 },
  ], [0.34, 0.60, 120]);

  // Render PNGs.
  for (const c of cards) c.png = renderCard(c, W, H, cfg.work_dir, capCfg.font);
  return { cards: cards.filter((c) => c.lines.length), source: capCfg.mode };
}

// ---- Build the overlay+fade filtergraph for the final render pass ----
// Returns { filterScript, inputs } — inputs are the caption PNG paths (looped),
// in order; the graph applies the grade to [0:v] then overlays each card with a
// timed alpha fade. Matches the proven filter.txt structure.
export function buildCaptionFilter(cards, gradeStr) {
  if (!cards.length) return null;
  const lines = [];
  lines.push(`[0:v]${gradeStr},format=yuv420p[base]`);
  cards.forEach((c, i) => {
    const inIdx = i + 1; // 0 is the main video
    const fi = c.at, fo = c.at + c.dur;
    lines.push(`[${inIdx}:v]format=rgba,fade=t=in:st=${fi}:d=${c.fade}:alpha=1,fade=t=out:st=${fo - c.fade}:d=${c.fade}:alpha=1[o${i}]`);
  });
  let prev = "base";
  cards.forEach((c, i) => {
    const next = i === cards.length - 1 ? "v" : `b${i}`;
    const lo = c.at - 1, hi = c.at + c.dur + 1;
    lines.push(`[${prev}][o${i}]overlay=0:0:enable='between(t,${lo},${hi})'[${next}]`);
    prev = `b${i}`;
  });
  return { filterScript: lines.join(";\n"), inputs: cards.map((c) => c.png) };
}
