# vkPilot relay contract (vktech CLI subscriptions)

The CLI side lives in `src/vkpilot.js` and `src/bedrock.js`. Base URL `VKTECH_PILOT_URL`
(default `https://pilot.vktech.ai`). The token is stored in `~/.config/vktech/vkpilot.json`
(mode 0600). `VKTECH_PILOT_TOKEN` overrides the stored token.

| Call | Request | Response |
|---|---|---|
| `POST /api/cli/pair/start` | `{client:"vktech-cli", version}` | `{code, pollToken, verifyUrl, expiresIn}` |
| `POST /api/cli/pair/poll` | `{pollToken}` | `{status:"pending"}`, then `{status:"approved", token:"vkt_…", email}` (or `denied` / `expired`) |
| `GET /api/cli/me` | `Authorization: Bearer vkt_…` | `{email, plan, models[], defaultModel, usage:{usedUsd, includedUsd, resetsAt}}` |
| `POST /api/cli/v1/messages` | `x-api-key: vkt_…` + an Anthropic Messages body (`?beta=true` and `anthropic-beta` may be present) | Anthropic Messages JSON, or Anthropic SSE when `stream:true` |

Model ids are Bedrock inference-profile ids (`us.anthropic.claude-opus-4-6-v1`, …).

Errors use Anthropic's error JSON shape `{type:"error", error:{type, message}}`:

| Status | Meaning | CLI behavior |
|---|---|---|
| 401 | Bad or revoked token | Says to run `vktech login` |
| 402 / 403 | Subscription or usage limit; the message names it | Shows the message plus the plans URL |
| 404 | Model not in the plan | Tries the next model in its fallback chain |
| 429 | Rate limit | The SDK backs off and retries |

The relay may drop `thinking.block_binding`. If Bedrock then rejects the request, the CLI
retries once without it.
