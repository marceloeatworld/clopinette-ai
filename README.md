# ClopinetteAI

Cloudflare-native AI agent with persistent memory, tools, self-learning, and multimodal I/O. One Durable Object per user, serverless. Runs on Cloudflare stack with optional SearXNG and Brave Search for fast web search.

> *Clopinette* = French for "next to nothing". An AI agent that costs clopinettes to run.

Inspired by [hermes-agent](https://github.com/NousResearch/hermes-agent) (Nous Research). Clean-room TypeScript rewrite for Cloudflare.

## Architecture

```
User (WebSocket / Telegram / WhatsApp / Evolution API / Slack / Discord / API / cron)
  |
  v
Hono Worker (index.ts) ── webhook signature verification
  |                        KV identity link resolution
  |                        KV quota enforcement (plan + tokens)
  v
ClopinetteAgent DO (agent.ts) ── one per user, isolated SQLite
  |
  v
runPipeline() (pipeline.ts)
  1. Load config (model, provider, API key) ── cached per session
  2. Smart routing (greetings -> cheap model)
  3. Budget check (monthly token limit)
  4. Build system prompt (10 blocks, cached, PROMPT_VERSION invalidation)
  5. Context compression (structured summary, iterative, parallel flush)
  6. Build tools (11 primary + aliases, or codemode)
  7. Process media (vision, Whisper STT, PDF/DOCX/XLSX extraction)
  8. LLM call (stream or generate, budget pressure, fallback)
  9. Post-processing (FTS5 mirror, usage report, self-learning)
```

### Multi-user isolation

Each user gets their own Durable Object. No shared data.

```
WebSocket "marcelo"         -> DO "marcelo"
Telegram chat 123 (linked)  -> DO "marcelo"     (via KV link:tg:123 -> marcelo)
Telegram chat 456 (free)    -> DO "tg_456"
WhatsApp +33... (linked)    -> DO "marcelo"
Discord user 789 (linked)   -> DO "marcelo"     (via KV link:dc:789 -> marcelo)
```

Identity linking: `/link` in Telegram/WhatsApp/Discord -> 5-min code -> enter in web app -> shared DO.

## Tools

11 primary tools + delegate (conditional). With codemode active, the LLM sees **8-9 tools** (1 `codemode` + 7 direct + optional `delegate`).

### Codemode tier (orchestration — wrapped in JS sandbox)

| Tool | Actions | Backend |
|------|---------|---------|
| `memory` | `read`, `add`, `replace`, `remove` | DO SQLite + R2 |
| `history` | full-text search by query | DO SQLite FTS5 |
| `skills` | `list`, `search`, `view`, `create`, `edit`, `patch`, `delete` | DO SQLite + R2 |
| `todo` | `list`, `add`, `done`, `remove` | DO SQLite |

`browser` (Playwright MCP: navigate, click, type, snapshot) is also wrapped in codemode when the PlaywrightMCP binding is present.

### Direct tier (side effects — called individually)

| Tool | Actions | Backend |
|------|---------|---------|
| `web` | `search`, `read`, `extract`, `scrape`, `links`, `crawl_start`, `crawl_check` | CF Browser Rendering REST API |
| `docs` | `search` (auto semantic/keyword), `ask`, `list` | R2 + Workers AI AutoRAG |
| `notes` | Personal notes: save, list, delete, edit, search | DO SQLite |
| `calendar` | Events with one-shot reminders via `this.schedule()` | DO SQLite |
| `image` | Image generation | Workers AI (FLUX Schnell) |
| `tts` | Text-to-speech (12 voices) | Workers AI (Deepgram Aura) |
| `clarify` | Ask structured questions mid-execution | Passthrough |
| `delegate` | Spawn parallel sub-agents (single or batch up to 3) | DelegateWorker DOs (ephemeral, no SQLite) |

### Web search

Automatic 3-tier fallback chain for search — fastest available backend wins:

| Tier | Backend | Speed | Limit | Config |
|------|---------|-------|-------|--------|
| 1 | **SearXNG** (self-hosted) | ~500ms | Unlimited | `SEARXNG_URL` |
| 2 | **Brave Search API** (free tier) | ~300ms | 2000/month | `BRAVE_API_KEY` |
| 3 | **CF Browser Rendering** `/scrape` | ~3-5s | Included | `CF_BROWSER_TOKEN` |

Browser Rendering uses session reuse (`sessionId` + `keep_alive`) to avoid 15-30s Chromium cold starts. Long pages are auto-summarized via the auxiliary model.

### Tool enhancements

- **Codemode**: when `LOADER` binding is set, orchestration tools wrap into a single JS sandbox tool. The LLM writes code with `Promise.all`, loops, conditionals — up to 5x token efficiency.
- **Budget pressure**: Hermes-style warnings at 70%/90% of step limit.
- **Dedup cache**: same tool+args within 2s returns cached result (5s for delegates).
- **Concurrency semaphore**: max 2 concurrent web fetches per tool instance (prevents CF deadlocks).
- **Fuzzy matching**: Levenshtein distance <= 2 corrects hallucinated tool names.
- **Backward-compat aliases**: old names (`web_search`, `web_browse`, `docs_search`, `session_search`, `save_note`, `image_generate`, `text_to_speech`, etc.) still work as aliases.

## Memory (5 layers)

| Layer | Storage | Limit |
|-------|---------|-------|
| Prompt Memory | SQLite + R2 backup | MEMORY.md 2200 chars, USER.md 1375 chars |
| Session Search | SQLite FTS5 | All past messages, grouped search with context |
| Memory Flush | Pre-compression | Extracts facts before context loss |
| Skills | SQLite index + R2 files | Reusable .md with YAML frontmatter |
| Honcho | External API (opt-in) | AI-native user modeling |

Memory is frozen at session start (writes take effect next session for prefix cache stability). Security-scanned with Unicode NFKD normalization. Self-learning compacts when > 80% full.

## Calendar

Events with optional one-shot reminders via `this.schedule(Date)`. Reminders delivered on WebSocket + Telegram + Discord + WhatsApp.

```
"RDV dentiste le 20 mars a 20h" -> calendar({ action: "create", title: "Dentiste", startAt: "2026-03-20T20:00:00", reminderMinutes: 30 })
```

## Inference

| Setting | Value |
|---------|-------|
| Default model | Kimi K2.5 via Workers AI |
| Auxiliary model | Granite 4.0 Micro (routing, browser snapshots) |
| Heavy auxiliary | Kimi K2.5 (compression, self-learning, web summarization) |
| BYOK | 12 providers via AI Gateway |
| Max steps | 6 (parent), 3 (delegate) |
| Prompt queue | Serial with 10s timeout |
| Session affinity | Prefix caching (same GPU across turns) |
| Fallback | BYOK fail -> Workers AI automatic |
| Context compression | Structured template at 40+ messages, iterative |

14 personality presets: helpful, concise, technical, creative, teacher, kawaii, catgirl, pirate, shakespeare, surfer, noir, uwu, philosopher, hype.

## Quota Enforcement

KV-based quota cache pushed by gateway, consumed by core. Ensures Telegram/WhatsApp respect monthly token limits.

```
Gateway (D1 source of truth)
  |-- Stripe webhook     -> D1 UPDATE -> KV push quota:{userId}
  |-- POST /internal/usage -> D1 INSERT -> checkQuota() -> KV push
  |-- GET /internal/quota/:id -> checkQuota() -> KV push + response

Core (KV consumer)
  |-- TG/WA webhook -> KV read quota:{userId}
  |   |-- Fresh (<5min): use directly
  |   |-- Stale: HTTP refresh from gateway
  |   |-- Gateway down: stale fallback or fail-open
```

`invoice.payment_failed` (2+ attempts): immediate KV push `allowed: false`.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/status` | Model, tokens, session info |
| `/memory` | Show MEMORY.md and USER.md |
| `/soul` | Show SOUL.md personality (`/soul reset` to restore default) |
| `/personality [name]` | Switch personality or list available (14 presets) |
| `/session` | Session info + auto-reset config (idle, daily, mode) |
| `/skills` | List installed skills |
| `/search <query>` | Search past conversations |
| `/note [text]` | Save a note (no text = show recent) |
| `/notes` | List all notes grouped by day |
| `/forget` | Clear memory (MEMORY.md + USER.md) |
| `/reset` / `/clear` | Reset current session |
| `/wipe CONFIRM` | Delete everything (irreversible) |
| `/link` | Generate identity linking code (TG/WA) |
| `/help` | List all commands |

## API Routes

### Core

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/setup` | API key | Create agent |
| POST | `/api/config` | API key | Set model/provider/api_key/soul_md |
| GET | `/api/status` | API key | Agent status |
| POST | `/api/link` | API key | Link platform identity |
| WS | `/agents/clopinette-agent/{userId}` | JWT/API key | Chat |

### Admin (`?userId=`)

| Method | Path | Purpose |
|--------|------|---------|
| GET/PUT | `/api/admin/memory/:type` | MEMORY.md / USER.md |
| GET/PUT | `/api/admin/soul` | SOUL.md |
| GET | `/api/admin/skills` | List skills |
| GET/PUT/DELETE | `/api/admin/skills/:name` | Skill CRUD |
| GET | `/api/admin/sessions` | List sessions |
| GET/DELETE | `/api/admin/sessions/:id` | Session messages / delete |
| DELETE | `/api/admin/sessions` | Delete all sessions |
| GET | `/api/admin/audit` | Audit log |
| GET/DELETE | `/api/admin/config` | Agent config |
| POST/GET/DELETE | `/api/admin/setup-telegram` | Telegram webhook setup |
| POST/DELETE | `/api/admin/setup-discord` | Discord slash commands + bridge secret |

### DO Internal

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST/PUT/DELETE | `/api/do/notes` | Notes CRUD |
| GET/POST/PUT/DELETE | `/api/do/calendar` | Calendar CRUD |
| POST | `/api/do/wipe` | Account wipe (called by gateway on user.deleted) |

### Hub

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/hub/search` | Search catalog + GitHub |
| POST | `/api/admin/hub/install` | Install skill from catalog/GitHub |
| POST | `/api/admin/hub/install-url` | Install from URL |
| GET | `/api/admin/hub/installed` | List installed hub skills |
| DELETE | `/api/admin/hub/installed/:name` | Uninstall hub skill |

### Webhooks

| Method | Path | Verification |
|--------|------|-------------|
| POST | `/webhook/telegram` | Secret token (timing-safe) |
| GET/POST | `/webhook/whatsapp` | HMAC-SHA256 |
| POST | `/webhook/evolution` | Evolution API key |
| POST | `/webhook/discord` | Ed25519 (slash commands) |
| POST | `/webhook/discord-bridge` | HMAC-SHA256 + timestamp (bridge messages) |
| POST | `/webhook/slack` | HMAC + timestamp |
| GET | `/mcp` | MCP server endpoint |

## Skills Hub

6 built-in skills: code-review, git-workflow, api-design, debug-strategy, meeting-notes, research-summary. 3 trusted GitHub repos (MiniMax AI, gstack, Cloudflare).

Sources: catalog (built-in), GitHub (trusted repos + public), URL (any HTTPS .md). All security-scanned + SHA-256 hashed.

## Quick Start

```bash
git clone https://github.com/marceloeatworld/clopinette-ai.git
cd clopinette-ai
cp wrangler.example.jsonc wrangler.jsonc
bun install

# Create resources
wrangler r2 bucket create clopinette-memories
wrangler r2 bucket create clopinette-skills
wrangler kv namespace create LINKS

# Required secrets
wrangler secret put MASTER_KEY           # openssl rand -base64 32
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_GATEWAY_ID
wrangler secret put WS_SIGNING_SECRET    # openssl rand -base64 32
wrangler secret put API_AUTH_KEY

# Deploy
bun run deploy
```

### Telegram

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
bun run deploy
curl -X POST https://your-worker.workers.dev/api/admin/setup-telegram \
  -H "Authorization: Bearer YOUR_API_AUTH_KEY"
```

### WhatsApp

```bash
wrangler secret put WHATSAPP_ACCESS_TOKEN
wrangler secret put WHATSAPP_VERIFY_TOKEN
wrangler secret put WHATSAPP_APP_SECRET
wrangler secret put WHATSAPP_PHONE_NUMBER_ID
# Set webhook URL in Meta portal: https://your-worker.workers.dev/webhook/whatsapp
```

### Discord

Discord uses two channels: **Interactions** (slash commands, works out of the box) and **Gateway bridge** (regular DM/channel messages, requires a small external service).

Discord has no webhook push for regular messages (unlike Telegram/WhatsApp) — the Gateway WebSocket is the only way. The bridge connects to Discord's Gateway, receives `MESSAGE_CREATE` events, and forwards them to the Worker via HMAC-signed HTTP POST.

```bash
# 1. Secrets
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_APPLICATION_ID
wrangler secret put DISCORD_TOKEN
bun run deploy

# 2. Register slash commands + generate bridge secret
curl -X POST https://your-worker.workers.dev/api/admin/setup-discord \
  -H "Authorization: Bearer YOUR_API_AUTH_KEY"
# Returns: { interactionsUrl, bridgeUrl, bridgeSecret }

# 3. Discord Developer Portal:
#    - General Information → set Interactions Endpoint URL to the interactionsUrl
#    - Bot → enable "Message Content Intent" (privileged)
#    - OAuth2 → generate invite link with scopes: bot, applications.commands
#      Bot permissions: Send Messages, Read Message History, Attach Files, Add Reactions

# 4. Bridge (for DMs + @mentions — deploy on Coolify or any Docker host)
cd workers/discord-bridge
# Set env vars: DISCORD_TOKEN, BRIDGE_SECRET (from step 2), WORKER_URL
docker compose up -d
```

Slash commands (`/ask`, `/status`, `/memory`, etc.) work immediately without the bridge. The bridge is only needed for natural conversation in DMs and @mentions in servers.

Bridge security: HMAC-SHA256 signature over `timestamp + body`, anti-replay (5 min window), timing-safe comparison. The shared secret never transits in the request. No public port exposed — the bridge only initiates outbound connections.

### Optional

```bash
# Search backends (automatic fallback: SearXNG → Brave API → Browser Rendering)
wrangler secret put SEARXNG_URL          # Self-hosted SearXNG instance URL (e.g. https://search.example.com)
wrangler secret put BRAVE_API_KEY        # Brave Search API key (free tier: 2000 queries/month)
wrangler secret put CF_BROWSER_TOKEN     # Browser Rendering API token (last resort + read/extract/crawl)

# Evolution API (self-hosted WhatsApp via Baileys)
wrangler secret put EVOLUTION_API_URL
wrangler secret put EVOLUTION_API_KEY

# Slack
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET

```

## Project Structure

```
src/
  index.ts              Hono router, webhooks, quota enforcement
  agent.ts              DO: sessions, notes, calendar, wipe, reminders, cron, delegation
  delegate-worker.ts    Lightweight DO for parallel sub-agent execution
  pipeline.ts           Inference pipeline (10 steps)
  prompt-builder.ts     System prompt (10 blocks)
  compression.ts        Structured compression + memory flush
  playwright-mcp.ts     PlaywrightMCP Durable Object (browser binding)
  crypto.ts             AES-GCM encryption
  token.ts              HMAC WebSocket tokens

  config/               Types, constants, personalities
  media/                Vision, Whisper, PDF, DOCX, XLSX extraction
  memory/               Prompt memory, FTS5 search, skills, self-learning, security
  tools/                11 tool implementations + registry
    web-tool.ts           Unified web (search, read, extract, scrape, links, crawl)
    docs-tool.ts          Unified docs (semantic + keyword search, ask, list)
    browser-tool.ts       Interactive Playwright MCP client
    memory-tool.ts        MEMORY.md / USER.md persistent notes
    session-search-tool.ts  FTS5 conversation history
    skills-tool.ts        Skill .md CRUD
    todo-tool.ts          Task list
    note-tool.ts          Personal notes
    calendar-tool.ts      Events + reminders
    image-gen-tool.ts     FLUX image generation
    tts-tool.ts           Deepgram text-to-speech
    clarify-tool.ts       Mid-execution questions
    delegate-tool.ts      Sub-agent delegation (single + batch)
    registry.ts           Tool registration, codemode, aliases
  hub/                  Skills catalog, GitHub source, URL source
  inference/            Provider, router, Anthropic cache control
  enterprise/           Auth, audit, budget, safe-compare
  gateway/              Telegram, WhatsApp, Evolution API, Slack, Discord adapters

workers/outbound/       SSRF-safe fetch proxy for codemode sandbox
workers/discord-bridge/ Discord Gateway bridge (Bun + Docker)
```

## Cloudflare Services

Workers, Durable Objects (SQLite + ephemeral), Workers AI, AI Gateway, KV, R2 (2 buckets), Browser Rendering, AutoRAG, Dynamic Workers (codemode).

Optional external: SearXNG (self-hosted), Brave Search API (free tier). Both are optional — falls back to Browser Rendering if unconfigured.

## Tests

```bash
bun run check    # TypeScript
bun run test     # Unit tests
BASE_URL=... API_KEY=... bun test/live/smoke.ts   # 14 e2e tests
```

## License

MIT
