// vktech transcribe — offline speech-to-text for audio/video via whisper.cpp.
//
// Pipeline per file: ffmpeg extracts 16kHz mono PCM WAV (whisper.cpp's required
// input format) → whisper-cli produces .txt and/or .srt next to it. A directory
// input transcribes every media file inside; --combine concatenates all .txt
// into one master document (headed by filename), matching the manual workflow.
//
// Binary: `whisper-cli` from Homebrew's whisper-cpp (brew install whisper-cpp).
// Model:  a ggml-<name>.bin file, resolved from (in order) an explicit --model
// path, VKTECH_WHISPER_MODEL, then ~/.config/vktech/models/ggml-<name>.bin,
// auto-downloaded from Hugging Face on first use if absent.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync, createWriteStream } from "node:fs";
import { join, dirname, basename, extname, resolve, isAbsolute } from "node:path";
import { run } from "./edit/ffmpeg.js";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const MODEL_DIR = join(HOME, ".config", "vktech", "models");
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

// Media extensions we accept for a directory sweep.
const MEDIA_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv",   // video
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus",  // audio
]);

// Locate the whisper-cli binary; a clear install hint if it's missing.
async function ensureWhisper() {
  const r = await run("whisper-cli", ["--help"]).catch((e) => ({ code: 127, err: e }));
  if (r.code === 127 || r.err) {
    throw new Error("whisper-cli not found on PATH — install it with: brew install whisper-cpp");
  }
}

// Resolve (and if needed download) the ggml model file. `model` is either a
// bare name like "small.en" / "base" / "medium", or a path to a .bin file.
async function resolveModel(model, { log } = {}) {
  const explicit = model || process.env.VKTECH_WHISPER_MODEL || "small.en";
  // A path to an existing .bin — use as-is.
  if (explicit.endsWith(".bin")) {
    const p = isAbsolute(explicit) ? explicit : resolve(explicit);
    if (existsSync(p)) return p;
    throw new Error(`model file not found: ${p}`);
  }
  const name = explicit.replace(/^ggml-|\.bin$/g, "");
  const dest = join(MODEL_DIR, `ggml-${name}.bin`);
  if (existsSync(dest) && statSync(dest).size > 1_000_000) return dest;

  // Download from Hugging Face.
  mkdirSync(MODEL_DIR, { recursive: true });
  const url = `${HF_BASE}/ggml-${name}.bin`;
  log?.info(`  downloading model ggml-${name}.bin … (first use only)`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`could not download model "${name}" (HTTP ${res.status}). ` +
      `Valid names include: tiny(.en), base(.en), small(.en), medium(.en), large-v3.`);
  }
  const tmp = dest + ".part";
  await new Promise((ok, bad) => {
    const out = createWriteStream(tmp);
    // Node 18+: res.body is a web ReadableStream; pump it to the file.
    const reader = res.body.getReader();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!out.write(Buffer.from(value))) await new Promise((r) => out.once("drain", r));
        }
        out.end(ok);
      } catch (e) { bad(e); }
    })();
    out.on("error", bad);
  });
  rmSync(dest, { force: true });
  writeFileSync(dest, readFileSync(tmp));
  rmSync(tmp, { force: true });
  log?.info(`  model ready: ${dest}`);
  return dest;
}

// Expand a file-or-directory input into a sorted list of media files.
// Exported so the CLI's --dry-run can preview inputs without transcribing.
export function collectInputs(input) {
  const p = isAbsolute(input) ? input : resolve(input);
  if (!existsSync(p)) throw new Error(`not found: ${p}`);
  if (statSync(p).isDirectory()) {
    return readdirSync(p)
      .filter((f) => MEDIA_EXT.has(extname(f).toLowerCase()))
      .sort()
      .map((f) => join(p, f));
  }
  if (!MEDIA_EXT.has(extname(p).toLowerCase())) {
    throw new Error(`unsupported file type: ${extname(p) || "(none)"} — expected audio/video`);
  }
  return [p];
}

// Extract 16kHz mono PCM WAV — the format whisper.cpp requires.
async function extractWav(src, wav) {
  const r = await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-y",
    "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    wav, "-loglevel", "error",
  ]);
  if (r.code !== 0) {
    const tail = r.stderr.trim().split("\n").slice(-4).join("\n");
    throw new Error(`ffmpeg audio extract failed (exit ${r.code}):\n${tail}`);
  }
}

// Run whisper-cli over a wav, emitting the requested formats to `outBase.*`.
async function whisperTranscribe(wav, outBase, { model, lang, txt, srt }) {
  const args = ["-m", model, "-f", wav, "--output-file", outBase, "-l", lang];
  if (txt) args.push("--output-txt");
  if (srt) args.push("--output-srt");
  const r = await run("whisper-cli", args);
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout).trim().split("\n").slice(-4).join("\n");
    throw new Error(`whisper-cli failed (exit ${r.code}):\n${tail}`);
  }
}

// Main entry. opts: { model, lang, txt, srt, combine, outDir, log, signal }.
// Returns { outputs: [{ src, txt, srt }], combined }.
export async function transcribe(input, opts = {}) {
  const {
    model: modelArg, lang = "en",
    txt = true, srt = false, combine = false,
    outDir: outDirArg, log,
  } = opts;

  await ensureWhisper();
  const model = await resolveModel(modelArg, { log });
  const files = collectInputs(input);
  if (!files.length) throw new Error("no audio/video files found to transcribe");

  // Output directory: explicit --out, else alongside the input (dir or file's dir).
  const srcRoot = statSync(resolve(input)).isDirectory() ? resolve(input) : dirname(resolve(files[0]));
  const outDir = outDirArg ? (isAbsolute(outDirArg) ? outDirArg : resolve(outDirArg)) : srcRoot;
  mkdirSync(outDir, { recursive: true });

  const outputs = [];
  for (let i = 0; i < files.length; i++) {
    const src = files[i];
    const stem = basename(src, extname(src));
    const outBase = join(outDir, stem);
    const wav = join(outDir, `.${stem}.transcribe.wav`);
    log?.info(`[${i + 1}/${files.length}] ${basename(src)}`);
    try {
      await extractWav(src, wav);
      await whisperTranscribe(wav, outBase, { model, lang, txt, srt });
      outputs.push({
        src,
        txt: txt ? `${outBase}.txt` : null,
        srt: srt ? `${outBase}.srt` : null,
      });
    } finally {
      rmSync(wav, { force: true });
    }
  }

  // Combined master document (only meaningful when producing .txt).
  let combined = null;
  if (combine && txt) {
    combined = join(outDir, "ALL_TRANSCRIPTS_COMBINED.txt");
    const parts = [];
    for (const o of outputs) {
      if (!o.txt || !existsSync(o.txt)) continue;
      const name = basename(o.txt, ".txt");
      parts.push(
        "################################################################",
        `# ${name}`,
        "################################################################",
        "",
        readFileSync(o.txt, "utf8").trim(),
        "", "",
      );
    }
    writeFileSync(combined, parts.join("\n"));
    log?.info(`  combined → ${combined}`);
  }

  return { outputs, combined, outDir };
}
