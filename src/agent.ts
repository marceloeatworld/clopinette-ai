import { AIChatAgent } from "@cloudflare/ai-chat";
import type { OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable } from "agents";
import { convertToModelMessages } from "ai";
import type { StreamTextOnFinishCallback, ToolSet } from "ai";
import { deriveMasterKey, encrypt } from "./crypto.js";
import { logAudit } from "./enterprise/audit.js";
import { verifyWsToken } from "./token.js";
import { timingSafeEqual } from "./enterprise/safe-compare.js";
import { handleTelegramUpdate, sendTelegramMessage } from "./gateway/telegram.js";
import { handleWhatsAppUpdate } from "./gateway/whatsapp.js";
import { handleDiscordInteraction, handleDiscordMessage, processInteractionDeferred, sendDiscordMessage } from "./gateway/discord.js";
import type { DiscordInteraction, DiscordBridgePayload } from "./gateway/discord.js";
import { runPipeline } from "./pipeline.js";
import { canReuseCachedSystemPrompt, getPromptCacheDay } from "./prompt-cache.js";
import { getSessionMessages } from "./memory/session-search.js";
import { getPromptMemory } from "./memory/prompt-memory.js";
import { handleCommand } from "./commands.js";
import type {
  AgentState,
  AgentConfigRow,
  AuditRow,
  ConfigEntry,
  HubInstalledEntry,
  InferenceConfig,
  MediaAsset,
  Platform,
  SessionRow,
  SessionMessageRow,
  StatusResponse,
} from "./config/types.js";
import {
  DEFAULT_MODEL,
  MAX_PERSISTED_MESSAGES,
  MEMORY_CHAR_LIMIT,
  USER_CHAR_LIMIT,
} from "./config/constants.js";
import type { Plan } from "./inference/provider.js";

/** Coerce the persisted plan string into the strict Plan union expected by provider.ts. */
function coercePlan(value: string | null | undefined): Plan {
  if (value === "trial" || value === "pro" || value === "byok") return value;
  return undefined;
}

export class ClopinetteAgent extends AIChatAgent<Env, AgentState> {
  maxPersistedMessages = MAX_PERSISTED_MESSAGES;

  initialState: AgentState = {
    status: "idle",
    currentModel: DEFAULT_MODEL,
    platform: "websocket",
    currentSessionId: null,
    currentSessionTitle: null,
    plan: null,
    tokensThisMonth: 0,
    tokensThisSession: 0,
    quotaAllowed: true,
    activeTool: null,
    pendingDelegates: [],
  };

  #sessionId: string | null = null;
  #userId: string = "default";
  /** Shared mode — group without owner's memory (set per-request via X-Shared-Mode header). */
  #sharedMode = false;
  /** Cached system prompt — invalidated on config change or code deploy. */
  #cachedSystemPrompt: string | null = null;
  /** UTC day for which the cached system prompt was built. */
  #cachedSystemPromptDay: string | null = null;
  /** Cached inference config — invalidated on config change. */
  #cachedInferenceConfig: InferenceConfig | null = null;
  /** Prompt version — bump on deploys that change the system prompt. */
  static PROMPT_VERSION = 2; // Increment this on system prompt changes
  #promptVersion: number = 0;
  /** Serial queue for non-streaming requests (Telegram, cron) to prevent race conditions.
   *  Without this, two concurrent requests could interleave at await points,
   *  causing the second request to miss the first's assistant message in history. */
  #promptQueue: Promise<unknown> = Promise.resolve();
  /** Recent Telegram update_ids — prevents duplicate processing on webhook retry. */
  #processedUpdateIds = new Set<number>();
  /** Pending elicitation requests — resolved when the frontend sends back a response. */
  #pendingElicitations = new Map<string, {
    resolve: (result: import("./pipeline.js").ElicitResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  #getCachedSystemPrompt(): string | null {
    return canReuseCachedSystemPrompt(
      this.#cachedSystemPrompt,
      this.#cachedSystemPromptDay,
      this.#promptVersion,
      ClopinetteAgent.PROMPT_VERSION,
    ) ? this.#cachedSystemPrompt : null;
  }

  #cacheSystemPrompt(prompt: string): void {
    this.#cachedSystemPrompt = prompt;
    this.#cachedSystemPromptDay = getPromptCacheDay();
    this.#promptVersion = ClopinetteAgent.PROMPT_VERSION;
  }

  // ───────────────────────── Lifecycle ─────────────────────────

  async onStart(): Promise<void> {
    this.#initSchema();
    this.#migrateLegacyConfig();
    this.#syncCurrentModelFromConfig();
    if (this.name) this.#userId = this.name;

    // Hydrate AgentState from SQLite + KV so the first WS message already has fresh live state
    await this.#hydrateAgentState();

    // Run post-schema tasks independently — a transient R2 failure should not block cron sync
    const results = await Promise.allSettled([
      this.#restoreMemoryFromR2(),
      this.#syncCronJobs(),
      this.#syncCalendarReminders(),
      this.#scheduleSkillUpdateCheck(),
    ]);
    for (const r of results) {
      if (r.status === "rejected") console.warn("onStart task failed:", r.reason);
    }
  }

  /**
   * Read the durable monthly token counter, with one-shot bootstrap from
   * `sessions.total_tokens` for users who pre-date the new counter.
   *
   * The counter row is created on first read if missing AND there's something
   * to bootstrap (so we don't write a useless `total: 0` row for fresh DOs).
   * Subsequent increments come from `incrementMonthlyTokens` in pipeline.ts.
   */
  #readMonthlyTokenCounter(): number {
    const month = new Date().toISOString().slice(0, 7);
    const row = this.sql<{ total: number }>`
      SELECT total FROM monthly_tokens WHERE month = ${month}
    `;
    if (row.length > 0) return row[0].total ?? 0;

    // Bootstrap from existing sessions data (first run after the migration).
    const monthStart = `${month}-01`;
    const bootstrap = this.sql<{ total: number }>`
      SELECT COALESCE(SUM(total_tokens), 0) as total FROM sessions WHERE started_at >= ${monthStart}
    `;
    const total = bootstrap[0]?.total ?? 0;
    if (total > 0) {
      this.sql`INSERT INTO monthly_tokens (month, total) VALUES (${month}, ${total})`;
    }
    return total;
  }

  /** Load plan, quota and token totals from KV + SQLite into the broadcasted AgentState. */
  async #hydrateAgentState(): Promise<void> {
    try {
      // Plan (pushed by the gateway cron + stripe webhooks)
      const plan = await this.env.LINKS.get(`plan:${this.#userId}`);

      // Quota cache (refreshed by the gateway cron every 5 min)
      const quotaRaw = await this.env.LINKS.get(`quota:${this.#userId}`);
      let quota: { allowed: boolean; reason?: string } | null = null;
      if (quotaRaw) {
        try { quota = JSON.parse(quotaRaw); } catch { /* malformed */ }
      }

      // Monthly token usage — read from the durable counter (survives /reset & /wipe).
      // First-run / migration: bootstrap from sessions.total_tokens once, then the
      // counter takes over and is incremented atomically by `incrementMonthlyTokens`.
      const tokensThisMonth = this.#readMonthlyTokenCounter();

      // Pending delegates still running for this user
      const pending = this.sql<{ id: string; goal: string; created_at: string }>`
        SELECT id, goal, created_at FROM pending_delegates
        WHERE status IN ('queued', 'running')
        ORDER BY created_at DESC LIMIT 10
      `;

      this.setState({
        ...this.state,
        plan,
        tokensThisMonth,
        quotaAllowed: quota?.allowed ?? true,
        quotaReason: quota?.reason,
        pendingDelegates: pending.map((p) => ({ id: p.id, goal: p.goal, startedAt: p.created_at })),
      });
    } catch (err) {
      console.warn("hydrate state failed:", err);
    }
  }

  /**
   * Migrate legacy single "api_key" and "model" rows to per-provider schema.
   * Idempotent — safe to run on every startup.
   *
   *   api_key              → api_key:{provider}   (dropped if provider is workers-ai/missing — orphan key)
   *   model                → model:{provider}     (kept for all providers including workers-ai)
   */
  #migrateLegacyConfig(): void {
    const providerRow = this.sql<{ value: string }>`
      SELECT value FROM agent_config WHERE key = 'provider'
    `;
    const provider = providerRow[0]?.value;

    // ── api_key migration ──
    const legacyKey = this.sql<{ value: string; encrypted: number; key_version: number }>`
      SELECT value, encrypted, key_version FROM agent_config WHERE key = 'api_key'
    `;
    if (legacyKey.length > 0) {
      if (!provider || provider === "workers-ai") {
        this.sql`DELETE FROM agent_config WHERE key = 'api_key'`;
      } else {
        const { value, encrypted, key_version } = legacyKey[0];
        this.sql`INSERT OR IGNORE INTO agent_config (key, value, encrypted, key_version, updated_at)
          VALUES (${`api_key:${provider}`}, ${value}, ${encrypted}, ${key_version}, datetime('now'))`;
        this.sql`DELETE FROM agent_config WHERE key = 'api_key'`;
      }
    }

    // ── model migration (all providers, including workers-ai) ──
    const legacyModel = this.sql<{ value: string; encrypted: number; key_version: number }>`
      SELECT value, encrypted, key_version FROM agent_config WHERE key = 'model'
    `;
    if (legacyModel.length > 0 && provider) {
      const { value, encrypted, key_version } = legacyModel[0];
      this.sql`INSERT OR IGNORE INTO agent_config (key, value, encrypted, key_version, updated_at)
        VALUES (${`model:${provider}`}, ${value}, ${encrypted}, ${key_version}, datetime('now'))`;
      this.sql`DELETE FROM agent_config WHERE key = 'model'`;
    }
    // If no provider, keep legacy model as-is (will be migrated on next config save)
  }

  async onConnect(
    conn: import("agents").Connection,
    ctx: { request: Request }
  ): Promise<void> {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token");

    // Path 1: signed JWT from gateway
    if (this.env.WS_SIGNING_SECRET && token) {
      const payload = await verifyWsToken(token, this.env.WS_SIGNING_SECRET);
      if (payload && payload.sub === this.name) return; // OK
      // Invalid JWT: fall through to API_AUTH_KEY
    }

    // Path 2: static API key
    const authKey = this.env.API_AUTH_KEY;
    if (authKey && token && timingSafeEqual(token, authKey)) return; // OK

    // Reject everything else (fail-closed)
    conn.close(4001, "Unauthorized");
  }

  // ───────────────────────── WS message intercept ─────────────────────────

  async onMessage(
    connection: import("agents").Connection,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message === "string") {
      let data: { type?: string; id?: string; action?: string; content?: Record<string, unknown> } | null = null;
      try { data = JSON.parse(message); } catch { /* not JSON, pass through */ }

      if (data?.type === "elicitation_response" && data.id) {
        const pending = this.#pendingElicitations.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.#pendingElicitations.delete(data.id);
          pending.resolve({
            action: (data.action as "accept" | "decline" | "cancel") ?? "cancel",
            content: data.content as Record<string, string | number | boolean | string[]> | undefined,
          });
        }
        return;
      }
    }
    return super.onMessage(connection, message);
  }

  // ───────────────────────── HTTP (webhooks) ─────────────────────────

  async onRequest(request: Request): Promise<Response> {
    try {
    const url = new URL(request.url);

    // Shared mode — group without owner's memory (header set by Worker based on KV link value)
    this.#sharedMode = request.headers.get("X-Shared-Mode") === "true";

    // Telegram webhooks — return 200 immediately, process in DO background (no time limit).
    // The Worker forwards the request and waits for this response. By returning early,
    // the Worker completes before Telegram's 60s timeout. The DO continues via waitUntil.
    if (request.method === "POST" && url.pathname.includes("/webhook/telegram")) {
      await this.#ensureSession("telegram");
      const botToken = request.headers.get("X-Bot-Token") ?? "";
      const body = await request.text();
      const bgRequest = new Request(request.url, { method: "POST", headers: request.headers, body });
      this.ctx.waitUntil(handleTelegramUpdate(bgRequest, {
        sql: this.sql.bind(this),
        env: this.env,
        sessionId: this.#sessionId!,
        userId: this.#userId,
        botToken,
        runPrompt: (text, media, onToolProgress, chatId) => this.runPrompt(text, "telegram", media, onToolProgress, chatId),
        r2Memories: this.env.MEMORIES,
        onCacheInvalidate: () => {
          this.#cachedSystemPrompt = null;
          this.#cachedInferenceConfig = null;
        },
        isUpdateProcessed: (id) => {
          if (this.#processedUpdateIds.has(id)) return true;
          this.#processedUpdateIds.add(id);
          if (this.#processedUpdateIds.size > 200) {
            const ids = [...this.#processedUpdateIds];
            this.#processedUpdateIds = new Set(ids.slice(-100));
          }
          return false;
        },
      }).catch(err => console.error("[telegram] handler error:", err)));
      return new Response("ok");
    }

    // WhatsApp webhooks — Meta Cloud API (access token + phone info via headers)
    if (request.method === "POST" && url.pathname.includes("/webhook/whatsapp")) {
      await this.#ensureSession("whatsapp");
      const accessToken = request.headers.get("X-WA-Access-Token") ?? "";
      const phoneNumberId = request.headers.get("X-WA-Phone-Number-Id") ?? "";
      const rawBody = await request.text();
      return handleWhatsAppUpdate(rawBody, {
        sql: this.sql.bind(this),
        env: this.env,
        sessionId: this.#sessionId!,
        userId: this.#userId,
        accessToken,
        phoneNumberId,
        runPrompt: (text, media, onToolProgress, chatId) => this.runPrompt(text, "whatsapp", media, onToolProgress, chatId),
        r2Memories: this.env.MEMORIES,
        onCacheInvalidate: () => {
          this.#cachedSystemPrompt = null;
          this.#cachedInferenceConfig = null;
        },
      });
    }

    // Evolution API webhooks — self-hosted WhatsApp via Baileys
    if (request.method === "POST" && url.pathname.includes("/webhook/evolution")) {
      await this.#ensureSession("whatsapp");
      const instanceName = request.headers.get("X-Evolution-Instance") ?? `clop-${this.#userId}`;
      const rawBody = await request.text();
      const { handleEvolutionUpdate } = await import("./gateway/evolution.js");
      return handleEvolutionUpdate(rawBody, {
        sql: this.sql.bind(this),
        env: this.env,
        sessionId: this.#sessionId!,
        userId: this.#userId,
        apiUrl: this.env.EVOLUTION_API_URL!,
        apiKey: this.env.EVOLUTION_API_KEY!,
        instanceName,
        runPrompt: (text, media, onToolProgress, chatId) => this.runPrompt(text, "whatsapp", media, onToolProgress, chatId),
        r2Memories: this.env.MEMORIES,
        onCacheInvalidate: () => {
          this.#cachedSystemPrompt = null;
          this.#cachedInferenceConfig = null;
        },
      });
    }

    // Discord — Interactions (slash commands) and bridge messages
    if (request.method === "POST" && (url.pathname.includes("/webhook/discord") || url.pathname.includes("/webhook/discord-bridge"))) {
      await this.#ensureSession("discord");
      const botToken = request.headers.get("X-Discord-Token") ?? "";
      const applicationId = request.headers.get("X-Discord-Application-Id") ?? "";
      const source = request.headers.get("X-Discord-Source") ?? "";
      const rawBody = await request.text();

      const discordCtx = {
        sql: this.sql.bind(this),
        env: this.env,
        sessionId: this.#sessionId!,
        userId: this.#userId,
        botToken,
        applicationId,
        runPrompt: (text: string, media?: MediaAsset[], onToolProgress?: (toolName: string, preview: string) => void, chatId?: string) =>
          this.runPrompt(text, "discord", media, onToolProgress, chatId),
        r2Memories: this.env.MEMORIES,
        onCacheInvalidate: () => {
          this.#cachedSystemPrompt = null;
          this.#cachedInferenceConfig = null;
        },
      };

      if (source === "interaction") {
        // Slash command — return the initial response (type 5 deferred) to Discord,
        // then process asynchronously in the DO background (no time limit).
        const interaction: DiscordInteraction = JSON.parse(rawBody);
        const response = await handleDiscordInteraction(interaction, discordCtx);

        // For deferred responses (type 5), process in background
        if (interaction.type === 2 && interaction.data && !["link", "help"].includes(interaction.data.name)) {
          this.ctx.waitUntil(
            processInteractionDeferred(interaction, discordCtx)
              .catch(err => console.error("[discord] interaction error:", err))
          );
        }
        return response;
      }

      // Bridge message — return 200 immediately, process in background
      const payload: DiscordBridgePayload = JSON.parse(rawBody);
      if (payload.type === "MESSAGE_CREATE" && payload.message) {
        this.ctx.waitUntil(
          handleDiscordMessage(payload.message, discordCtx)
            .catch(err => console.error("[discord] bridge message error:", err))
        );
      }
      return new Response("ok");
    }

    return super.onRequest(request);
    } catch (err) {
      console.error("onRequest error:", err instanceof Error ? err.message : String(err));
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }

  // ───────────────────────── WebSocket Chat (streaming) ─────────────────────────

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    await this.#ensureSession("websocket");

    // Extract user text from SDK-managed messages
    const lastMsg = this.messages[this.messages.length - 1];
    const userText = lastMsg?.role === "user"
      ? ((lastMsg.parts ?? [])
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n") || "")
      : "";

    // Detect [media:filename] markers — load images from R2 for vision
    const mediaAssets: MediaAsset[] = [];
    const mediaPattern = /\[media:([^\]]+)\]/g;
    let match;
    while ((match = mediaPattern.exec(userText)) !== null) {
      const filename = match[1];
      const r2Key = `${sanitizeUserId(this.#userId)}/docs/${filename}`;
      const obj = await this.env.MEMORIES.head(r2Key);
      if (obj) {
        const mime = obj.httpMetadata?.contentType ?? "application/octet-stream";
        const isImage = mime.startsWith("image/");
        mediaAssets.push({
          type: isImage ? "image" : "document",
          r2Key,
          mimeType: mime,
          originalName: filename,
          sizeBytes: obj.size,
        });
      }
    }
    let cleanUserText = userText.replace(mediaPattern, "").trim();

    // Handle slash commands (/reset, /memory, /forget, /wipe, etc.) — works on ALL gateways
    const cmdResult = await handleCommand(cleanUserText, {
      sql: this.sql.bind(this),
      sessionId: this.#sessionId!,
      userId: this.#userId,
      env: this.env,
      r2Memories: this.env.MEMORIES,
      r2Skills: this.env.SKILLS,
      onCacheInvalidate: () => {
        this.#cachedSystemPrompt = null;
        this.#cachedInferenceConfig = null;
      },
    });
    if (cmdResult?.handled === true) {
      // Send directly over WS — HTTP Responses from onChatMessage are not
      // surfaced to the frontend in the cf_agent_use_chat protocol
      for (const ws of this.ctx.getWebSockets()) {
        ws.send(JSON.stringify({ type: "command_result", text: cmdResult.text }));
      }
      return;
    }
    if (cmdResult?.handled === false) {
      // Rewrite mode (e.g. /research) — replace user text with the structured
      // prompt and continue through the normal pipeline.
      cleanUserText = cmdResult.rewriteAs;
    }

    const recentToolUse = this.messages.slice(-5).some(m =>
      (m.parts ?? []).some(p => p.type === "tool-invocation")
    );

    // Convert SDK messages to ModelMessage format
    const messages = await convertToModelMessages(this.messages);

    const result = await runPipeline(
      {
        platform: "websocket",
        userId: this.#userId,
        sessionId: this.#sessionId!,
        plan: coercePlan(this.state.plan),
        sql: this.sql.bind(this),
        env: this.env,
        messages,
        userText: cleanUserText,
        mediaAssets: mediaAssets.length > 0 ? mediaAssets : undefined,
        abortSignal: options?.abortSignal,
        enableCodemode: !!this.env.LOADER,
        enableCompression: true,
        enableSelfLearning: true,
        recentToolUse: recentToolUse ? 1 : 0,
        cachedSystemPrompt: this.#getCachedSystemPrompt(),
        cachedInferenceConfig: this.#cachedInferenceConfig,
        onCacheSystemPrompt: (p) => { this.#cacheSystemPrompt(p); },
        onCacheInferenceConfig: (c) => { this.#cachedInferenceConfig = c; },
        onStateChange: (status) => {
          this.setState({
            ...this.state,
            status,
            ...(status === "idle" ? { activeTool: null } : {}),
          });
        },
        onComplete: (result) => {
          // Update token accounting in live state
          const added = result.usage ? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0) : 0;

          // Refresh pending delegates (tools may have inserted new pending rows during the turn)
          const pending = this.sql<{ id: string; goal: string; created_at: string }>`
            SELECT id, goal, created_at FROM pending_delegates
            WHERE status IN ('queued', 'running')
            ORDER BY created_at DESC LIMIT 10
          `;

          this.setState({
            ...this.state,
            tokensThisMonth: this.state.tokensThisMonth + added,
            tokensThisSession: this.state.tokensThisSession + added,
            pendingDelegates: pending.map((p) => ({ id: p.id, goal: p.goal, startedAt: p.created_at })),
          });

          // Deliver generated media (TTS audio, images) to WebSocket clients
          if (result.mediaDelivery?.length) {
            for (const ws of this.ctx.getWebSockets()) {
              ws.send(JSON.stringify({
                type: "media_delivery",
                media: result.mediaDelivery,
              }));
            }
          }
        },
        queueTask: (task) => {
          this.queue("executeBackgroundTask" as keyof this, task).catch((err) =>
            console.warn("Failed to queue background task:", err));
        },
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        elicitInput: (params) => this.elicitInput(params),
        onToolProgress: (toolName, preview) => {
          this.setState({ ...this.state, activeTool: toolName });
          for (const ws of this.ctx.getWebSockets()) {
            ws.send(JSON.stringify({ type: "tool_progress", tool: toolName, preview }));
          }
        },
      },
      "stream"
    );

    if ("error" in result) {
      this.setState({ ...this.state, status: "idle" });
      // Surface the error to WS clients so the frontend can display it
      for (const ws of this.ctx.getWebSockets()) {
        ws.send(JSON.stringify({ type: "error", message: result.error }));
      }
      return new Response(
        JSON.stringify({ error: result.error }),
        { status: result.status, headers: { "Content-Type": "application/json" } }
      );
    }

    if (result.mode === "stream") {
      return result.stream.toUIMessageStreamResponse();
    }
  }

  // ───────────────────────── Public: runPrompt (non-streaming) ─────────────────────────

  /**
   * Run a prompt through the full pipeline (non-streaming).
   * Used by Telegram, cron, delegate auto-resume, and any future gateway.
   *
   * `chatId` is the platform-native conversation id (Telegram chat id, WhatsApp
   * phone, Discord channel id, Evolution remoteJid). Captured here so the
   * `delegate` tool can persist it on `pending_delegates` and the auto-resume
   * push knows where to deliver the synthesized result.
   */
  async runPrompt(
    userText: string,
    platform: Platform,
    mediaAssets?: MediaAsset[],
    onToolProgress?: (toolName: string, preview: string) => void,
    chatId?: string,
  ): Promise<{ text: string } | { error: string }> {
    // Serial queue with 30s timeout. Messages wait their turn to avoid context mixing.
    // If a previous prompt is stuck for >30s, proceed concurrently as fallback.
    const raceResult = await Promise.race([
      this.#promptQueue.then(() => "ready" as const),
      new Promise<"timeout">(r => setTimeout(() => r("timeout"), 10_000)),
    ]);
    if (raceResult === "timeout") {
      console.warn("[queue] Previous prompt still running after 10s, proceeding concurrently");
      return this.#runPromptInner(userText, platform, mediaAssets, onToolProgress, chatId);
    }
    const task = this.#promptQueue.then(() => this.#runPromptInner(userText, platform, mediaAssets, onToolProgress, chatId));
    this.#promptQueue = task.catch(() => {});
    return task;
  }

  async #runPromptInner(
    userText: string,
    platform: Platform,
    mediaAssets?: MediaAsset[],
    onToolProgress?: (toolName: string, preview: string) => void,
    chatId?: string,
  ): Promise<{ text: string; mediaDelivery?: import("./pipeline.js").MediaDelivery[] } | { error: string }> {
    await this.#ensureSession(platform);
    const sqlBound = this.sql.bind(this);

    // Handle slash commands (/reset, /memory, /forget, /wipe, etc.)
    let effectiveUserText = userText;
    const cmdResult = await handleCommand(userText, {
      sql: sqlBound,
      sessionId: this.#sessionId!,
      userId: this.#userId,
      env: this.env,
      r2Memories: this.env.MEMORIES,
      r2Skills: this.env.SKILLS,
      onCacheInvalidate: () => {
        this.#cachedSystemPrompt = null;
        this.#cachedInferenceConfig = null;
      },
    });
    if (cmdResult?.handled === true) return { text: cmdResult.text };
    if (cmdResult?.handled === false) {
      // Rewrite mode (e.g. /research) — replace user text and run the pipeline.
      effectiveUserText = cmdResult.rewriteAs;
    }

    // Always load conversation history — even for simple messages, the fast path
    // now keeps context so the agent doesn't "forget" what was just said
    const historyRows = getSessionMessages(sqlBound, this.#sessionId!, 20);
    const messages = historyRows
      .reverse()
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

    const result = await runPipeline(
      {
        platform,
        userId: this.#userId,
        sessionId: this.#sessionId!,
        chatId,
        plan: coercePlan(this.state.plan),
        sql: sqlBound,
        env: this.env,
        messages: [...messages, { role: "user" as const, content: effectiveUserText }],
        userText: effectiveUserText,
        mediaAssets,
        enableCodemode: !!this.env.LOADER,
        enableCompression: false,
        enableSelfLearning: !this.#sharedMode,
        sharedMode: this.#sharedMode,
        cachedSystemPrompt: this.#getCachedSystemPrompt(),
        cachedInferenceConfig: this.#cachedInferenceConfig,
        onCacheSystemPrompt: (p) => { this.#cacheSystemPrompt(p); },
        onCacheInferenceConfig: (c) => { this.#cachedInferenceConfig = c; },
        onStateChange: (status) => {
          this.setState({ ...this.state, status });
        },
        queueTask: (task) => {
          this.queue("executeBackgroundTask" as keyof this, task).catch((err) =>
            console.warn("Failed to queue background task:", err));
        },
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        elicitInput: (params) => this.elicitInput(params),
        onToolProgress,
      },
      "generate"
    );

    if ("error" in result) return { error: result.error };
    if (result.mode === "generate") return { text: result.text, mediaDelivery: result.mediaDelivery };
    return { error: "unexpected stream mode" };
  }

  // ───────────────────────── RPC (callable from Worker) ─────────────────────────

  @callable()
  async setup(displayName?: string): Promise<{ ok: true }> {
    if (displayName) {
      this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('display_name', ${displayName})`;
    }
    // Seed default SOUL.md if not already set
    const existing = this.sql<{ value: string }>`SELECT value FROM agent_config WHERE key = 'soul_md'`;
    if (!existing.length || !existing[0].value) {
      const { DEFAULT_SOUL_MD } = await import("./config/constants.js");
      this.sql`INSERT OR REPLACE INTO agent_config (key, value, encrypted, updated_at)
        VALUES ('soul_md', ${DEFAULT_SOUL_MD}, 0, datetime('now'))`;
    }
    return { ok: true };
  }

  static ALLOWED_CONFIG_KEYS = new Set([
    "api_key", "provider", "model", "auxiliary_provider", "soul_md", "autorag_name", "display_name",
    "honcho_base_url", "honcho_api_key", "honcho_app_id", "token_budget", "personality",
  ]);

  /** Accepts whitelisted keys plus per-provider keys (api_key:{p}, model:{p}, auxiliary_model:{p}). */
  static isAllowedConfigKey(key: string): boolean {
    if (ClopinetteAgent.ALLOWED_CONFIG_KEYS.has(key)) return true;
    for (const prefix of ["api_key:", "model:", "auxiliary_model:"]) {
      if (key.startsWith(prefix)) {
        const provider = key.slice(prefix.length);
        return provider.length > 0 && /^[a-z0-9_-]+$/.test(provider);
      }
    }
    return false;
  }

  @callable()
  async updateConfig(
    key: string,
    value: string,
    shouldEncrypt: boolean
  ): Promise<void> {
    if (!ClopinetteAgent.isAllowedConfigKey(key)) {
      throw new Error(`Invalid config key: ${key}`);
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      if (shouldEncrypt) {
        const masterKey = await deriveMasterKey(this.env.MASTER_KEY);
        const encrypted = await encrypt(value, masterKey);
        this.sql`INSERT OR REPLACE INTO agent_config (key, value, encrypted, key_version, updated_at)
          VALUES (${key}, ${encrypted}, 1, 1, datetime('now'))`;
        logAudit(this.sql.bind(this), "config.encrypt", key);
      } else {
        this.sql`INSERT OR REPLACE INTO agent_config (key, value, encrypted, updated_at)
          VALUES (${key}, ${value}, 0, datetime('now'))`;
        logAudit(this.sql.bind(this), "config.update", key);
      }
      // Invalidate caches — config change means prompt/model may differ
      this.#cachedSystemPrompt = null;
      this.#cachedInferenceConfig = null;
    });

    // Keep state.currentModel synced so dashboards and session logging reflect the current config
    if (key === "provider" || key.startsWith("model:") || key === "model") {
      this.#syncCurrentModelFromConfig();
    }
  }

  /** Re-resolve the effective model from config and push into state.currentModel. */
  #syncCurrentModelFromConfig(): void {
    const rows = this.sql<{ key: string; value: string }>`
      SELECT key, value FROM agent_config
      WHERE key IN ('provider', 'model') OR key LIKE 'model:%'
    `;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const provider = map.get("provider");
    const effectiveModel = (provider ? map.get(`model:${provider}`) : undefined) ?? map.get("model") ?? DEFAULT_MODEL;
    if (this.state.currentModel !== effectiveModel) {
      this.setState({ ...this.state, currentModel: effectiveModel });
    }
  }

  @callable()
  async getStatus(): Promise<StatusResponse> {
    const rows = this.sql<AgentConfigRow & { value: string }>`SELECT key, value FROM agent_config`;
    const providerRow = rows.find((r) => r.key === "provider");
    const provider = providerRow?.value;

    // Build per-provider models map (model:openai → "gpt-4o", ...)
    const configuredModels: Record<string, string> = {};
    const configuredAuxiliaryModels: Record<string, string> = {};
    for (const r of rows) {
      if (r.key.startsWith("model:")) configuredModels[r.key.slice("model:".length)] = r.value;
      else if (r.key.startsWith("auxiliary_model:")) configuredAuxiliaryModels[r.key.slice("auxiliary_model:".length)] = r.value;
    }
    // Legacy model row — expose under active provider if no per-provider row exists
    const legacyModel = rows.find((r) => r.key === "model")?.value;
    if (legacyModel && provider && !configuredModels[provider]) configuredModels[provider] = legacyModel;

    const auxiliaryProvider = rows.find((r) => r.key === "auxiliary_provider")?.value;
    const effectiveAuxProvider = auxiliaryProvider ?? provider;

    return {
      ok: true,
      currentModel: this.state.currentModel,
      currentProvider: provider,
      configuredModel: provider ? configuredModels[provider] : legacyModel,
      configuredModels,
      currentAuxiliaryProvider: auxiliaryProvider,
      configuredAuxiliaryModel: effectiveAuxProvider ? configuredAuxiliaryModels[effectiveAuxProvider] : undefined,
      configuredAuxiliaryModels,
      platform: this.state.platform,
      status: this.state.status,
      // Internal keys (starting with `_`) are pipeline state — turn counter,
      // delegate sentinels, schema version. They are not user-configurable
      // and should not appear in the dashboard "Configured keys" list.
      configuredKeys: rows.map((r) => r.key).filter((k) => !k.startsWith("_")),
    };
  }

  /**
   * RPC entry point used by `delegate-workflow.ts` to fetch the user's
   * inference config without going through SQLite directly. The workflow runs
   * in a separate isolate and doesn't share the agent's master key, so it
   * cannot decrypt API keys on its own — only the DO can.
   *
   * Returns the decrypted InferenceConfig + the user's plan so the workflow
   * can build the right model via `createModel` / `createAuxiliaryModel`.
   * Throws PlanViolationError when BYOK is misconfigured (caller surfaces it).
   */
  @callable()
  async getInferenceConfigForDelegation(): Promise<{
    config: import("./config/types.js").InferenceConfig;
    plan: Plan;
  }> {
    const { loadInferenceConfig } = await import("./inference/provider.js");
    const plan = coercePlan(this.state.plan);
    const config = await loadInferenceConfig(this.sql.bind(this), this.env.MASTER_KEY, plan);
    return { config, plan };
  }

  // ───────────────────────── Admin (callable from Worker) ─────────────────────────

  @callable()
  async getMemory(type: "memory" | "user"): Promise<{ content: string }> {
    const { getPromptMemory } = await import("./memory/prompt-memory.js");
    return { content: getPromptMemory(this.sql.bind(this), type) };
  }

  @callable()
  async setMemory(type: "memory" | "user", content: string): Promise<{ ok: boolean; error?: string }> {
    const { scanForThreats } = await import("./memory/security.js");
    const threat = scanForThreats(content);
    if (threat) return { ok: false, error: `Blocked: ${threat}` };

    const limit = type === "memory" ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT;
    if (content.length > limit) return { ok: false, error: `Exceeds ${limit} char limit` };

    this.sql`UPDATE prompt_memory SET content = ${content}, updated_at = datetime('now')
      WHERE type = ${type}`;
    // R2 backup (sanitize userId for path safety)
    const safeId = this.#userId.replace(/[^a-zA-Z0-9_-]/g, "");
    const r2Path = `${safeId}/${type === "memory" ? "MEMORY" : "USER"}.md`;
    await this.env.MEMORIES.put(r2Path, content);
    logAudit(this.sql.bind(this), "admin.memory.write", type);
    this.#cachedSystemPrompt = null;
    return { ok: true };
  }

  @callable()
  async getSoulMd(): Promise<{ content: string }> {
    const rows = this.sql<{ value: string }>`SELECT value FROM agent_config WHERE key = 'soul_md'`;
    return { content: rows[0]?.value ?? "" };
  }

  @callable()
  async setSoulMd(content: string): Promise<{ ok: boolean; error?: string }> {
    const { scanForThreats } = await import("./memory/security.js");
    const threat = scanForThreats(content);
    if (threat) return { ok: false, error: `Blocked: ${threat}` };

    this.sql`INSERT OR REPLACE INTO agent_config (key, value, encrypted, updated_at)
      VALUES ('soul_md', ${content}, 0, datetime('now'))`;
    logAudit(this.sql.bind(this), "admin.soul.write");
    this.#cachedSystemPrompt = null;
    return { ok: true };
  }

  @callable()
  async listSkillsAdmin(): Promise<{ skills: import("./memory/skills.js").SkillMeta[] }> {
    const { listSkills } = await import("./memory/skills.js");
    return { skills: listSkills(this.sql.bind(this)) };
  }

  @callable()
  async getSkillAdmin(name: string): Promise<import("./memory/skills.js").SkillFull | null> {
    const { getSkill } = await import("./memory/skills.js");
    return getSkill(this.sql.bind(this), this.env.SKILLS, this.#userId, name);
  }

  @callable()
  async setSkillAdmin(
    name: string,
    content: string,
    meta: { category?: string; description?: string; triggerPattern?: string }
  ): Promise<{ ok: boolean; error?: string }> {
    const { createSkill, editSkill } = await import("./memory/skills.js");
    // Try create first, then edit if exists
    const createResult = await createSkill(
      this.sql.bind(this), this.env.SKILLS, this.#userId, name, content, meta
    );
    if (createResult.ok) {
      logAudit(this.sql.bind(this), "admin.skill.write", name);
      return createResult;
    }
    if (createResult.error?.includes("already exists")) {
      const editResult = await editSkill(
        this.sql.bind(this), this.env.SKILLS, this.#userId, name, content, meta
      );
      if (editResult.ok) logAudit(this.sql.bind(this), "admin.skill.write", name);
      return editResult;
    }
    return createResult;
  }

  @callable()
  async deleteSkillAdmin(name: string): Promise<{ ok: boolean }> {
    const { deleteSkill } = await import("./memory/skills.js");
    const result = await deleteSkill(this.sql.bind(this), this.env.SKILLS, this.#userId, name);
    if (result.ok) logAudit(this.sql.bind(this), "admin.skill.delete", name);
    return result;
  }

  @callable()
  async getAuditLog(limit = 50, offset = 0): Promise<{ entries: AuditRow[] }> {
    const rows = this.sql<AuditRow>`
      SELECT id, action, details, created_at FROM audit_log
      ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}
    `;
    return { entries: rows };
  }

  @callable()
  async listSessions(limit = 20, offset = 0): Promise<{ sessions: SessionRow[] }> {
    const rows = this.sql<SessionRow>`
      SELECT * FROM sessions ORDER BY started_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    return { sessions: rows };
  }

  @callable()
  async getSessionMessagesAdmin(sessionId: string, limit = 50): Promise<{ messages: SessionMessageRow[] }> {
    const rows = this.sql<SessionMessageRow>`
      SELECT * FROM session_messages WHERE session_id = ${sessionId}
      ORDER BY id DESC LIMIT ${limit}
    `;
    return { messages: rows.reverse() };
  }

  @callable()
  async deleteSession(sessionId: string): Promise<{ ok: boolean }> {
    this.sql`DELETE FROM session_messages WHERE session_id = ${sessionId}`;
    this.sql`DELETE FROM sessions WHERE id = ${sessionId}`;
    if (sessionId === this.#sessionId) this.#sessionId = null;
    logAudit(this.sql.bind(this), "session.delete", sessionId);
    return { ok: true };
  }

  @callable()
  async deleteAllSessions(): Promise<{ ok: boolean; deleted: number }> {
    const rows = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM sessions`;
    const count = rows[0]?.count ?? 0;
    this.sql`DELETE FROM session_messages`;
    this.sql`DELETE FROM sessions`;
    this.#sessionId = null;
    logAudit(this.sql.bind(this), "session.delete_all", `${count} sessions`);
    return { ok: true, deleted: count };
  }

  @callable()
  async getFullConfig(): Promise<{ config: ConfigEntry[] }> {
    const rows = this.sql<{ key: string; value: string; encrypted: number; updated_at: string }>`
      SELECT key, value, encrypted, updated_at FROM agent_config
    `;
    return {
      config: rows.map(r => ({
        key: r.key,
        value: r.encrypted ? "***" : r.value,
        encrypted: !!r.encrypted,
        updated_at: r.updated_at,
      })),
    };
  }

  @callable()
  async deleteConfig(key: string): Promise<{ ok: boolean; error?: string }> {
    if (!ClopinetteAgent.isAllowedConfigKey(key)) {
      return { ok: false, error: `Cannot delete key: ${key}` };
    }
    this.sql`DELETE FROM agent_config WHERE key = ${key}`;
    logAudit(this.sql.bind(this), "admin.config.delete", key);
    this.#cachedSystemPrompt = null;
    this.#cachedInferenceConfig = null;
    return { ok: true };
  }

  // ───────────────────────── Skills Hub ─────────────────────────

  @callable()
  async hubSearch(query: string, source?: string, limit = 50): Promise<{ results: import("./hub/types.js").HubSkillMeta[] }> {
    const results: import("./hub/types.js").HubSkillMeta[] = [];

    // Set GitHub token for authenticated API calls (5000 req/h vs 60)
    const { GitHubSource } = await import("./hub/github-source.js");
    GitHubSource.setToken(this.env.GITHUB_TOKEN);
    const { TRUSTED_REPOS } = await import("./hub/catalog.js");
    const selectedTrustedRepos = source && source !== "github"
      ? TRUSTED_REPOS.filter((repo) => repo.id === source || repo.collection === source)
      : TRUSTED_REPOS;

    if (!source || source === "catalog") {
      const { searchCatalog } = await import("./hub/catalog.js");
      results.push(...searchCatalog(query, limit));
    }

    if (!source || source === "github" || selectedTrustedRepos.length > 0) {
      const { GitHubSource } = await import("./hub/github-source.js");
      const gh = new GitHubSource();

      // Index trusted repos (cached, 1 API call per repo)
      const repoResults = await Promise.all(
        selectedTrustedRepos.map((repo) =>
          gh.listRepoSkills(
            repo.owner,
            repo.repo,
            repo.path,
            repo.trustLevel,
            repo.collection,
            repo.label,
          ),
        )
      );
      const allRepoSkills = repoResults.flat();

      if (query) {
        const q = query.toLowerCase();
        results.push(...allRepoSkills.filter(s =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.tags?.some((tag) => tag.toLowerCase().includes(q)) ||
          s.collectionLabel?.toLowerCase().includes(q)
        ));
        // Also search broader GitHub
        if (!source || source === "github") {
          results.push(...await gh.search(query, limit));
        }
      } else {
        results.push(...allRepoSkills);
      }
    }

    // Deduplicate by identifier
    const seen = new Set<string>();
    const deduped = results.filter(s => {
      if (seen.has(s.identifier)) return false;
      seen.add(s.identifier);
      return true;
    });

    return { results: deduped.slice(0, limit) };
  }

  @callable()
  async hubInstall(source: string, identifier: string): Promise<import("./hub/types.js").HubInstallResult> {
    const { installSkill } = await import("./hub/install.js");
    let bundle: import("./hub/types.js").HubSkillBundle | null = null;

    if (source === "catalog") {
      const { getCatalogSkill } = await import("./hub/catalog.js");
      const skill = getCatalogSkill(identifier);
      if (skill) {
        bundle = { meta: skill.meta, content: skill.content, frontmatter: {} };
      }
    } else if (source === "github") {
      const { GitHubSource } = await import("./hub/github-source.js");
      GitHubSource.setToken(this.env.GITHUB_TOKEN);
      bundle = await new GitHubSource().fetch(identifier);
    } else if (source === "url") {
      const { URLSource } = await import("./hub/url-source.js");
      bundle = await new URLSource().fetch(identifier);
    }

    if (!bundle) return { ok: false, error: `Skill not found: ${source}:${identifier}` };
    return installSkill(this.sql.bind(this), this.env.SKILLS, this.#userId, bundle);
  }

  @callable()
  async hubInstallFromUrl(url: string, name?: string): Promise<import("./hub/types.js").HubInstallResult> {
    const { URLSource } = await import("./hub/url-source.js");
    const { installSkill } = await import("./hub/install.js");
    const bundle = await new URLSource().fetch(url);
    if (!bundle) return { ok: false, error: "Failed to fetch skill from URL" };
    if (name) bundle.meta.name = name;
    return installSkill(this.sql.bind(this), this.env.SKILLS, this.#userId, bundle);
  }

  @callable()
  async hubUninstall(name: string): Promise<{ ok: boolean; error?: string }> {
    const { uninstallSkill } = await import("./hub/install.js");
    return uninstallSkill(this.sql.bind(this), this.env.SKILLS, this.#userId, name);
  }

  @callable()
  async hubListInstalled(): Promise<{ installed: HubInstalledEntry[] }> {
    const { listInstalled } = await import("./hub/install.js");
    return { installed: listInstalled(this.sql.bind(this)) };
  }

  // ───────────────────────── Notes CRUD (RPC @callable) ─────────────────────────

  @callable()
  async listNotes(): Promise<{
    notes: Record<string, Array<{ id: number; content: string; source: string; pinned: number; created_at: string; updated_at: string }>>;
    pinned: Array<{ id: number; content: string; source: string; pinned: number; created_at: string; updated_at: string }>;
  }> {
    const rows = this.sql<{ id: number; content: string; source: string; pinned: number; created_at: string; updated_at: string }>`
      SELECT id, content, source, pinned, created_at, updated_at FROM notes ORDER BY pinned DESC, created_at DESC LIMIT 500
    `;
    const pinned = rows.filter((r) => r.pinned);
    const rest = rows.filter((r) => !r.pinned);
    const grouped: Record<string, typeof rows> = {};
    for (const note of rest) {
      const day = note.created_at.slice(0, 10);
      (grouped[day] ??= []).push(note);
    }
    return { notes: grouped, pinned };
  }

  @callable()
  async createNote(content: string, source?: string): Promise<{ id: number }> {
    if (!content?.trim()) throw new Error("Content required");
    if (content.length > MAX_NOTE_LENGTH) throw new Error(`Max ${MAX_NOTE_LENGTH} chars`);
    const safeSource = VALID_SOURCES.has(source ?? "") ? (source as string) : "manual";
    const enriched = await enrichNoteUrl(content.trim());
    const finalContent = enriched.length > MAX_NOTE_LENGTH ? enriched.slice(0, MAX_NOTE_LENGTH) : enriched;
    this.sql`INSERT INTO notes (content, source) VALUES (${finalContent}, ${safeSource})`;
    const row = this.sql<{ id: number }>`SELECT last_insert_rowid() as id`;
    return { id: row[0]?.id ?? 0 };
  }

  @callable()
  async updateNote(noteId: number, content: string): Promise<{ ok: true }> {
    if (!content?.trim()) throw new Error("Content required");
    if (content.length > MAX_NOTE_LENGTH) throw new Error(`Max ${MAX_NOTE_LENGTH} chars`);
    this.sql`UPDATE notes SET content = ${content.trim()}, updated_at = datetime('now') WHERE id = ${noteId}`;
    return { ok: true };
  }

  @callable()
  async deleteNote(noteId: number): Promise<{ ok: true }> {
    this.sql`DELETE FROM notes WHERE id = ${noteId}`;
    return { ok: true };
  }

  @callable()
  async pinNote(noteId: number): Promise<{ ok: true }> {
    this.sql`UPDATE notes SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE id = ${noteId}`;
    return { ok: true };
  }

  // ───────────────────────── Calendar CRUD (RPC @callable) ─────────────────────────

  @callable()
  async listCalendarEvents(opts?: { from?: string; to?: string; limit?: number }): Promise<{
    events: Record<string, Array<{ id: string; title: string; description: string | null; start_at: string; end_at: string | null; all_day: number; location: string | null; reminder_minutes: number | null; reminder_delivered: number; source: string; created_at: string; updated_at: string }>>;
    total: number;
  }> {
    const from = opts?.from ?? new Date().toISOString().slice(0, 10);
    const toRaw = opts?.to ?? new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const to = toRaw.includes("T") ? toRaw : toRaw + "T23:59:59";
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const rows = this.sql<{
      id: string; title: string; description: string | null; start_at: string;
      end_at: string | null; all_day: number; location: string | null;
      reminder_minutes: number | null; reminder_delivered: number;
      source: string; created_at: string; updated_at: string;
    }>`SELECT * FROM calendar_events
       WHERE start_at >= ${from} AND start_at <= ${to}
       ORDER BY start_at ASC LIMIT ${limit}`;
    const grouped: Record<string, typeof rows> = {};
    for (const evt of rows) {
      const day = evt.start_at.slice(0, 10);
      (grouped[day] ??= []).push(evt);
    }
    return { events: grouped, total: rows.length };
  }

  @callable()
  async createCalendarEvent(input: {
    title: string; startAt: string; endAt?: string; allDay?: boolean;
    location?: string; description?: string; reminderMinutes?: number;
  }): Promise<{ id: string; title: string; startAt: string }> {
    if (!input.title?.trim()) throw new Error("Title required");
    if (!input.startAt) throw new Error("startAt required");
    const id = crypto.randomUUID();
    this.sql`INSERT INTO calendar_events (id, title, description, start_at, end_at, all_day, location, reminder_minutes, source)
      VALUES (${id}, ${input.title.trim()}, ${input.description ?? null}, ${input.startAt},
              ${input.endAt ?? null}, ${input.allDay ? 1 : 0}, ${input.location ?? null},
              ${input.reminderMinutes ?? null}, 'manual')`;
    if (input.reminderMinutes != null) {
      const fireAt = new Date(new Date(input.startAt).getTime() - input.reminderMinutes * 60_000);
      if (fireAt > new Date()) {
        await this.schedule(fireAt, "executeReminder" as keyof this, { eventId: id });
      }
    }
    return { id, title: input.title.trim(), startAt: input.startAt };
  }

  @callable()
  async updateCalendarEvent(
    eventId: string,
    input: {
      title?: string; startAt?: string; endAt?: string; allDay?: boolean;
      location?: string; description?: string; reminderMinutes?: number | null;
    }
  ): Promise<{ ok: true }> {
    const exists = this.sql<{ id: string }>`SELECT id FROM calendar_events WHERE id = ${eventId}`;
    if (exists.length === 0) throw new Error("Event not found");
    if (input.title !== undefined) this.sql`UPDATE calendar_events SET title = ${input.title.trim()} WHERE id = ${eventId}`;
    if (input.startAt !== undefined) this.sql`UPDATE calendar_events SET start_at = ${input.startAt} WHERE id = ${eventId}`;
    if (input.endAt !== undefined) this.sql`UPDATE calendar_events SET end_at = ${input.endAt} WHERE id = ${eventId}`;
    if (input.allDay !== undefined) this.sql`UPDATE calendar_events SET all_day = ${input.allDay ? 1 : 0} WHERE id = ${eventId}`;
    if (input.location !== undefined) this.sql`UPDATE calendar_events SET location = ${input.location} WHERE id = ${eventId}`;
    if (input.description !== undefined) this.sql`UPDATE calendar_events SET description = ${input.description} WHERE id = ${eventId}`;
    if (input.reminderMinutes !== undefined) {
      this.sql`UPDATE calendar_events SET reminder_minutes = ${input.reminderMinutes}, reminder_delivered = 0 WHERE id = ${eventId}`;
    }
    this.sql`UPDATE calendar_events SET updated_at = datetime('now') WHERE id = ${eventId}`;
    if (input.startAt !== undefined || input.reminderMinutes !== undefined) {
      const evt = this.sql<{ start_at: string; reminder_minutes: number | null }>`
        SELECT start_at, reminder_minutes FROM calendar_events WHERE id = ${eventId}`;
      if (evt.length > 0 && evt[0].reminder_minutes != null) {
        const fireAt = new Date(new Date(evt[0].start_at).getTime() - evt[0].reminder_minutes * 60_000);
        if (fireAt > new Date()) {
          await this.schedule(fireAt, "executeReminder" as keyof this, { eventId });
        }
      }
    }
    return { ok: true };
  }

  @callable()
  async deleteCalendarEvent(eventId: string): Promise<{ ok: true }> {
    const exists = this.sql<{ id: string }>`SELECT id FROM calendar_events WHERE id = ${eventId}`;
    if (exists.length === 0) throw new Error("Event not found");
    this.sql`DELETE FROM calendar_events WHERE id = ${eventId}`;
    return { ok: true };
  }

  // ───────────────────────── Wipe account (RPC @callable) ─────────────────────────

  @callable()
  async wipeAccount(): Promise<{ ok: true; wiped: true }> {
    // Note: table names must be literals (SQL tagged templates parameterize values, not identifiers)
    try { this.sql`DELETE FROM sessions`; } catch { /* table may not exist */ }
    try { this.sql`DELETE FROM session_messages`; } catch { /* */ }
    try { this.sql`DELETE FROM notes`; } catch { /* */ }
    try { this.sql`DELETE FROM calendar_events`; } catch { /* */ }
    try { this.sql`DELETE FROM skills`; } catch { /* */ }
    try { this.sql`DELETE FROM cron_jobs`; } catch { /* */ }
    try { this.sql`DELETE FROM audit_log`; } catch { /* */ }
    try { this.sql`DELETE FROM doc_context`; } catch { /* */ }
    try { this.sql`DELETE FROM hub_installed`; } catch { /* */ }
    try { this.sql`DELETE FROM todos`; } catch { /* */ }
    this.sql`UPDATE prompt_memory SET content = '', updated_at = datetime('now')`;
    this.sql`DELETE FROM agent_config`;
    this.sql`DELETE FROM cf_ai_chat_agent_messages`;
    const safeId = this.#userId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (safeId) {
      try {
        for (const prefix of [
          `${safeId}/docs/`,
          `${safeId}/audio/`,
          `${safeId}/images/`,
          `${safeId}/skills/`,
          `${safeId}/spillover/`,
        ]) {
          const listed = await this.env.MEMORIES.list({ prefix, limit: 1000 });
          if (listed.objects.length > 0) {
            await this.env.MEMORIES.delete(listed.objects.map((o) => o.key));
          }
        }
        await this.env.MEMORIES.delete(`${safeId}/MEMORY.md`).catch(() => {});
        await this.env.MEMORIES.delete(`${safeId}/USER.md`).catch(() => {});
      } catch { /* R2 may be unavailable */ }
      try {
        const skillsList = await this.env.SKILLS.list({ prefix: `${safeId}/`, limit: 1000 });
        if (skillsList.objects.length > 0) {
          await this.env.SKILLS.delete(skillsList.objects.map((o) => o.key));
        }
      } catch { /* R2 may be unavailable */ }
    }
    // Vectorize purge — Vectorize has no deleteByFilter so we query by userId + batch-delete ids
    if (this.env.VECTORS) {
      try {
        const { deleteUserVectors } = await import("./memory/vector-search.js");
        await deleteUserVectors(this.env.AI, this.env.VECTORS, this.#userId);
      } catch { /* non-fatal */ }
    }
    this.#sessionId = null;
    this.#cachedSystemPrompt = null;
    this.#cachedInferenceConfig = null;
    logAudit(this.sql.bind(this), "session.delete_all", "account wipe");
    return { ok: true, wiped: true };
  }

  // ───────────────────────── Vector backfill (RPC @callable) ─────────────────────────

  /**
   * Called by the BackfillVectorsWorkflow to stream message batches for embedding.
   * Bypasses the normal tool-search path — this is a raw dump of session_messages ordered by id.
   */
  @callable()
  async fetchMessagesForBackfill(offset: number, limit: number): Promise<Array<{ id: number; sessionId: string; role: string; content: string }>> {
    const rows = this.sql<{ id: number; session_id: string; role: string; content: string }>`
      SELECT id, session_id, role, content FROM session_messages
      ORDER BY id ASC LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, role: r.role, content: r.content }));
  }

  /**
   * Kick off a one-shot backfill Workflow that embeds every message in this user's DO.
   * Returns immediately with the workflow instance id; progress is observable via
   * `wrangler workflows instances describe backfill-vectors-workflow <id>`.
   */
  @callable()
  async startBackfillVectors(batchSize?: number): Promise<{ workflowId: string }> {
    if (!this.env.BACKFILL_VECTORS_WORKFLOW) {
      throw new Error("BACKFILL_VECTORS_WORKFLOW binding missing");
    }
    const workflowId = `backfill-${this.#userId}-${Date.now()}`;
    await this.env.BACKFILL_VECTORS_WORKFLOW.create({
      id: workflowId,
      params: {
        userId: this.#userId,
        batchSize: batchSize ?? 50,
        startOffset: 0,
      },
    });
    logAudit(this.sql.bind(this), "vector.backfill_start", workflowId);
    return { workflowId };
  }

  // ───────────────────────── Delegate completion callback (RPC @callable) ─────────────────────────

  /**
   * Called by `DelegateWorkflow` via cross-worker RPC when a delegated task finishes.
   *
   * Flow (hermes-agent notify_on_complete pattern — PR #5779, extended with auto-resume):
   * 1. Lookup row + reject if already processed (`completed_at` already set ⇒ retry)
   * 2. UPDATE the row with the result (sets `completed_at`, becomes the dedup marker)
   * 3. Inject a synthetic system message into `session_messages`
   * 4. Track auxiliary token usage
   * 5. Push WS `delegate_result` so the live dashboard updates immediately
   * 6. If this is the LAST queued/running delegate of the session, schedule the
   *    `delegateResume` background task. That task runs a fresh LLM turn over the
   *    delegate summaries and dispatches the synthesized reply via the originating
   *    gateway (web / Telegram / WhatsApp / Discord).
   *
   * Idempotency: the entire body runs inside `blockConcurrencyWhile`, so two
   * concurrent completions are serialized. The completed_at-based dedup at the
   * top makes the handler safe against `notify_parent` retries.
   */
  @callable()
  async onDelegateComplete(result: {
    id: string;
    sessionId: string;
    status: "success" | "error";
    modelId?: string;
    summary: string;
    toolTrace: string[];
    durationSeconds: number;
    tokensIn: number;
    tokensOut: number;
  }): Promise<{ ok: true }> {
    const { id, sessionId, status, modelId, summary, toolTrace, durationSeconds, tokensIn, tokensOut } = result;
    const sqlBound = this.sql.bind(this);

    let scheduleResume: { platform: string | null; chatId: string | null } | null = null;
    let pushPayload: { goal: string; statusOut: string } | null = null;

    await this.ctx.blockConcurrencyWhile(async () => {
      // 1. Lookup the row + dedup against retries (completed_at already set ⇒ no-op)
      const existing = sqlBound<{
        goal: string; platform: string | null; chat_id: string | null; completed_at: string | null;
      }>`
        SELECT goal, platform, chat_id, completed_at FROM pending_delegates WHERE id = ${id}`;
      if (existing.length === 0) {
        // Row missing — DO was wiped between create and complete. Nothing to do.
        return;
      }
      if (existing[0].completed_at) {
        // Retry of a notify_parent that already succeeded once. Drop silently.
        return;
      }
      const goal = existing[0].goal;
      const platform = existing[0].platform;
      const chatId = existing[0].chat_id;

      // 2. UPDATE the row — completed_at becomes the dedup marker for future retries
      sqlBound`UPDATE pending_delegates
        SET status = ${status}, summary = ${summary}, tool_trace = ${JSON.stringify(toolTrace)},
            tokens_in = ${tokensIn}, tokens_out = ${tokensOut},
            duration_seconds = ${durationSeconds}, completed_at = datetime('now')
        WHERE id = ${id}`;

      // 3. Inject synthetic system message into the session history
      const tag = status === "success" ? "completed" : "failed";
      const toolList = toolTrace.length > 0 ? ` (${toolTrace.join(", ")})` : "";
      const content = `[Delegate ${tag} in ${durationSeconds}s${toolList}]\nGoal: ${goal}\n\n${summary}`;
      sqlBound`INSERT INTO session_messages (session_id, role, content) VALUES (${sessionId}, ${"system"}, ${content})`;

      // 4. Track tokens + report usage (queue-backed)
      if (tokensIn > 0 || tokensOut > 0) {
        const { trackAuxiliaryUsage } = await import("./pipeline.js");
        trackAuxiliaryUsage(
          sqlBound, sessionId, tokensIn, tokensOut,
          modelId || "delegate-workflow", this.env, this.#userId,
          (promise) => this.ctx.waitUntil(promise),
        );
      }

      // 5. Remove from pendingDelegates live state
      this.setState({
        ...this.state,
        pendingDelegates: this.state.pendingDelegates.filter((d) => d.id !== id),
      });
      pushPayload = { goal, statusOut: status };

      logAudit(sqlBound, "delegate.complete", `${id}:${status}`);

      // 6. Last-delegate check — only schedule the resume here, since we hold
      // the lock and the UPDATE above has already landed.
      const remaining = sqlBound<{ cnt: number }>`
        SELECT COUNT(*) AS cnt FROM pending_delegates
        WHERE session_id = ${sessionId} AND status IN ('queued', 'running')
      `;
      if ((remaining[0]?.cnt ?? 0) === 0) {
        scheduleResume = { platform, chatId };
      }
    });

    // The WS push and queue() schedule happen OUTSIDE the lock so the lock window
    // stays as small as possible. Both are no-ops if the dedup branch fired.
    if (pushPayload) {
      const payload = pushPayload as { goal: string; statusOut: string };
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify({
            type: "delegate_result",
            id,
            status: payload.statusOut,
            goal: payload.goal,
            summary,
            durationSeconds,
          }));
        } catch { /* socket closed */ }
      }
    }

    if (scheduleResume) {
      const target = scheduleResume as { platform: string | null; chatId: string | null };
      this.queue("executeBackgroundTask" as keyof this, {
        type: "delegateResume",
        sessionId,
        platform: target.platform,
        chatId: target.chatId,
      } satisfies import("./pipeline.js").BackgroundTask).catch((err) =>
        console.warn("Failed to queue delegateResume task:", err));
    }

    return { ok: true };
  }

  // ───────────────────────── Hub Skills Auto-Update (daily) ─────────────────────────

  async executeSkillUpdateCheck(): Promise<void> {
    try {
      const { checkSkillUpdates } = await import("./hub/install.js");
      const result = await checkSkillUpdates(this.sql.bind(this), this.env.SKILLS, this.#userId);
      if (result.updated > 0) {
        console.log(`Skills auto-update: ${result.updated}/${result.checked} updated`);
      }
      if (result.errors.length > 0) {
        console.warn("Skills auto-update errors:", result.errors);
      }
    } catch (err) {
      console.warn("Skills auto-update failed:", err);
    }
    // Re-schedule for next day
    await this.#scheduleSkillUpdateCheck();
  }

  async #scheduleSkillUpdateCheck(): Promise<void> {
    try {
      const nextRun = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await this.schedule(nextRun, "executeSkillUpdateCheck" as keyof this, {}, { idempotent: true });
    } catch (err) {
      console.warn("Failed to schedule skill update check:", err);
    }
  }

  // ───────────────────────── Cron Scheduler ─────────────────────────

  async executeCronJob(payload: { jobId: string }): Promise<void> {
    const rows = this.sql<{
      id: string; prompt: string; platform: string | null; chat_id: string | null;
      skill: string | null; deliver: string | null;
    }>`SELECT id, prompt, platform, chat_id, skill, deliver FROM cron_jobs
       WHERE id = ${payload.jobId} AND enabled = 1`;
    if (rows.length === 0) return;

    const job = rows[0];
    try {
      // Build prompt — inject skill content if attached
      let fullPrompt = "";
      if (job.skill) {
        const { getSkill } = await import("./memory/skills.js");
        const skill = await getSkill(this.sql, this.env.SKILLS, this.#userId, job.skill);
        if (skill?.content) {
          fullPrompt += `[SYSTEM: The following skill "${job.skill}" is loaded for this task.]\n\n${skill.content}\n\n`;
        }
      }
      // Silent suppression hint (Hermes-style)
      fullPrompt += `[SYSTEM: If you have a meaningful status report or findings, send them. ` +
        `Only respond with exactly "[SILENT]" (nothing else) when there is genuinely nothing new to report. ` +
        `[SILENT] suppresses delivery to the user. Never combine [SILENT] with content.]\n\n`;
      fullPrompt += job.prompt;

      const result = await this.runPrompt(fullPrompt, (job.platform as Platform) ?? "api");
      if ("error" in result) {
        console.error(`Cron job ${job.id} error: ${result.error}`);
        // Errors always deliver
        await this.#deliverCronResult(job, `Cron job error: ${result.error}`);
        return;
      }

      // [SILENT] check — skip delivery if agent says nothing to report
      const isSilent = result.text.trim().toUpperCase().startsWith("[SILENT]");
      if (!isSilent) {
        await this.#deliverCronResult(job, result.text);
      }

      this.sql`UPDATE cron_jobs SET last_run = datetime('now') WHERE id = ${job.id}`;
      logAudit(this.sql.bind(this), "cron.execute", `${job.id}${isSilent ? " [SILENT]" : ""}: ${job.prompt.slice(0, 50)}`);
    } catch (err) {
      console.error(`Cron job ${payload.jobId} failed:`, err);
    }
  }

  /** Deliver cron result to the appropriate platform. */
  async #deliverCronResult(
    job: { platform: string | null; chat_id: string | null; deliver: string | null },
    text: string,
  ): Promise<void> {
    const target = job.deliver ?? "origin";
    const platform = target === "origin" ? job.platform : target.split(":")[0];
    const chatId = target === "origin" ? job.chat_id : target.split(":")[1] ?? job.chat_id;
    await this.#deliverToOrigin(platform, chatId, text);
  }

  /**
   * Generic delivery helper — push a synthesized text reply back to the originating
   * conversation. Used by both `#deliverCronResult` and the delegate auto-resume.
   *
   * For websocket sessions there is no chat_id, so we fan-out to every connected WS
   * as a delegate-style assistant message. For Telegram / WhatsApp / Discord / Evolution
   * we dispatch via the gateway-specific send functions.
   */
  async #deliverToOrigin(
    platform: string | null | undefined,
    chatId: string | null | undefined,
    text: string,
  ): Promise<void> {
    if (!text) return;

    // Web / API sessions — broadcast to any connected WebSocket. The frontend
    // already handles `delegate_result` and renders it as an assistant message.
    if (!platform || platform === "websocket" || platform === "api") {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify({
            type: "delegate_result",
            id: crypto.randomUUID(),
            status: "success",
            goal: "Auto-resume",
            summary: text,
            durationSeconds: 0,
          }));
        } catch { /* socket closed */ }
      }
      return;
    }

    if (!chatId) {
      console.warn(`[deliverToOrigin] platform=${platform} but chatId missing — dropping reply`);
      return;
    }

    switch (platform) {
      case "telegram": {
        const token = this.env.TELEGRAM_BOT_TOKEN;
        if (token) await sendTelegramMessage(token, parseInt(chatId, 10), text);
        break;
      }
      case "whatsapp": {
        // Try Meta Cloud API first; fall back to Evolution if configured
        const accessToken = this.env.WHATSAPP_ACCESS_TOKEN;
        const phoneId = this.env.WHATSAPP_PHONE_NUMBER_ID;
        if (accessToken && phoneId) {
          const { sendWhatsAppMessage } = await import("./gateway/whatsapp.js");
          await sendWhatsAppMessage(accessToken, phoneId, chatId, text);
        } else if (this.env.EVOLUTION_API_URL && this.env.EVOLUTION_API_KEY) {
          const { sendEvolutionMessage } = await import("./gateway/evolution.js");
          await sendEvolutionMessage(
            this.env.EVOLUTION_API_URL, this.env.EVOLUTION_API_KEY,
            `clop-${this.#userId}`, chatId, text,
          );
        }
        break;
      }
      case "discord": {
        const dcToken = this.env.DISCORD_TOKEN;
        if (dcToken) await sendDiscordMessage(dcToken, chatId, text);
        break;
      }
      default:
        console.warn(`[deliverToOrigin] no handler for platform "${platform}"`);
    }
  }

  // ───────────────────────── Calendar Reminders ─────────────────────────

  async executeReminder(payload: { eventId: string }): Promise<void> {
    const rows = this.sql<{
      id: string; title: string; description: string | null;
      start_at: string; location: string | null; reminder_delivered: number;
    }>`SELECT id, title, description, start_at, location, reminder_delivered
       FROM calendar_events WHERE id = ${payload.eventId}`;
    if (rows.length === 0) return;

    const evt = rows[0];
    if (evt.reminder_delivered) return;

    // Format reminder message
    const date = new Date(evt.start_at);
    const timeStr = date.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
    let msg = `Rappel : ${evt.title} — ${timeStr}`;
    if (evt.location) msg += `\n${evt.location}`;
    if (evt.description) msg += `\n${evt.description}`;

    // Deliver to all WebSocket connections
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: "calendar_reminder", eventId: evt.id, text: msg }));
      } catch { /* connection may be closed */ }
    }

    // Deliver to Telegram if linked
    // KV schema: key="link:tg:<chatId>" value=<userId>
    if (this.env.TELEGRAM_BOT_TOKEN) {
      try {
        const keys = await this.env.LINKS.list({ prefix: "link:tg:" });
        for (const key of keys.keys) {
          const val = await this.env.LINKS.get(key.name);
          if (val === this.#userId) {
            const chatId = key.name.replace("link:tg:", "");
            await sendTelegramMessage(this.env.TELEGRAM_BOT_TOKEN, parseInt(chatId, 10), msg);
            break;
          }
        }
      } catch (err) {
        console.warn("Calendar reminder TG delivery failed:", err);
      }
    }

    // Mark delivered
    this.sql`UPDATE calendar_events SET reminder_delivered = 1 WHERE id = ${evt.id}`;
  }

  async #syncCalendarReminders(): Promise<void> {
    const events = this.sql<{ id: string; start_at: string; reminder_minutes: number }>`
      SELECT id, start_at, reminder_minutes FROM calendar_events
      WHERE reminder_minutes IS NOT NULL AND reminder_delivered = 0
        AND start_at > datetime('now')
    `;
    for (const evt of events) {
      const fireAt = new Date(new Date(evt.start_at).getTime() - evt.reminder_minutes * 60_000);
      if (fireAt > new Date()) {
        try {
          await this.schedule(fireAt, "executeReminder" as keyof this, { eventId: evt.id }, { idempotent: true });
        } catch (err) {
          console.warn(`Failed to schedule reminder for event ${evt.id}:`, err);
        }
      }
    }
  }

  // ───────────────────────── Elicitation ─────────────────────────

  /**
   * Request structured input from the user mid-tool-execution.
   * Sends an elicitation_request over WS and waits for the response.
   * Times out after 2 minutes (returns { action: "cancel" }).
   */
  async elicitInput(params: import("./pipeline.js").ElicitParams): Promise<import("./pipeline.js").ElicitResult> {
    const id = crypto.randomUUID();
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      return { action: "cancel" };
    }

    for (const ws of sockets) {
      ws.send(JSON.stringify({
        type: "elicitation_request",
        id,
        message: params.message,
        schema: params.schema,
      }));
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingElicitations.delete(id);
        resolve({ action: "cancel" });
      }, 120_000);
      this.#pendingElicitations.set(id, { resolve, timer });
    });
  }

  // ───────────────────────── Background Task Queue ─────────────────────────

  async executeBackgroundTask(task: import("./pipeline.js").BackgroundTask): Promise<void> {
    try {
      switch (task.type) {
        case "selfLearning": {
          const { runSelfLearningReview } = await import("./memory/self-learning.js");
          const { trackAuxiliaryUsage } = await import("./pipeline.js");
          const { loadInferenceConfig, createAuxiliaryModel, PlanViolationError } = await import("./inference/provider.js");
          const sqlBound = this.sql.bind(this);
          // Build the same auxiliary model the live pipeline would use, so BYOK
          // background reviews charge the user's BYOK provider — never our Workers AI.
          let auxiliary: { model: import("ai").LanguageModel; modelId: string };
          try {
            const plan = coercePlan(this.state.plan);
            const config = await loadInferenceConfig(sqlBound, this.env.MASTER_KEY, plan);
            auxiliary = createAuxiliaryModel(config, this.env, plan);
          } catch (err) {
            if (err instanceof PlanViolationError) {
              console.warn(`[selfLearning] skipped — ${err.message}`);
              break;
            }
            throw err;
          }
          const r = await runSelfLearningReview(
            task.summary, sqlBound, auxiliary.model,
            this.env.MEMORIES, this.env.SKILLS, task.userId, task.options
          );
          if (r.tokensIn > 0 || r.tokensOut > 0) {
            trackAuxiliaryUsage(
              sqlBound, task.sessionId, r.tokensIn, r.tokensOut,
              auxiliary.modelId, this.env, task.userId,
              (promise) => this.ctx.waitUntil(promise),
            );
          }
          if (r.memoryActions > 0 || r.skillActions > 0) {
            console.log(`Self-learning: ${r.memoryActions} memory, ${r.skillActions} skill updates`);
          }
          break;
        }
        case "r2ContextUpdate": {
          const { updateContext } = await import("./media/handler.js");
          await updateContext(this.env.MEMORIES, task.r2Key, task.context);
          break;
        }
        case "delegateResume": {
          // Build the synthesis prompt INLINE from pending_delegates rows.
          // We can't rely on the synthetic system messages we inject in
          // session_messages — `#runPromptInner` filters role='system' out
          // of history before calling runPipeline, so the LLM would see the
          // synthesis instruction but none of the delegate results.
          //
          // Instead we construct a single user message that contains every
          // completed delegate summary verbatim, plus the instruction to
          // synthesize. This works on all platforms uniformly.
          const sqlBound = this.sql.bind(this);
          const completed = sqlBound<{
            goal: string; status: string; summary: string | null; duration_seconds: number;
          }>`
            SELECT goal, status, summary, duration_seconds FROM pending_delegates
            WHERE session_id = ${task.sessionId}
              AND status IN ('success', 'error')
              AND summary IS NOT NULL
            ORDER BY completed_at ASC
          `;

          if (completed.length === 0) {
            console.warn(`[delegateResume] no completed delegates for session ${task.sessionId}`);
            break;
          }

          const blocks = completed.map((d, i) => {
            const tag = d.status === "success" ? "✓" : "✗";
            return `### Delegate ${i + 1} ${tag} (${d.duration_seconds}s)\n**Goal:** ${d.goal}\n\n${d.summary}`;
          }).join("\n\n---\n\n");

          const synthetic =
            "[SYSTEM AUTO-RESUME: The async delegated research you launched in your previous turn is now complete. " +
            "Below are the verbatim results from each sub-agent. " +
            "Synthesize them into a single clear final reply for the user — answer their original question directly, " +
            "cite key findings, preserve useful source URLs when present, note contradictions or missing evidence, and do NOT delegate again. " +
            "Reply in the same language the user originally used.]\n\n" +
            blocks;

          const platform = (task.platform as Platform | null) ?? "api";
          const result = await this.runPrompt(
            synthetic,
            platform,
            undefined,
            undefined,
            task.chatId ?? undefined,
          );
          if ("error" in result) {
            console.warn(`[delegateResume] inference failed: ${result.error}`);
            await this.#deliverToOrigin(
              task.platform,
              task.chatId,
              `(Auto-resume failed: ${result.error})`,
            );
            break;
          }
          await this.#deliverToOrigin(task.platform, task.chatId, result.text);
          break;
        }
        default:
          console.warn(`Unknown background task type: ${(task as { type: string }).type}`);
      }
    } catch (err) {
      console.warn(`Background task ${task.type} failed:`, err);
    }
  }

  // ───────────────────────── Private ─────────────────────────

  async #ensureSession(platform: Platform): Promise<void> {
    if (this.#sessionId) return;
    // blockConcurrencyWhile prevents two concurrent requests (TG + cron) from both creating sessions
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.#sessionId) return; // double-check after acquiring lock

      const recent = this.sql<{ id: string; updated_at: string | null; started_at: string; summary: string | null; total_tokens: number }>`
        SELECT id, updated_at, started_at, summary, total_tokens FROM sessions WHERE platform = ${platform}
        ORDER BY started_at DESC LIMIT 1
      `;

      if (recent.length > 0) {
        const lastActivity = recent[0].updated_at ?? recent[0].started_at;
        if (this.#shouldResetSession(lastActivity)) {
          await this.#autoResetSession(recent[0].id, platform);
        } else {
          this.#sessionId = recent[0].id;
          this.setState({
            ...this.state,
            currentSessionId: recent[0].id,
            currentSessionTitle: recent[0].summary,
            tokensThisSession: recent[0].total_tokens,
            platform,
          });
        }
      }

      if (!this.#sessionId) {
        this.#sessionId = crypto.randomUUID();
        this.sql`INSERT OR IGNORE INTO sessions (id, platform, model, updated_at)
          VALUES (${this.#sessionId}, ${platform}, ${this.state.currentModel}, datetime('now'))`;
        logAudit(this.sql.bind(this), "session.start", this.#sessionId);
        // Reset compression state for new session to prevent cross-session summary leaks
        const { resetCompressionState } = await import("./compression.js");
        resetCompressionState();
        this.setState({
          ...this.state,
          currentSessionId: this.#sessionId,
          currentSessionTitle: null,
          tokensThisSession: 0,
          platform,
        });
      }
    });
  }

  /** Check if a session should be auto-reset based on idle timeout or daily boundary. */
  #shouldResetSession(updatedAt: string): boolean {
    const configRows = this.sql<{ key: string; value: string }>`
      SELECT key, value FROM agent_config
      WHERE key IN ('_session_reset_mode', '_session_idle_minutes', '_session_reset_hour')
    `;
    const cfg = new Map(configRows.map(r => [r.key, r.value]));
    const mode = (cfg.get("_session_reset_mode") ?? "both") as import("./config/constants.js").SessionResetMode;
    if (mode === "none") return false;

    const idleMinutes = parseInt(cfg.get("_session_idle_minutes") ?? "120", 10);
    const resetHour = parseInt(cfg.get("_session_reset_hour") ?? "4", 10);
    const now = new Date();
    const lastActive = new Date(updatedAt.endsWith("Z") ? updatedAt : updatedAt + "Z");

    if (mode === "idle" || mode === "both") {
      if (now.getTime() - lastActive.getTime() > idleMinutes * 60_000) return true;
    }
    if (mode === "daily" || mode === "both") {
      const todayReset = new Date(now);
      todayReset.setUTCHours(resetHour, 0, 0, 0);
      if (now >= todayReset && lastActive < todayReset) return true;
    }
    return false;
  }

  /** End old session, flush memory in background, clear SDK messages, create new session. */
  async #autoResetSession(oldSessionId: string, platform: Platform): Promise<void> {
    // 1. End old session
    this.sql`UPDATE sessions SET ended_at = datetime('now') WHERE id = ${oldSessionId}`;

    // 2. Queue memory flush from old session (background, survives hibernation)
    const oldMessages = this.sql<{ role: string; content: string }>`
      SELECT role, content FROM session_messages
      WHERE session_id = ${oldSessionId} ORDER BY id DESC LIMIT 20
    `;
    if (oldMessages.length >= 4) {
      const { buildConversationSummary } = await import("./memory/self-learning.js");
      const summaryInput = oldMessages.reverse().map((m: { role: string; content: string }) => ({
        role: m.role,
        parts: [{ type: "text" as const, text: m.content.slice(0, 500) }],
      }));
      const summary = buildConversationSummary(summaryInput);
      this.queue("executeBackgroundTask" as keyof this, {
        type: "selfLearning",
        summary,
        userId: this.#userId,
        sessionId: oldSessionId,
        options: { reviewMemory: true, reviewSkills: false },
      }).catch((err) => console.warn("Failed to queue pre-reset flush:", err));
    }

    // 3. Clear SDK messages
    this.sql`DELETE FROM cf_ai_chat_agent_messages`;

    // 4. Reset turn counter + prune old audit entries
    this.sql`DELETE FROM agent_config WHERE key = '_turn_count'`;
    this.sql`DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')`;

    // 5. Create new session
    this.#sessionId = crypto.randomUUID();
    this.sql`INSERT OR IGNORE INTO sessions (id, platform, model, updated_at)
      VALUES (${this.#sessionId}, ${platform}, ${this.state.currentModel}, datetime('now'))`;

    // 6. Invalidate cached system prompt + compression state
    this.#cachedSystemPrompt = null;
    const { resetCompressionState } = await import("./compression.js");
    resetCompressionState();

    logAudit(this.sql.bind(this), "session.auto_reset", `old=${oldSessionId} new=${this.#sessionId}`);
  }

  /** Restore MEMORY.md / USER.md from R2 if DO SQLite is empty (e.g. after DO recreation). */
  async #restoreMemoryFromR2(): Promise<void> {
    const memory = getPromptMemory(this.sql.bind(this), "memory");
    const user = getPromptMemory(this.sql.bind(this), "user");
    if (memory || user) return;

    const safeId = this.#userId.replace(/[^a-zA-Z0-9_-]/g, "");
    const [memObj, userObj] = await Promise.all([
      this.env.MEMORIES.get(`${safeId}/MEMORY.md`),
      this.env.MEMORIES.get(`${safeId}/USER.md`),
    ]);

    if (memObj) {
      const text = await memObj.text();
      if (text.trim()) {
        this.sql`UPDATE prompt_memory SET content = ${text}, updated_at = datetime('now') WHERE type = 'memory'`;
      }
    }
    if (userObj) {
      const text = await userObj.text();
      if (text.trim()) {
        this.sql`UPDATE prompt_memory SET content = ${text}, updated_at = datetime('now') WHERE type = 'user'`;
      }
    }

    if (memObj || userObj) {
      console.log(`Restored prompt memory from R2 for ${safeId}`);
    }
  }

  async #syncCronJobs(): Promise<void> {
    const jobs = this.sql<{ id: string; schedule: string }>`
      SELECT id, schedule FROM cron_jobs WHERE enabled = 1
    `;
    for (const job of jobs) {
      try {
        await this.schedule(job.schedule, "executeCronJob" as keyof this, { jobId: job.id }, { idempotent: true });
      } catch (err) {
        console.warn(`Failed to register cron job ${job.id}:`, err);
      }
    }
  }

  #initSchema(): void {
    // Disable FK enforcement — the Agents SDK's message:clear deletes from
    // its own tables without respecting our FK order, causing SQLITE_CONSTRAINT.
    this.sql`PRAGMA foreign_keys = OFF`;

    this.sql`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      platform TEXT DEFAULT 'api',
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      summary TEXT,
      model TEXT,
      total_tokens INTEGER DEFAULT 0
    )`;
    // Migration: add updated_at for existing DOs (one-time, skips if no NULL rows)
    try { this.sql`ALTER TABLE sessions ADD COLUMN updated_at TEXT`; } catch { /* already exists */ }
    const nullCount = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM sessions WHERE updated_at IS NULL`;
    if ((nullCount[0]?.cnt ?? 0) > 0) {
      this.sql`UPDATE sessions SET updated_at = started_at WHERE updated_at IS NULL`;
    }

    this.sql`CREATE TABLE IF NOT EXISTS session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts
      USING fts5(content, content=session_messages, content_rowid=id)`;

    this.sql`CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
      INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
    END`;

    this.sql`CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
    END`;

    this.sql`CREATE TRIGGER IF NOT EXISTS session_messages_au BEFORE UPDATE ON session_messages BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
    END`;

    this.sql`CREATE TABLE IF NOT EXISTS prompt_memory (
      type TEXT PRIMARY KEY CHECK (type IN ('memory','user')),
      content TEXT NOT NULL DEFAULT '',
      char_limit INTEGER NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`INSERT OR IGNORE INTO prompt_memory (type, content, char_limit)
      VALUES ('memory', '', 2200)`;
    this.sql`INSERT OR IGNORE INTO prompt_memory (type, content, char_limit)
      VALUES ('user', '', 1375)`;

    this.sql`CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      category TEXT,
      description TEXT,
      trigger_pattern TEXT,
      platforms TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      schedule TEXT NOT NULL,
      prompt TEXT NOT NULL,
      platform TEXT,
      chat_id TEXT,
      skill TEXT,
      deliver TEXT DEFAULT 'origin',
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS agent_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      encrypted INTEGER DEFAULT 0,
      key_version INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    )`;

    // Media context — fast local lookup instead of R2 metadata re-upload
    this.sql`CREATE TABLE IF NOT EXISTS doc_context (
      r2_key TEXT PRIMARY KEY,
      context TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS hub_installed (
      name TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      identifier TEXT NOT NULL,
      trust_level TEXT NOT NULL DEFAULT 'community',
      content_hash TEXT,
      installed_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      metadata TEXT
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`;
    try { this.sql`ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`; } catch { /* already exists */ }

    this.sql`CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT,
      all_day INTEGER DEFAULT 0,
      location TEXT,
      reminder_minutes INTEGER,
      reminder_delivered INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'chat',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`;

    // Async delegation tracking — rows created by delegate-tool when a workflow starts,
    // updated by onDelegateComplete RPC callback. When the LAST queued/running delegate
    // for a session completes, an auto-resume background task is scheduled so the parent
    // LLM synthesizes the results and pushes a real reply via the originating platform.
    // platform + chat_id are captured at INSERT time so the resume knows where to deliver.
    this.sql`CREATE TABLE IF NOT EXISTS pending_delegates (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      summary TEXT,
      tool_trace TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      platform TEXT,
      chat_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )`;
    // Backfill columns for DOs created before the auto-resume migration
    try { this.sql`ALTER TABLE pending_delegates ADD COLUMN platform TEXT`; } catch { /* exists */ }
    try { this.sql`ALTER TABLE pending_delegates ADD COLUMN chat_id TEXT`; } catch { /* exists */ }
    this.sql`CREATE INDEX IF NOT EXISTS idx_pending_delegates_session ON pending_delegates(session_id, status)`;

    // One-time cleanup: purge stale `_delegate_resumed:*` sentinels left over from
    // the previous auto-resume design. The new design uses `pending_delegates.completed_at`
    // as the dedup marker, so the sentinels are no longer needed and were just polluting
    // agent_config (visible in the dashboard's "Configured keys" list).
    this.sql`DELETE FROM agent_config WHERE key LIKE '_delegate_resumed:%'`;

    // Durable monthly token counter — survives /reset and /wipe (which both blow
    // away `sessions.total_tokens`). Decoupled from the sessions table so the
    // dashboard's "Tokens this month" stays accurate even after a wipe.
    // PRIMARY KEY on month → atomic UPSERT prevents lost increments under concurrency.
    this.sql`CREATE TABLE IF NOT EXISTS monthly_tokens (
      month TEXT PRIMARY KEY,
      total INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`;

    // Platform message ID for ✍️ reaction-to-note lookup (Telegram, WhatsApp, etc.)
    try { this.sql`ALTER TABLE session_messages ADD COLUMN platform_msg_id INTEGER`; } catch { /* already exists */ }
    this.sql`CREATE INDEX IF NOT EXISTS idx_session_messages_platform_msg ON session_messages(platform_msg_id)`;

    // ── Performance indexes ──
    this.sql`CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_sessions_platform ON sessions(platform, started_at DESC)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_at)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_calendar_reminder ON calendar_events(reminder_delivered, start_at) WHERE reminder_minutes IS NOT NULL`;

  }
}

// ── URL enrichment for notes ──

const URL_RE = /^https?:\/\/\S+$/i;
const BLOCKED_HOSTS = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|100\.100\.|fd[0-9a-f]{2}:|fc[0-9a-f]{2}:|::1|metadata\.google)/i;
const MAX_NOTE_LENGTH = 5000;
const VALID_SOURCES = new Set(["manual", "chat", "command"]);

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

async function enrichNoteUrl(content: string): Promise<string> {
  if (!URL_RE.test(content)) return content;
  try {
    const url = new URL(content);
    if (BLOCKED_HOSTS.test(url.hostname) || !["http:", "https:"].includes(url.protocol)) return content;

    const resp = await fetch(content, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Clopinette/1.0; +https://clopinette.app)",
        "Accept": "text/html",
      },
      redirect: "manual", // Don't follow redirects — prevents redirect-to-internal SSRF
      signal: AbortSignal.timeout(5000),
    });
    // If redirect, check destination before following
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("Location");
      if (location) {
        try {
          const redir = new URL(location, content);
          if (BLOCKED_HOSTS.test(redir.hostname) || !["http:", "https:"].includes(redir.protocol)) return content;
        } catch { return content; }
      }
      return content; // Don't follow — return original URL
    }
    if (!resp.ok) return content;

    // Read only first 64KB — OG tags are always in <head>
    const reader = resp.body?.getReader();
    if (!reader) return content;
    let html = "";
    const decoder = new TextDecoder();
    while (html.length < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel();

    const title = stripHtml(
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ??
      html.match(/<title[^>]*>([^<]+)</i)?.[1] ?? ""
    );
    const desc = stripHtml(
      html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ??
      html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1] ?? ""
    );
    if (!title) return content;
    return [title, desc, content].filter(Boolean).join("\n");
  } catch {
    return content;
  }
}

function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "");
}
