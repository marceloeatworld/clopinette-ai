import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentsMiddleware } from "hono-agents";
import { authMiddleware } from "./enterprise/auth.js";
import { registerTelegramWebhook, deleteTelegramWebhook, sendTelegramMessage } from "./gateway/telegram.js";
import { sendWhatsAppMessage } from "./gateway/whatsapp.js";
import { registerDiscordCommands, sendDiscordMessage } from "./gateway/discord.js";
import { timingSafeEqual } from "./enterprise/safe-compare.js";

// Module-level cache for bot secret (never changes during deployment)
let cachedBotSecret: string | null = null;

// Re-export DO and Workflow classes for wrangler discovery
export { ClopinetteAgent } from "./agent.js";
export { PlaywrightMCP } from "./playwright-mcp.js";
export { DelegateWorkflow } from "./delegate-workflow.js";
export { BackfillVectorsWorkflow } from "./backfill-workflow.js";

type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

// ───────────────────────── Middleware ─────────────────────────

app.use("*", cors({
  origin: (origin, c) => {
    const allowed = c.env.CORS_ORIGINS?.split(",") ?? [];
    // No localhost bypass in production — add http://localhost:5173 to CORS_ORIGINS for dev
    return allowed.includes(origin) ? origin : null;
  },
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
}));

app.use("*", agentsMiddleware());
app.use("/api/*", authMiddleware());

// ───────────────────────── Helpers ─────────────────────────

/** KV keys (platform-agnostic) */
const kv = {
  botSecret: (platform: string) => `bot:${platform}:secret`,
  link:      (platform: string, externalId: string) => `link:${platform}:${externalId}`,
  linkCode:  (code: string) => `link_code:${code}`,
};

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ───────────────────────── Quota Enforcement (KV cache) ─────────────────────────

interface QuotaCache {
  allowed: boolean;
  plan: string;
  usage: number;
  limit: number;
  reason?: string;
  updatedAt: number;
}

/**
 * Aligned with the gateway's KV TTL (10 min) — the gateway cron also refreshes
 * every 5 min for active users, so a "fresh" window of 10 min is always covered.
 */
const QUOTA_STALENESS_MS = 10 * 60_000;

/**
 * Check quota from KV cache (pushed by gateway + periodic cron sync).
 * Falls back to gateway HTTP if cache is stale/missing.
 * Fail-open if both KV and gateway are unavailable — we never block traffic
 * on infrastructure hiccups.
 */
async function checkQuotaFromKV(
  links: KVNamespace,
  userId: string,
  gatewayUrl?: string,
  internalKey?: string
): Promise<{ allowed: boolean; reason?: string }> {
  const raw = await links.get(`quota:${userId}`);

  if (raw) {
    try {
      const cache: QuotaCache = JSON.parse(raw);
      if (Date.now() - cache.updatedAt < QUOTA_STALENESS_MS) {
        return cache;
      }
    } catch { /* malformed cache — fall through to refresh */ }
  }

  // Absent or stale — try gateway refresh
  if (gatewayUrl && internalKey) {
    try {
      const resp = await fetch(`${gatewayUrl}/internal/quota/${userId}`, {
        headers: { "x-internal-key": internalKey },
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) return await resp.json() as QuotaCache;
    } catch { /* gateway unreachable */ }
  }

  // No fresh cache and no gateway — fail-open.
  return { allowed: true };
}

/**
 * Resolve DO name from platform + external ID. Checks KV for identity link.
 * Shared mode: KV value starts with "shared:" — standalone DO, quota on userId.
 * Trusted mode: KV value is userId — route to user's DO directly.
 */
async function resolveDoName(
  links: KVNamespace,
  platform: string,
  externalId: string
): Promise<{ doName: string; linkedUserId: string | null; shared: boolean }> {
  const raw = await links.get(kv.link(platform, externalId));
  if (!raw) return { doName: `${platform}_${externalId}`, linkedUserId: null, shared: false };

  if (raw.startsWith("shared:")) {
    const userId = raw.slice(7);
    return { doName: `${platform}_${externalId}`, linkedUserId: userId, shared: true };
  }

  return { doName: raw, linkedUserId: raw, shared: false };
}

// ───────────────────────── API: Telegram setup (admin) ─────────────────────────

/**
 * Register the official Telegram bot webhook.
 * Uses TELEGRAM_BOT_TOKEN from env secrets. Generates a webhook secret stored in KV.
 */
app.post("/api/admin/setup-telegram", async (c) => {
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return c.json({ error: "TELEGRAM_BOT_TOKEN secret not set" }, 500);

  const secretToken = crypto.randomUUID();
  await c.env.LINKS.put(kv.botSecret("telegram"), secretToken);

  const workerUrl = new URL(c.req.url).origin;
  const result = await registerTelegramWebhook(botToken, workerUrl, secretToken);
  if (!result.ok) {
    return c.json({ error: "Failed to register Telegram webhook", details: result.description }, 502);
  }

  return c.json({ ok: true, webhookUrl: `${workerUrl}/webhook/telegram` });
});

app.get("/api/admin/setup-telegram", async (c) => {
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not set" }, 500);
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  return c.json(await resp.json());
});

app.delete("/api/admin/setup-telegram", async (c) => {
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (botToken) await deleteTelegramWebhook(botToken);
  await c.env.LINKS.delete(kv.botSecret("telegram"));
  return c.json({ ok: true });
});

// ───────────────────────── API: Discord setup (admin) ─────────────────────────

/**
 * Register Discord slash commands and generate bridge secret.
 */
app.post("/api/admin/setup-discord", async (c) => {
  const botToken = c.env.DISCORD_TOKEN;
  const applicationId = c.env.DISCORD_APPLICATION_ID;
  if (!botToken || !applicationId) return c.json({ error: "DISCORD_TOKEN and DISCORD_APPLICATION_ID secrets not set" }, 500);

  // Register global slash commands
  const result = await registerDiscordCommands(applicationId, botToken);
  if (!result.ok) return c.json({ error: "Failed to register Discord commands" }, 502);

  // Generate bridge secret (for the external Gateway bridge)
  const bridgeSecret = crypto.randomUUID();
  await c.env.LINKS.put(kv.botSecret("discord"), bridgeSecret);

  const workerUrl = new URL(c.req.url).origin;
  return c.json({
    ok: true,
    commands: result.count,
    interactionsUrl: `${workerUrl}/webhook/discord`,
    bridgeUrl: `${workerUrl}/webhook/discord-bridge`,
    bridgeSecret,
  });
});

app.delete("/api/admin/setup-discord", async (c) => {
  await c.env.LINKS.delete(kv.botSecret("discord"));
  return c.json({ ok: true });
});

// ───────────────────────── Webhooks ─────────────────────────

/**
 * Telegram webhook. Per-chat DO isolation.
 * Bot token from env secret. Webhook secret from KV.
 */
app.post("/webhook/telegram", async (c) => {
  // Parse body + validate secret in parallel with KV read
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not set" }, 500);

  const secretToken = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";

  // Use cached bot secret (never changes during deployment) or fetch once
  if (!cachedBotSecret) {
    cachedBotSecret = await c.env.LINKS.get(kv.botSecret("telegram"));
  }
  if (!cachedBotSecret || !timingSafeEqual(secretToken, cachedBotSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse update body (only once — DO receives it via headers/body forward)
  const update = await c.req.json<{
    message?: { chat: { id: number }; text?: string };
    callback_query?: { message?: { chat: { id: number } } };
    message_reaction?: { chat: { id: number }; message_id: number };
  }>();
  const chatId = String(
    update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? update.message_reaction?.chat?.id ?? ""
  );
  if (!chatId) return c.json({ ok: true });

  // Identity link check
  const text = update.message?.text ?? "";
  const isReaction = !!update.message_reaction;
  const isAllowedCommand = /^\/(start|link|help)\b/.test(text) || isReaction;

  const { doName, linkedUserId, shared } = await resolveDoName(c.env.LINKS, "tg", chatId);

  // Users must link their Telegram to a web account to use the bot
  if (!linkedUserId && !isAllowedCommand) {
    await sendTelegramMessage(botToken, Number(chatId),
      "Link your Telegram to your clopinette\\.app account first\\.\nUse /link to get started\\.");
    return new Response("ok");
  }

  // Quota gate: check plan + token usage from KV cache (pushed by gateway)
  if (linkedUserId && !isAllowedCommand) {
    const quota = await checkQuotaFromKV(
      c.env.LINKS, linkedUserId, c.env.GATEWAY_URL,
      c.env.GATEWAY_INTERNAL_KEY ?? c.env.WS_SIGNING_SECRET
    );
    if (!quota.allowed) {
      const msg = quota.reason === "payment_failed"
        ? "Your payment failed\\. Please update your billing at clopinette\\.app/billing"
        : quota.reason === "monthly_limit" || quota.reason === "daily_limit"
          ? "Monthly usage limit reached\\. Check usage at clopinette\\.app/dashboard"
          : "Telegram is available on Pro and BYOK plans\\. Upgrade at clopinette\\.app/pricing";
      await sendTelegramMessage(botToken, Number(chatId), msg);
      return new Response("ok");
    }
  }

  // Route to the per-user DO. AIChatAgent requires Agents-* headers to accept fetch.
  const id = c.env.CLOPINETTE_AGENT.idFromName(doName);
  const stub = c.env.CLOPINETTE_AGENT.get(id);

  // Forward to DO — the DO returns 200 immediately and processes in background
  // via this.ctx.waitUntil() (no time limit on DO, unlike Worker waitUntil).
  return stub.fetch(new Request(c.req.raw.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bot-Token": botToken,
      "X-Chat-Id": chatId,
      "X-Platform": "telegram",
      ...(shared && { "X-Shared-Mode": "true" }),
      "x-partykit-room": doName,
    },
    body: JSON.stringify(update),
  }));
});

// Discord Interactions (slash commands) — verified via Ed25519
app.post("/webhook/discord", async (c) => {
  const publicKey = c.env.DISCORD_PUBLIC_KEY;
  const botToken = c.env.DISCORD_TOKEN;
  const applicationId = c.env.DISCORD_APPLICATION_ID;
  if (!publicKey || !botToken || !applicationId) return c.json({ error: "Not configured" }, 501);

  // Verify Ed25519 signature before processing
  const signature = c.req.header("X-Signature-Ed25519") ?? "";
  const timestamp = c.req.header("X-Signature-Timestamp") ?? "";
  if (!signature || !timestamp) return new Response("Missing signature", { status: 401 });

  const rawBody = await c.req.text();
  const key = await crypto.subtle.importKey(
    "raw", hexToUint8Array(publicKey), { name: "Ed25519" }, false, ["verify"]
  );
  const isValid = await crypto.subtle.verify(
    "Ed25519", key,
    hexToUint8Array(signature),
    new TextEncoder().encode(timestamp + rawBody)
  );
  if (!isValid) return new Response("Invalid signature", { status: 401 });

  const body = JSON.parse(rawBody);

  // PING — required for Discord endpoint verification
  if (body.type === 1) return c.json({ type: 1 });

  // APPLICATION_COMMAND (type 2) — slash commands
  if (body.type === 2 && body.data) {
    const dcUserId = body.member?.user?.id ?? body.user?.id ?? "";
    if (!dcUserId) return c.json({ type: 4, data: { content: "Could not identify user.", flags: 64 } });

    // Guild → shared DO (like Telegram groups), DM → personal DO
    const guildId = body.guild_id;
    const isGuild = !!guildId;
    const linkPlatform = isGuild ? "dcg" : "dc";
    const linkId = isGuild ? guildId : dcUserId;

    // Identity link check — /link and /help don't require linking
    const isAllowedCommand = ["link", "help"].includes(body.data.name);
    const { doName, linkedUserId, shared } = await resolveDoName(c.env.LINKS, linkPlatform, linkId);

    if (!linkedUserId && !isAllowedCommand) {
      return Response.json({
        type: 4,
        data: {
          content: isGuild
            ? "This server isn't linked to a **clopinette.app** account yet.\nUse `/link trusted` or `/link shared` to connect it."
            : "Link your Discord to your **clopinette.app** account first.\nUse `/link` to get started.",
          flags: 64,
        },
      });
    }

    // Quota check
    if (linkedUserId && !isAllowedCommand) {
      const quota = await checkQuotaFromKV(
        c.env.LINKS, linkedUserId, c.env.GATEWAY_URL,
        c.env.GATEWAY_INTERNAL_KEY ?? c.env.WS_SIGNING_SECRET
      );
      if (!quota.allowed) {
        const msg = quota.reason === "payment_failed"
          ? "Your payment failed. Update billing at clopinette.app/billing"
          : quota.reason === "monthly_limit" || quota.reason === "daily_limit"
            ? "Usage limit reached. Check clopinette.app/dashboard"
            : "Discord bot is available on Pro and BYOK plans. Upgrade at clopinette.app/pricing";
        return Response.json({ type: 4, data: { content: msg, flags: 64 } });
      }
    }

    // Route to DO — the DO handles the interaction (deferred response + async processing)
    const id = c.env.CLOPINETTE_AGENT.idFromName(doName);
    const stub = c.env.CLOPINETTE_AGENT.get(id);

    return stub.fetch(new Request(c.req.raw.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Discord-Token": botToken,
        "X-Discord-Application-Id": applicationId,
        "X-Discord-User-Id": dcUserId,
        "X-Platform": "discord",
        "X-Discord-Source": "interaction",
        ...(shared && { "X-Shared-Mode": "true" }),
        "x-partykit-room": doName,
      },
      body: rawBody,
    }));
  }

  return c.json({ type: 1 });
});

// Discord bridge messages (Gateway WebSocket → HTTP forward)
app.post("/webhook/discord-bridge", async (c) => {
  const botToken = c.env.DISCORD_TOKEN;
  const applicationId = c.env.DISCORD_APPLICATION_ID;
  if (!botToken || !applicationId) return c.json({ error: "Not configured" }, 501);

  // Verify HMAC-SHA256 signature (bridge signs timestamp+body with shared secret)
  const storedSecret = await c.env.LINKS.get(kv.botSecret("discord"));
  if (!storedSecret) return new Response("Unauthorized", { status: 401 });

  const timestamp = c.req.header("X-Bridge-Timestamp") ?? "";
  const signature = c.req.header("X-Bridge-Signature") ?? "";
  const rawBody = await c.req.text();

  // Reject stale requests (>5 min) to prevent replay attacks
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!timestamp || !signature || age > 300) {
    return new Response("Unauthorized", { status: 401 });
  }

  const hmacKey = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(storedSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const computed = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(timestamp + rawBody));
  const expected = `sha256=${Array.from(new Uint8Array(computed)).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  if (!timingSafeEqual(expected, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }
  let payload: { type: string; message?: { author?: { id?: string; bot?: boolean }; content?: string; channel_id?: string; guild_id?: string } };
  try { payload = JSON.parse(rawBody); } catch { return new Response("ok"); }

  if (payload.type !== "MESSAGE_CREATE" || !payload.message) return new Response("ok");
  if (payload.message.author?.bot) return new Response("ok"); // Ignore bot messages

  const dcUserId = payload.message.author?.id ?? "";
  const text = payload.message.content ?? "";
  if (!dcUserId) return new Response("ok");

  // Guild → shared DO (like Telegram groups), DM → personal DO
  const guildId = payload.message.guild_id;
  const isGuild = !!guildId;
  const linkPlatform = isGuild ? "dcg" : "dc";
  const linkId = isGuild ? guildId! : dcUserId;

  // Identity link + quota (same pattern as Telegram)
  const isAllowedCommand = /^\/(start|link|help)\b/.test(text);
  const { doName, linkedUserId, shared } = await resolveDoName(c.env.LINKS, linkPlatform, linkId);

  if (!linkedUserId && !isAllowedCommand) {
    const channelId = payload.message.channel_id;
    if (channelId) {
      await sendDiscordMessage(botToken, channelId,
        isGuild
          ? "This server isn't linked to a **clopinette.app** account yet.\nType `/link trusted` or `/link shared` to connect it."
          : "Link your Discord to your **clopinette.app** account first.\nUse `/link` to get started.");
    }
    return new Response("ok");
  }

  if (linkedUserId && !isAllowedCommand) {
    const quota = await checkQuotaFromKV(
      c.env.LINKS, linkedUserId, c.env.GATEWAY_URL,
      c.env.GATEWAY_INTERNAL_KEY ?? c.env.WS_SIGNING_SECRET
    );
    if (!quota.allowed) {
      const channelId = payload.message.channel_id;
      if (channelId) {
        const msg = quota.reason === "payment_failed"
          ? "Your payment failed. Update billing at clopinette.app/billing"
          : quota.reason === "monthly_limit" || quota.reason === "daily_limit"
            ? "Usage limit reached. Check clopinette.app/dashboard"
            : "Discord bot is available on Pro and BYOK plans. Upgrade at clopinette.app/pricing";
        await sendDiscordMessage(botToken, channelId, msg);
      }
      return new Response("ok");
    }
  }

  // Route to DO
  const id = c.env.CLOPINETTE_AGENT.idFromName(doName);
  const stub = c.env.CLOPINETTE_AGENT.get(id);

  return stub.fetch(new Request(c.req.raw.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Discord-Token": botToken,
      "X-Discord-Application-Id": applicationId,
      "X-Discord-User-Id": dcUserId,
      "X-Platform": "discord",
      "X-Discord-Source": "bridge",
      ...(shared && { "X-Shared-Mode": "true" }),
      "x-partykit-room": doName,
    },
    body: rawBody,
  }));
});

app.post("/webhook/slack", async (c) => {
  const signingSecret = c.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return c.json({ error: "Not configured" }, 501);

  // Verify Slack HMAC signature before processing
  const { verifySlackSignature } = await import("./gateway/slack.js");
  const rawBody = await c.req.text();
  const timestamp = c.req.header("X-Slack-Request-Timestamp") ?? "";
  const signature = c.req.header("X-Slack-Signature") ?? "";
  if (!timestamp || !signature || !(await verifySlackSignature(signingSecret, timestamp, rawBody, signature))) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Handle Slack url_verification challenge
  const body = JSON.parse(rawBody);
  if (body.type === "url_verification") return c.json({ challenge: body.challenge });

  return c.json({ error: "Slack not implemented" }, 501);
});

// WhatsApp: GET for webhook verification, POST for incoming messages
app.get("/webhook/whatsapp", async (c) => {
  const verifyToken = c.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) return c.json({ error: "WHATSAPP_VERIFY_TOKEN not set" }, 500);

  const { handleWhatsAppVerification } = await import("./gateway/whatsapp.js");
  return handleWhatsAppVerification(new URL(c.req.url), verifyToken);
});

app.post("/webhook/whatsapp", async (c) => {
  const appSecret = c.env.WHATSAPP_APP_SECRET;
  const accessToken = c.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = c.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!appSecret || !accessToken || !phoneNumberId) return c.json({ error: "Not configured" }, 501);

  // Verify WhatsApp HMAC signature before processing
  const { verifyWhatsAppSignature } = await import("./gateway/whatsapp.js");
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Hub-Signature-256") ?? "";
  if (!signature || !(await verifyWhatsAppSignature(appSecret, rawBody, signature))) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Extract sender phone from payload
  let payload: { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ from: string; text?: { body: string } }> } }> }> };
  try { payload = JSON.parse(rawBody); } catch { return new Response("ok"); }
  const from = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
  if (!from) return new Response("ok"); // status update, not a message

  // Identity link + plan check (same pattern as Telegram)
  const text = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body ?? "";
  const isAllowedCommand = /^\/(start|link|help)\b/.test(text);

  const { doName, linkedUserId, shared } = await resolveDoName(c.env.LINKS, "wa", from);

  if (!linkedUserId && !isAllowedCommand) {
    await sendWhatsAppMessage(accessToken, phoneNumberId, from,
      "Link your WhatsApp to your clopinette.app account first.\nSend /link to get started.");
    return new Response("ok");
  }

  if (linkedUserId && !isAllowedCommand) {
    const quota = await checkQuotaFromKV(
      c.env.LINKS, linkedUserId, c.env.GATEWAY_URL,
      c.env.GATEWAY_INTERNAL_KEY ?? c.env.WS_SIGNING_SECRET
    );
    if (!quota.allowed) {
      const msg = quota.reason === "payment_failed"
        ? "Your payment failed. Please update your billing at clopinette.app/billing"
        : quota.reason === "monthly_limit" || quota.reason === "daily_limit"
          ? "Monthly usage limit reached. Check usage at clopinette.app/dashboard"
          : "WhatsApp bot is available on Pro and BYOK plans. Upgrade at clopinette.app/pricing";
      await sendWhatsAppMessage(accessToken, phoneNumberId, from, msg);
      return new Response("ok");
    }
  }

  // Route to the per-user DO
  const id = c.env.CLOPINETTE_AGENT.idFromName(doName);
  const stub = c.env.CLOPINETTE_AGENT.get(id);

  return stub.fetch(new Request(c.req.raw.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WA-Access-Token": accessToken,
      "X-WA-Phone-Number-Id": phoneNumberId,
      "X-WA-From": from,
      "X-Platform": "whatsapp",
      ...(shared && { "X-Shared-Mode": "true" }),
      "x-partykit-room": doName,
    },
    body: rawBody,
  }));
});

// Evolution API (self-hosted WhatsApp via Baileys on Coolify)
app.post("/webhook/evolution", async (c) => {
  const apiUrl = c.env.EVOLUTION_API_URL;
  const apiKey = c.env.EVOLUTION_API_KEY;
  if (!apiUrl || !apiKey) return c.json({ error: "Not configured" }, 501);

  // Verify the webhook comes from our Evolution instance (apikey in payload)
  const rawBody = await c.req.text();
  let payload: { event?: string; instance?: string; apikey?: string; data?: { key?: { fromMe?: boolean; remoteJid?: string } } };
  try { payload = JSON.parse(rawBody); } catch { return new Response("ok"); }

  if (payload.apikey && !timingSafeEqual(payload.apikey, apiKey)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Only process incoming messages (not our own, not status updates)
  if (payload.event !== "messages.upsert") return new Response("ok");
  if (payload.data?.key?.fromMe) return new Response("ok");

  // Extract userId from instance name: "clop-{userId}" → userId
  const instanceName = payload.instance ?? "";
  const userId = instanceName.startsWith("clop-") ? instanceName.slice(5) : null;
  if (!userId) return new Response("ok");

  // Quota check (same as Telegram/WhatsApp)
  const quota = await checkQuotaFromKV(
    c.env.LINKS, userId, c.env.GATEWAY_URL,
    c.env.GATEWAY_INTERNAL_KEY ?? c.env.WS_SIGNING_SECRET
  );
  if (!quota.allowed) {
    const { sendEvolutionMessage } = await import("./gateway/evolution.js");
    const to = payload.data?.key?.remoteJid ?? "";
    const msg = quota.reason === "payment_failed"
      ? "Your payment failed. Please update your billing at clopinette.app/billing"
      : quota.reason === "monthly_limit" || quota.reason === "daily_limit"
        ? "Monthly usage limit reached. Check usage at clopinette.app/dashboard"
        : "WhatsApp bot is available on Pro and BYOK plans. Upgrade at clopinette.app/pricing";
    if (to) await sendEvolutionMessage(apiUrl, apiKey, instanceName, to, msg);
    return new Response("ok");
  }

  // Route to the per-user DO
  const id = c.env.CLOPINETTE_AGENT.idFromName(userId);
  const stub = c.env.CLOPINETTE_AGENT.get(id);

  return stub.fetch(new Request(c.req.raw.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Evolution-Instance": instanceName,
      "X-WA-From": payload.data?.key?.remoteJid ?? "",
      "X-Platform": "whatsapp",
      "x-partykit-room": userId,
    },
    body: rawBody,
  }));
});

// ───────────────────────── Playwright MCP ─────────────────────────

app.get("/mcp", async (c) => {
  const authKey = c.env.API_AUTH_KEY;
  if (!authKey) return c.json({ error: "Service not available" }, 503);
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || !timingSafeEqual(token, authKey)) return c.json({ error: "Unauthorized" }, 401);

  const id = c.env.PlaywrightMCP.idFromName("default");
  const stub = c.env.PlaywrightMCP.get(id);
  return stub.fetch(c.req.raw);
});

// ───────────────────────── 404 ─────────────────────────

app.all("*", (c) => c.json({ error: "Not found" }, 404));

export default app;
