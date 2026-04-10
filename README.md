# ClopinetteAI

Cloudflare-native AI agent with persistent memory, tools, self-learning, and multimodal I/O. One Durable Object per user, serverless. Runs on Cloudflare stack with optional SearXNG and Brave Search for fast web search.

> *Clopinette* = French for "next to nothing". An AI agent that costs clopinettes to run.

Inspired by [hermes-agent](https://github.com/NousResearch/hermes-agent) (Nous Research). Clean-room TypeScript rewrite for Cloudflare.

## Architecture

```
User (WebSocket / Telegram / WhatsApp / Evolution API / Discord / API / cron)
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
  1. Load inference config ── cached per session (per-provider, cross-provider aux supported)
  2. Smart routing — short greetings take a fast path that skips tools/compression/honcho
  3. Create model (session affinity for Workers AI prefix caching, Anthropic cache control for BYOK)
  4. Budget check (monthly token limit)
  5. Honcho context (optional external memory)
  6. Build system prompt (10 blocks, cached, PROMPT_VERSION invalidation)
  7. Context compression (structured summary at 40+ messages, iterative, parallel flush)
  8. Build tools (12 primary + aliases, or codemode sandbox)
  9. Process media (vision, Whisper STT, PDF/DOCX/XLSX/text extraction up to 20KB)
  10. LLM call (stream or generate, budget pressure, 429/529 auto-fallback, summary-from-tools on step-limit)
  11. Post-processing (FTS5 mirror, auto session title, usage report, self-learning)
```

### Multi-user isolation

Each user gets their own Durable Object. No shared data.

```
WebSocket "marcelo"         -> DO "marcelo"
Telegram chat 123 (linked)  -> DO "marcelo"     (via KV link:tg:123 -> marcelo)
Telegram chat 456 (free)    -> DO "tg_456"
WhatsApp +33... (linked)    -> DO "marcelo"
Discord DM 789 (linked)     -> DO "marcelo"     (via KV link:dc:789 -> marcelo)
Discord guild 555 (trusted) -> DO "marcelo"     (via KV link:dcg:555 -> marcelo)
Discord guild 666 (shared)  -> DO "dcg_666"     (via KV link:dcg:666 -> shared:marcelo)
```

### Identity linking

`/link` in Telegram/WhatsApp/Discord -> 5-min code -> enter in web app -> shared DO.

### Group modes (Telegram, Discord, WhatsApp)

Groups support two linking modes:

| Mode | KV value | DO | Memory | Self-learning |
|------|----------|-----|--------|---------------|
| **Trusted** (family) | `userId` | Owner's DO | Full (MEMORY.md + USER.md) | Yes |
| **Shared** (public) | `shared:userId` | Standalone (`dcg_`, `tg_`) | None | No |

- `/link trusted` — full memory shared with everyone. For family groups.
- `/link shared` — clean bot, no private memory. For friend groups.
- `/link` without argument in a group → shows mode choice.
- Quota is always billed to the account that linked the group.

## Tools

11 always-on tools + `browser` (conditional on `PlaywrightMCP` binding) + `delegate` (conditional on `DELEGATE_WORKER` binding). With codemode active, the LLM sees **8-10 tools**: 1 `codemode` sandbox wrapping 4-5 orchestration tools, 7 direct tools (side-effecting), and optionally `delegate`.

### Codemode tier (orchestration — wrapped in JS sandbox)

| Tool | Actions | Backend |
|------|---------|---------|
| `memory` | `read`, `add`, `replace`, `remove` | DO SQLite + R2 |
| `history` | full-text search by query | DO SQLite FTS5 |
| `skills` | `list`, `search`, `view`, `create`, `edit`, `patch`, `delete` | DO SQLite + R2 |
| `todo` | `list`, `add`, `done`, `remove` | DO SQLite |

`browser` (Playwright MCP: navigate, click, type, snapshot) is also wrapped in codemode when the `PlaywrightMCP` binding is present.

### Direct tier (side effects — called individually)

| Tool | Actions | Backend |
|------|---------|---------|
| `web` | `search`, `read`, `extract`, `scrape`, `links`, `crawl_start`, `crawl_check` | SearXNG / Brave API / CF Browser Rendering |
| `docs` | `search` (auto semantic/keyword), `ask`, `list` | R2 + Workers AI AutoRAG |
| `notes` | Personal notes: save, list, delete, edit, search (also pinnable via `/api/do/notes/:id/pin`) | DO SQLite |
| `calendar` | Events with one-shot reminders via `this.schedule()` | DO SQLite |
| `image` | Image generation | Workers AI (FLUX Schnell) |
| `tts` | Text-to-speech (12 voices) | Workers AI (Deepgram Aura) |
| `clarify` | Ask structured questions mid-execution | Passthrough |
| `delegate` | Spawn parallel sub-agents (single or batch up to 3, depth 2, 3 steps each) | DelegateWorker DOs (ephemeral, no SQLite) |

Delegate sub-agents inherit a minimal toolset — `memory`, `calendar`, `tts`, `image`, `notes`, `clarify`, `delegate`, and `mixture_of_agents` are blocked (see `DELEGATE_BLOCKED_TOOLS`).

### Web search

Automatic 3-tier fallback chain for search — fastest available backend wins:

| Tier | Backend | Speed | Limit | Config |
|------|---------|-------|-------|--------|
| 1 | **SearXNG** (self-hosted) | ~500ms | Unlimited | `SEARXNG_URL` |
| 2 | **Brave Search API** (free tier) | ~300ms | 2000/month | `BRAVE_API_KEY` |
| 3 | **CF Browser Rendering** `/scrape` | ~3-5s | Included | `CF_BROWSER_TOKEN` |

Browser Rendering uses session reuse (`sessionId` + `keep_alive`) to avoid 15-30s Chromium cold starts. Long pages are auto-summarized via the auxiliary model.

### Tool enhancements

- **Codemode**: when `LOADER` binding is set, orchestration tools wrap into a single JS sandbox tool. The LLM writes code with `Promise.all`, loops, conditionals — up to 5x token efficiency. Outbound fetches go through `CODEMODE_OUTBOUND` (SSRF-safe).
- **Budget pressure**: Hermes-style warnings injected into tool results at 70% (CAUTION) and 90% (CRITICAL) of `MAX_STEPS` (= 6).
- **Dedup cache**: same tool+args within 2s returns cached result (applies to every tool, delegates included).
- **Fuzzy matching**: Proxy-based — normalizes (lowercase, hyphens/spaces → underscores) then Levenshtein distance ≤ 2 (min 4 chars) corrects hallucinated tool names at dispatch time without polluting the tool schema.
- **Progress callbacks**: every tool invocation can fire `onToolProgress(name, preview)` — used by the Telegram gateway to send "thinking…" status messages mid-execution.
- **Backward-compat aliases**: old names (`web_search`, `web_browse`, `web_crawl`, `docs_search`, `ai_search`, `session_search`, `save_note`, `image_generate`, `text_to_speech`, `search`, etc.) still work as aliases.

## Memory (5 layers)

| Layer | Storage | Limit |
|-------|---------|-------|
| Prompt Memory | SQLite + R2 backup | MEMORY.md 2200 chars, USER.md 1375 chars |
| Session Search | SQLite FTS5 | All past messages, grouped search with context |
| Memory Flush | Pre-compression | Extracts facts before context loss |
| Skills | SQLite index + R2 files | Reusable `.md` with YAML frontmatter |
| Honcho | External API (opt-in) | AI-native user modeling |

Memory is frozen at session start (writes take effect next session for prefix cache stability). Security-scanned with Unicode NFKD normalization. Self-learning compacts when > 80% full. In shared group mode, MEMORY.md and USER.md are not injected and self-learning is disabled.

The per-user DO holds ~12 SQLite tables: `sessions`, `session_messages` (+ FTS5 virtual table and triggers), `prompt_memory`, `skills`, `notes`, `calendar_events`, `todos` (lazy-created by `todo-tool`), `cron_jobs`, `audit_log`, `doc_context`, `hub_installed`, `agent_config`, plus `cf_ai_chat_agent_messages` from `@cloudflare/ai-chat`. Only `MEMORY.md` and `USER.md` are mirrored to R2 — everything else is lost if the DO is wiped.

### Session lifecycle

Sessions auto-reset on idle (default 120 min) or daily at a configurable UTC hour (default 04:00). Reset mode is `both | idle | daily | none` and is tuned live via `/session`. The first user message of a session auto-generates a short summary title (first ~60 chars, no LLM call). A persistent SQLite turn counter triggers self-learning reviews every `REVIEW_INTERVAL` turns after `MIN_TURNS_BEFORE_REVIEW`, surviving DO hibernation (an older in-memory counter would silently reset on every cold start).

## Calendar

Events with optional one-shot reminders via `this.schedule(Date)`. Reminders delivered on WebSocket + Telegram + Discord + WhatsApp.

```
"RDV dentiste le 20 mars a 20h" -> calendar({ action: "create", title: "Dentiste", startAt: "2026-03-20T20:00:00", reminderMinutes: 30 })
```

## Inference

| Setting | Value |
|---------|-------|
| Default model | Kimi K2.5 (`@cf/moonshotai/kimi-k2.5`) via Workers AI |
| Auxiliary model | Gemma 4 26B A4B IT (`@cf/google/gemma-4-26b-a4b-it`) — routing, compression, self-learning, web summarization |
| Managed models | Trial + Pro plans get Kimi K2.5 and Gemma 4; BYOK plan = no managed models |
| BYOK | 12 providers via AI Gateway (per-provider config, cross-provider auxiliary supported) |
| Max steps | 6 parent, 3 delegate (depth 2, batch 3) |
| Max persisted messages | 200 |
| Prompt queue | Serial with 10s timeout (non-streaming paths only) |
| Prefix caching | Workers AI session affinity keyed on userId + cached system prompt (83% token savings) |
| Anthropic caching | Automatic `cache_control` injection when BYOK provider is Anthropic |
| Error recovery | 429/529 → immediate fallback to Workers AI default; summary-from-tools call on step-limit exhaustion |
| Context compression | Structured template at 40+ messages, iterative, parallel flush |

### Per-provider config + cross-provider auxiliary

Each BYOK provider keeps its own API key and model choice, so switching provider does not wipe the other's settings:

- `api_key:{provider}` — encrypted with per-user master-derived key
- `model:{provider}` — primary model for that provider
- `auxiliary_provider` — independent provider used for routing/compression/self-learning (falls back to primary)
- `auxiliary_model:{auxiliaryProvider}` — independent aux model (defaults to `AUXILIARY_MODEL` for Workers AI, or to the primary model for BYOK to avoid misrouting)

This lets the user run e.g. primary = OpenAI gpt-5 + auxiliary = Anthropic Claude Haiku, or primary = Workers AI Kimi + auxiliary = their own Groq key — the fast path swaps in the auxiliary provider's credentials transparently. Legacy single `api_key` / `model` rows are migrated to the per-provider schema on agent startup (idempotent).

### Fast path (smart routing)

`routeModel()` sends short (< 30 chars) exact greetings / acknowledgements — `hi`, `hello`, `bonjour`, `merci`, `ok`, `yes`, `what time`, etc. — to the auxiliary model and **skips tools, honcho context, context compression and system-prompt rebuilding**. Conversation history is preserved so the reply still makes sense in context. Budget is still enforced (no bypass via greetings). Any message that has used a tool in the last turn stays on the primary model regardless.

### Error recovery

1. **Rate limits (429 / 529 / "overloaded")** — logged and re-tried on the fallback model immediately, no back-off sleep.
2. **Any other model error** — `loadFallbackConfig()` returns `{ DEFAULT_MODEL, AUXILIARY_MODEL }` only if the primary call was BYOK; Workers AI primary has no fallback.
3. **Step limit with empty text** — one extra `generateText` call is made with just the user's last message + concatenated tool results ("no section headers or labels" instruction). Summary tokens are tracked separately under `trackAuxiliaryUsage`.

14 personality presets: `helpful`, `concise`, `technical`, `creative`, `teacher`, `kawaii`, `catgirl`, `pirate`, `shakespeare`, `surfer`, `noir`, `uwu`, `philosopher`, `hype`. Applied via `/personality <name>` and layered on top of `SOUL.md` in both the normal and fast paths.

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
| GET | `/api/admin/sessions` | List sessions (paginated) |
| GET | `/api/admin/sessions/:id/messages` | Session messages |
| DELETE | `/api/admin/sessions/:id` | Delete one session |
| DELETE | `/api/admin/sessions` | Delete all sessions |
| GET | `/api/admin/audit` | Audit log (paginated) |
| GET | `/api/admin/config` | Full agent config dump |
| DELETE | `/api/admin/config/:key` | Delete one config key |
| POST/GET/DELETE | `/api/admin/setup-telegram` | Register / inspect / delete Telegram webhook |
| POST/DELETE | `/api/admin/setup-discord` | Register slash commands + mint / delete bridge secret |

### DO Internal

Reached via direct DO fetch (no worker route — the DO handles them in `onRequest()`).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/do/setup` | Create agent inside the DO |
| POST | `/api/do/config` | Write one config key (with optional encryption) |
| GET | `/api/do/status` | Agent status inside the DO |
| GET/POST | `/api/do/notes` | List / create notes (auto-enriches URLs via og:title + og:description) |
| PUT/DELETE | `/api/do/notes/:id` | Edit or delete a note |
| POST | `/api/do/notes/:id/pin` | Toggle pinned state |
| GET/POST | `/api/do/calendar` | List / create calendar events |
| PUT/DELETE | `/api/do/calendar/:id` | Update / delete event (reminder re-scheduled automatically) |
| POST | `/api/do/wipe` | Account wipe — SQLite + R2 (`docs/`, `audio/`, `images/`, `skills/`, `MEMORY.md`, `USER.md`). Called by gateway on `user.deleted`. |

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
| POST | `/webhook/slack` | HMAC + timestamp (stub: only `url_verification` is handled, message handling returns 501) |
| GET | `/mcp` | MCP server endpoint (Bearer `API_AUTH_KEY`, proxies to `PlaywrightMCP` DO) |

### Elicitation (MCP-style)

The pipeline exposes an optional `elicitInput({ message, schema })` callback wired through to the WebSocket gateway. Tools can pause mid-execution to ask the user a structured question; the frontend replies with a `{ type: "elicitation_response", id, action, content }` message and the pending promise resolves with `accept | decline | cancel`. Pending requests are stored in the DO and expire on timeout.

## Skills Hub

6 built-in catalog skills (inline): `code-review`, `git-workflow`, `api-design`, `debug-strategy`, `meeting-notes`, `research-summary`. 3 trusted GitHub repos fetched dynamically: `MiniMax-AI/skills`, `garrytan/gstack`, `cloudflare/skills`.

Sources: `catalog` (built-in), `github` (trusted repos + arbitrary `owner/repo` on request), `url` (any HTTPS `.md`). All security-scanned + SHA-256 hashed at install time; installed bundles are tracked in `hub_installed`.

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
  index.ts              Hono router, webhooks, quota enforcement, admin + hub routes
  agent.ts              ClopinetteAgent DO: sessions, notes, calendar, wipe, reminders, cron, elicitation
  delegate-worker.ts    Ephemeral DO for parallel sub-agent execution (no SQLite)
  pipeline.ts           Inference pipeline (fast path + full 10 steps, error recovery, summary-from-tools)
  prompt-builder.ts     System prompt (10 blocks, cached per session)
  compression.ts        Structured compression + memory flush
  commands.ts           Platform-agnostic slash commands (/status, /memory, /personality, ...)
  playwright-mcp.ts     PlaywrightMCP Durable Object (browser binding)
  crypto.ts             AES-GCM encryption (per-user master-derived key)
  token.ts              HMAC WebSocket tokens

  config/               sql, types, constants, personalities (14 presets)
  media/                Vision (image), Whisper (voice), PDF/DOCX/XLSX extraction, ingest, handler
  memory/               Prompt memory, FTS5 search, skills, self-learning, security, flush, honcho
  tools/                12 tool implementations + registry
    web-tool.ts             Unified web (search, read, extract, scrape, links, crawl)
    docs-tool.ts            Unified docs (semantic + keyword search, ask, list)
    browser-tool.ts         Interactive Playwright MCP client (conditional)
    memory-tool.ts          MEMORY.md / USER.md persistent notes
    session-search-tool.ts  FTS5 conversation history
    skills-tool.ts          Skill .md CRUD
    todo-tool.ts            Task list
    note-tool.ts            Personal notes
    calendar-tool.ts        Events + reminders via this.schedule()
    image-gen-tool.ts       FLUX image generation
    tts-tool.ts             Deepgram text-to-speech
    clarify-tool.ts         Mid-execution questions
    delegate-tool.ts        Sub-agent delegation (single + batch, conditional)
    registry.ts             Tool registration, codemode resolve, aliases, fuzzy matching
  hub/                  Skills catalog (6 built-in), GitHub source (3 trusted repos), URL source
  inference/            provider.ts (per-provider config + cross-provider aux), router.ts (smart routing), prompt-caching.ts (Anthropic cache_control)
  enterprise/           Auth, audit, budget, safe-compare
  gateway/              Telegram, WhatsApp, Evolution API, Slack (stub), Discord (slash + bridge) adapters

workers/outbound/       SSRF-safe fetch proxy for codemode sandbox
workers/discord-bridge/ Discord Gateway bridge (Bun + Docker)

test/                   Unit tests (vitest) + live/smoke.ts (14 e2e tests)
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
