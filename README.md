# ClopinetteAI

Cloudflare-native AI agent with persistent memory, 12 tools, multimodal I/O, and Telegram / WhatsApp / Discord bots out of the box. One Durable Object per user, serverless, BYOK-ready.

> *Clopinette* = French for "next to nothing". An AI agent that costs clopinettes to run.

Inspired by [hermes-agent](https://github.com/NousResearch/hermes-agent) (Nous Research). Clean-room TypeScript rewrite for Cloudflare.

## How it works

```
        Web / Telegram / WhatsApp / Discord / Evolution / MCP
                              │
                              ▼
                   Hono worker  (clopinette-ai)
                              │
                              ▼
              ClopinetteAgent Durable Object
                (one per user, SQLite + R2)
                              │
                              ▼
         runPipeline() ──► LLM  +  12 tools  +  5 memory layers
```

Every user gets an isolated Durable Object with its own SQLite, its own `MEMORY.md` / `USER.md`, its own skills. The agent streams over WebSocket on the web UI and replies to Telegram / WhatsApp / Discord via webhooks. Telegram and WhatsApp can be linked to a web account with `/link` so the bot shares memory across channels.

Supporting Cloudflare services (used transparently):
- **Queues** — usage reports, retry-safe with DLQ
- **Workflows** — async delegation (sub-agents) and one-shot Vectorize backfill
- **Vectorize** — hybrid keyword + semantic search on chat history (bge-m3, RRF fusion)
- **Cron** — the gateway syncs D1 → KV quota every 5 min

## Features

- **Chat** — streaming WebSocket with Markdown, images, voice, drag-and-drop upload
- **12 tools** — web search, docs RAG, memory, history, skills, notes, calendar, todo, image generation, text-to-speech, browser (Playwright), async delegation
- **5-layer memory** — MEMORY.md / USER.md, hybrid FTS5+Vectorize session search, memory flush, skills index, optional Honcho
- **Multi-platform** — Telegram, WhatsApp (Meta Cloud API + self-hosted Evolution/Baileys), Discord (slash commands + DM bridge), MCP
- **14 personality presets** — helpful, concise, technical, kawaii, pirate, shakespeare, noir, uwu, etc. (`/personality`)
- **BYOK** — bring your own key across 12 providers (OpenAI, Anthropic, Groq, xAI, Mistral, DeepSeek, …) via the Cloudflare AI Gateway
- **Cross-provider auxiliary** — e.g. primary OpenAI + auxiliary Anthropic for the fast-path / compression
- **Self-learning** — the agent updates its own memory after N turns
- **Async delegation with auto-resume** — sub-agents run in parallel via Cloudflare Workflows. When the last delegate finishes, the agent automatically synthesizes their results and pushes the final reply via the originating gateway (web / Telegram / WhatsApp / Discord). No need to send a follow-up message.
- **Multimodal** — vision (images), Whisper (voice), PDF / DOCX / XLSX / text extraction

## Tools

The LLM sees 12 tools + `codemode` sandbox for orchestration:

| Tool | What it does |
|---|---|
| `web` | Search, read URL, scrape, extract, crawl, diagnostics (SearXNG / Brave / Browser Run quick actions) |
| `docs` | RAG search + Q&A over user-uploaded documents (AutoRAG) |
| `history` | Hybrid keyword + semantic search across past conversations |
| `memory` | Read / write persistent `MEMORY.md` and `USER.md` |
| `skills` | Load, create, edit `.md` skill files (reusable prompts) |
| `notes` | Personal notes with URL enrichment |
| `calendar` | Events + one-shot reminders delivered on all platforms |
| `todo` | Task list |
| `image` | Image generation (FLUX Schnell) |
| `tts` | Text-to-speech (12 voices, Deepgram Aura) |
| `clarify` | Ask the user a structured question mid-execution |
| `browser` | Playwright MCP (navigate, click, type, snapshot, diagnostics, human handoff) — conditional |
| `delegate` | Run parallel sub-agents in the background — conditional |

With codemode active (when the `LOADER` binding is set), the LLM writes JavaScript that orchestrates multiple tool calls in one step — up to 5x more token-efficient.

### Browser Run observability

- `browser({ action: "diagnostics" })` returns operator guidance for Browser Run Live View and Human in the Loop.
- `browser({ action: "request_human", reason: "..." })` produces a structured handoff when login, MFA, CAPTCHA, or sensitive data entry blocks automation.
- `web` responses backed by Browser Run quick actions now include `browserRun.sessionId`, `browserRun.browserMsUsed`, and `browserRun.cfRay` when Cloudflare returns them.
- Browser Run Live View / HITL are available for active browser sessions. In this codebase, the current `@cloudflare/playwright-mcp` wrapper does not expose the Browser Run session ID or direct Live View URL in tool results, so the operator flow is:

```bash
wrangler browser list
wrangler browser view <SESSION_ID>
```

- Browser Run Session Recordings require launching a browser session with `recording: true`. The current Playwright MCP wrapper used by Clopinette does not expose a recording toggle yet.

## Slash commands

Work on every platform (web, Telegram, WhatsApp, Discord).

| Command | Description |
|---|---|
| `/status` | Model, tokens, session info |
| `/research <topic>` | Deep research with parallel sub-agents (auto-synthesized reply) |
| `/model [provider id]` | Show or switch the active LLM (plan-aware) |
| `/insights` | Cost breakdown by model this month (USD estimate) |
| `/memory` | Show MEMORY.md and USER.md |
| `/soul` | Show SOUL.md personality (`/soul reset` to restore default) |
| `/personality [name]` | Switch personality or list the 14 presets |
| `/session` | Session info + auto-reset config |
| `/skills` | List installed skills |
| `/search <query>` | Search past conversations |
| `/note [text]` | Save a note (no text = show recent) |
| `/notes` | List all notes grouped by day |
| `/forget` | Clear memory |
| `/reset` or `/clear` | Reset current session |
| `/wipe CONFIRM` | Delete everything except your BYOK provider config |
| `/link` | Generate identity linking code (Telegram / WhatsApp / Discord) |
| `/help` | List all commands |

## Inference

| Setting | Value |
|---|---|
| Workers AI tier | Kimi K2.5 + Gemma 4 26B (free for trial / pro) |
| Internal / auxiliary | Gemma 4 26B — compression, self-learning, web summarization, browser snapshots |
| BYOK | 12 providers via AI Gateway, per-provider config, cross-provider auxiliary |
| BYOK enforcement | BYOK plan never touches Workers AI for inference — all chat, compression, self-learning, delegates run on the user's own provider |
| Max steps | 6 parent, 3 delegate |
| Context compression | Structured summary at 40+ messages |
| Prefix caching | Workers AI session affinity + cached system prompt (~83% token savings) |
| Error recovery | 429/529 → fallback to Workers AI default for trial / pro. BYOK surfaces the original provider error (no silent Workers AI fallback). |

## Installation

### Prerequisites

- [Bun](https://bun.sh) v1.1+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) v4+
- Cloudflare account (Workers Paid plan)

### Deploy

```bash
git clone https://github.com/marceloeatworld/clopinette-ai.git
cd clopinette-ai
cp wrangler.example.jsonc wrangler.jsonc
bun install

# Storage
wrangler r2 bucket create clopinette-memories
wrangler r2 bucket create clopinette-skills
wrangler kv namespace create LINKS

# Queues (retry-safe usage reports)
wrangler queues create clopinette-usage
wrangler queues create clopinette-usage-dlq

# Vectorize (hybrid semantic search, 1024-d for bge-m3)
wrangler vectorize create clopinette-sessions --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index clopinette-sessions --property-name=userId --type=string
wrangler vectorize create-metadata-index clopinette-sessions --property-name=sessionId --type=string

# Required secrets
wrangler secret put MASTER_KEY           # openssl rand -base64 32
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_GATEWAY_ID
wrangler secret put WS_SIGNING_SECRET    # openssl rand -base64 32 (shared with the gateway)
wrangler secret put API_AUTH_KEY

# Deploy — Workflows (delegation, vector backfill) are auto-created
bun run deploy
```

### Telegram

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
bun run deploy
curl -X POST https://your-worker.workers.dev/api/admin/setup-telegram \
  -H "Authorization: Bearer YOUR_API_AUTH_KEY"
```

### WhatsApp (Meta Cloud API)

```bash
wrangler secret put WHATSAPP_ACCESS_TOKEN
wrangler secret put WHATSAPP_VERIFY_TOKEN
wrangler secret put WHATSAPP_APP_SECRET
wrangler secret put WHATSAPP_PHONE_NUMBER_ID
# Set webhook URL in Meta portal: https://your-worker.workers.dev/webhook/whatsapp
```

### Discord

Two channels: **Interactions** (slash commands, zero setup) and **Gateway bridge** (DM / @mentions, needs a small external Docker service).

```bash
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_APPLICATION_ID
wrangler secret put DISCORD_TOKEN
bun run deploy

# Register slash commands + generate bridge secret
curl -X POST https://your-worker.workers.dev/api/admin/setup-discord \
  -H "Authorization: Bearer YOUR_API_AUTH_KEY"
# Returns: { interactionsUrl, bridgeUrl, bridgeSecret }

# For natural DM / @mention chat (optional):
cd workers/discord-bridge
# Set env: DISCORD_TOKEN, BRIDGE_SECRET, WORKER_URL
docker compose up -d
```

Slash commands (`/ask`, `/status`, `/memory`, etc.) work immediately. The bridge is only needed if you want full conversation in DMs and @mentions.

### Optional secrets

```bash
# Web search backends (automatic fallback: SearXNG → Brave → Browser Rendering)
wrangler secret put SEARXNG_URL          # self-hosted SearXNG URL
wrangler secret put BRAVE_API_KEY        # free tier: 2000 queries/month
wrangler secret put CF_BROWSER_TOKEN     # last resort + read/extract/crawl

# Evolution API (self-hosted WhatsApp via Baileys)
wrangler secret put EVOLUTION_API_URL
wrangler secret put EVOLUTION_API_KEY
```

## Project layout

```
src/
  index.ts             Hono router — webhooks + MCP + platform setup routes
  agent.ts             ClopinetteAgent DO — sessions, RPC methods, live state
  pipeline.ts          Inference pipeline (fast path + full 10 steps)
  prompt-builder.ts    10-block system prompt (cached per session)
  compression.ts       Structured context compression + memory flush
  commands.ts          Platform-agnostic slash commands
  delegate-workflow.ts Async sub-agent execution (Cloudflare Workflow)
  backfill-workflow.ts One-shot Vectorize hydration
  playwright-mcp.ts    Browser DO
  config/              Types, constants, personalities
  media/               Vision, Whisper, PDF/DOCX/XLSX
  memory/              Prompt memory, hybrid FTS5+Vectorize search, skills, self-learning
  tools/               12 tool implementations + registry
  hub/                 Skills catalog + GitHub + URL sources
  inference/           Per-provider config + smart routing + Anthropic cache
  enterprise/          Auth, audit, budget
  gateway/              Telegram / WhatsApp / Evolution / Slack / Discord adapters

workers/outbound/       SSRF-safe fetch proxy for codemode sandbox
workers/discord-bridge/ Discord Gateway bridge (Bun + Docker)
test/                   Unit tests + live smoke test
```

## Tests

```bash
bun run check    # TypeScript
bun run test     # Unit tests
BASE_URL=https://your-worker.workers.dev API_KEY=xxx bun test/live/smoke.ts
```

## Tech stack

Cloudflare Workers, Durable Objects, Workflows, Queues, Vectorize, Workers AI, AI Gateway, KV, R2, Browser Rendering, AutoRAG. TypeScript + [Hono](https://hono.dev) + [Agents SDK](https://github.com/cloudflare/agents) + [AI SDK v6](https://ai-sdk.dev).

## License

MIT
