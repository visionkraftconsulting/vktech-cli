# Self-Hosted Vision (zero per-call API cost)

Goal: run `vktech ask -i <image> "<prompt>"` against **our own** vision model so
there are **no per-call API costs** — like "OpenAI vision" but self-hosted.

The CLI code is **already done and verified**. What's left (paused on purpose to
avoid GPU billing) is **standing up the model server**. This doc is the resume
point.

---

## Status

| Piece | State |
|---|---|
| CLI provider (`local` Ollama vision) | ✅ Done — `src/providers.js` |
| Strict `$0` mode (no paid fallback) | ✅ Done — `VKTECH_VISION_LOCAL_ONLY=true` (default) |
| `.env.example` documented | ✅ Done |
| Help text updated | ✅ Done |
| **Model server (Ollama)** | ⏸️ **NOT started** — this is the resume task |

Verified 2026-06-28: in strict mode the vision cascade is `["local"]` only —
even with paid keys set, it never calls a paid API. Fails cleanly if the local
server is unreachable.

---

## How it works

`askVision()` in `src/providers.js` cascades over `VISION_PRIORITY`. We added a
keyless `local` provider that POSTs to **Ollama's `/api/chat`** (images as bare
base64 strings, Ollama's native shape — not the OpenAI `image_url` shape).

- `LOCAL_VISION_URL`  — where Ollama lives (default `http://127.0.0.1:11434`)
- `LOCAL_VISION_MODEL` — model tag (default `llama3.2-vision`)
- `VKTECH_VISION_LOCAL_ONLY=true` — **strict $0**: priority becomes `["local"]`
  only, never falls back to paid APIs. (Set `false` → `local,xai,anthropic,openai`.)
- `VKTECH_VISION_PRIORITY` — override the order explicitly if needed.

`local` needs **no API key** — it's gated on reachability (`visionConfigured()`).

---

## Resume — Option A: prove it locally on the Mac (free, do this first)

This validates the entire flow at $0 before any droplet spend.

```bash
# 1. Install Ollama (Apple Silicon — uses the Mac GPU)
brew install ollama
ollama serve &              # starts the server on :11434

# 2. Pull a vision model (~7.8GB for llama3.2-vision 11B)
ollama pull llama3.2-vision
#   alternatives: qwen2.5vl   |   minicpm-v   |   llava

# 3. Point the CLI at local Ollama (already the default, but explicit:)
#    in ~/.config/vktech/.env  (or ./.env)
#      LOCAL_VISION_URL=http://127.0.0.1:11434
#      LOCAL_VISION_MODEL=llama3.2-vision
#      VKTECH_VISION_LOCAL_ONLY=true

# 4. Run it — zero API cost
vktech ask -i some-image.png "Describe this image. Extract any text."
#   expect: [local:llama3.2-vision · vision]  <description>
```

If quality is good enough on the Mac, you may not need a droplet at all for
light use. If you need it available to the whole fleet / faster / heavier
models → Option B.

---

## Resume — Option B: DO GPU droplet (for the fleet, billed hourly)

Real cost is the **droplet**, not per-call. DO GPU droplets ~ **$1.5–$3.5/hr**
(no cheap always-on GPU). Decide on-demand vs always-on.

```bash
# Create a GPU droplet (example — check current DO GPU slugs with `doctl`)
doctl compute droplet create vk-vision-gpu \
  --region nyc2 --size <gpu-size-slug> \
  --image ubuntu-22-04-x64 --ssh-keys <key-id> --wait

# SSH in, install Ollama
ssh root@<gpu-ip>
curl -fsSL https://ollama.com/install.sh | sh
# Make Ollama listen on all interfaces so the fleet can reach it:
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' \
  > /etc/systemd/system/ollama.service.d/override.conf
systemctl daemon-reload && systemctl restart ollama
ollama pull llama3.2-vision

# LOCK IT DOWN — Ollama has NO auth. Do NOT expose :11434 to the internet.
# Restrict to the fleet's IPs only (see fleet list in ~/.claude/CLAUDE.md):
ufw allow from <each-fleet-ip> to any port 11434
ufw enable
#   Better: keep 11434 firewalled and reach it over an SSH tunnel or the DO VPC.
```

Then point the fleet's CLI config at it. Each droplet has
`~/.config/vktech/.env` (chmod 600) — set on each:

```
LOCAL_VISION_URL=http://<gpu-ip>:11434
LOCAL_VISION_MODEL=llama3.2-vision
VKTECH_VISION_LOCAL_ONLY=true
```

(Push the same way keys are pushed fleet-wide — see the "vktech CLI — fleet
deployment" block in `~/.claude/CLAUDE.md`.)

### On-demand cost control
If usage is bursty, create the droplet per session and destroy when done:
```bash
doctl compute droplet delete vk-vision-gpu --force   # stop billing
```
Snapshot first if you want to skip re-pulling the model:
```bash
doctl compute droplet-action snapshot <id> --snapshot-name vk-vision-ready
```

---

## Model choices (all run on Ollama, all $0 per call)

| Model | Size | Notes |
|---|---|---|
| `llama3.2-vision` (11B) | ~7.8GB | Good general default; OCR + description |
| `qwen2.5vl` | 3B–72B | Strong OCR / document / chart understanding |
| `minicpm-v` | ~5.5GB | Lightweight, good quality-for-size |
| `llava` | 7B–34B | Classic, widely tested |

Swap by changing `LOCAL_VISION_MODEL` (and `ollama pull <tag>` on the server).

---

## Ship the CLI change

The code changes are committed-ready in `src/providers.js`, `.env.example`,
`src/cli.js`. To release to the fleet after testing:

```bash
cd ~/Kwasi_Dev/vktech
npm test                    # node --check on all sources
git add -A && git commit    # then push to the public repo
# fleet upgrade (per droplet): npm install -g github:visionkraftconsulting/vktech-cli
```

The CLI is safe to ship **now** even before the server exists: with no reachable
`LOCAL_VISION_URL`, `vktech ask -i` simply errors cleanly (it does not silently
bill a paid API in strict mode).
