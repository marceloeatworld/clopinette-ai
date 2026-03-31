import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentsMiddleware } from "hono-agents";
import { getAgentByName } from "agents";
import type { ConfigRequest, SetupRequest } from "./config/types.js";
import { authMiddleware } from "./enterprise/auth.js";
import { registerTelegramWebhook, deleteTelegramWebhook, sendTelegramMessage } from "./gateway/telegram.js";
import { sendWhatsAppMessage } from "./gateway/whatsapp.js";
import { timingSafeEqual } from "./enterprise/safe-compare.js";
import type { ClopinetteAgent } from "./agent.js";

// Module-level cache for bot secret (never changes during deployment)
let cachedBotSecret: string | null = null;

// Re-export DO classes for wrangler discovery
export { ClopinetteAgent } from "./agent.js";
export { PlaywrightMCP } from "./playwright-mcp.js";
export { DelegateWorker } from "./delegate-worker.js";

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

async function getAgent(env: Env, userId: string) {
  return getAgentByName<Env, ClopinetteAgent>(env.CLOPINETTE_AGENT, userId);
}

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

const QUOTA_STALENESS_MS = 5 * 60_000; // 5 minutes

/**
 * Check quota from KV cache (pushed by gateway).
 * Falls back to gateway HTTP if cache is stale/missing.
 * Fail-open if both KV and gateway are unavailable.
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
        return cache; // Fresh cache — use directly
      }
    } catch { /* malformed cache — fall through to refresh */ }
  }

  // Stale or missing — try gateway refresh
  if (gatewayUrl && internalKey) {
    try {
      const resp = await fetch(`${gatewayUrl}/internal/quota/${userId}`, {
        headers: { "x-internal-key": internalKey },
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) return await resp.json() as QuotaCache;
    } catch { /* gateway unreachable */ }
  }

  // Fallback: use stale cache if available
  if (raw) {
    try { return JSON.parse(raw) as QuotaCache; } catch { /* ignore */ }
  }

  // No cache, no gateway — fail-open
  return { allowed: true };
}

/** Resolve DO name from platform + external ID. Checks KV for identity link. */
async function resolveDoName(
  links: KVNamespace,
  platform: string,
  externalId: string
): Promise<{ doName: string; linkedUserId: string | null }> {
  const linkedUserId = await links.get(kv.link(platform, externalId));
  return {
    doName: linkedUserId ?? `${platform}_${externalId}`,
    linkedUserId,
  };
}

// ───────────────────────── API: agent management ─────────────────────────

app.post("/api/setup", async (c) => {
  const body = await c.req.json<SetupRequest>();
  if (!body.userId) return c.json({ error: "userId required" }, 400);
  const agent = await getAgent(c.env, body.userId);
  const result = await agent.setup(body.displayName);
  return c.json(result);
});

app.post("/api/config", async (c) => {
  const body = await c.req.json<ConfigRequest>();
  if (!body.userId) return c.json({ error: "userId required" }, 400);
  const agent = await getAgent(c.env, body.userId);
  if (body.provider) await agent.updateConfig("provider", body.provider, false);
  if (body.model) await agent.updateConfig("model", body.model, false);
  if (body.apiKey) await agent.updateConfig("api_key", body.apiKey, true);
  if (body.soulMd) {
    if (body.soulMd.length > 10000) return c.json({ error: "soul_md max 10000 chars" }, 400);
    await agent.updateConfig("soul_md", body.soulMd, false);
  }
  if (body.autoragName) await agent.updateConfig("autorag_name", body.autoragName, false);
  return c.json({ ok: true });
});

app.get("/api/status", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId query param required" }, 400);
  const agent = await getAgent(c.env, userId);
  const status = await agent.getStatus();
  return c.json(status);
});

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

// ───────────────────────── API: admin (memory, skills, config, audit) ─────────────────────────

/** Helper: get userId from query param, return agent */
async function getAdminAgent(c: { req: { query: (k: string) => string | undefined }; env: Env; json: (d: unknown, s?: number) => Response }) {
  const userId = c.req.query("userId");
  if (!userId) return null;
  return getAgent(c.env, userId);
}

// Memory
app.get("/api/admin/memory/:type", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const type = c.req.param("type");
  if (type !== "memory" && type !== "user") return c.json({ error: "type must be 'memory' or 'user'" }, 400);
  return c.json(await agent.getMemory(type));
});

app.put("/api/admin/memory/:type", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const type = c.req.param("type");
  if (type !== "memory" && type !== "user") return c.json({ error: "type must be 'memory' or 'user'" }, 400);
  const { content } = await c.req.json<{ content: string }>();
  return c.json(await agent.setMemory(type, content));
});

// Soul
app.get("/api/admin/soul", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  return c.json(await agent.getSoulMd());
});

app.put("/api/admin/soul", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const { content } = await c.req.json<{ content: string }>();
  return c.json(await agent.setSoulMd(content));
});

// Skills
app.get("/api/admin/skills", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  return c.json(await agent.listSkillsAdmin());
});

app.get("/api/admin/skills/:name", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const skill = await agent.getSkillAdmin(c.req.param("name"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);
  return c.json(skill);
});

app.put("/api/admin/skills/:name", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const body = await c.req.json<{ content: string; category?: string; description?: string; triggerPattern?: string }>();
  return c.json(await agent.setSkillAdmin(c.req.param("name"), body.content, body));
});

app.delete("/api/admin/skills/:name", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  return c.json(await agent.deleteSkillAdmin(c.req.param("name")));
});

// Audit
app.get("/api/admin/audit", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 100);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  return c.json(await agent.getAuditLog(limit, offset));
});

// Sessions
app.get("/api/admin/sessions", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "20", 10) || 20, 1), 100);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  return c.json(await agent.listSessions(limit, offset));
});

app.get("/api/admin/sessions/:id/messages", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 100);
  return c.json(await agent.getSessionMessagesAdmin(c.req.param("id"), limit));
});

app.delete("/api/admin/sessions/:id", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  return c.json(await agent.deleteSession(c.req.param("id")));
});

app.delete("/api/admin/sessions", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  return c.json(await agent.deleteAllSessions());
});

// Config
app.get("/api/admin/config", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  return c.json(await agent.getFullConfig());
});

app.delete("/api/admin/config/:key", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  return c.json(await agent.deleteConfig(c.req.param("key")));
});

// ───────────────────────── API: skills hub ─────────────────────────

app.get("/api/admin/hub/search", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const query = c.req.query("q") ?? "";
  const source = c.req.query("source");
  const limit = parseInt(c.req.query("limit") ?? "10", 10);
  return c.json(await agent.hubSearch(query, source, limit));
});

app.post("/api/admin/hub/install", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const { source, identifier } = await c.req.json<{ source: string; identifier: string }>();
  return c.json(await agent.hubInstall(source, identifier));
});

app.post("/api/admin/hub/install-url", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  const { url, name } = await c.req.json<{ url: string; name?: string }>();
  return c.json(await agent.hubInstallFromUrl(url, name));
});

app.get("/api/admin/hub/installed", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  return c.json(await agent.hubListInstalled());
});

app.delete("/api/admin/hub/installed/:name", async (c) => {
  const agent = await getAdminAgent(c);
  if (!agent) return c.json({ error: "userId required" }, 400);
  return c.json(await agent.hubUninstall(c.req.param("name")));
});

// ───────────────────────── API: identity linking ─────────────────────────

/**
 * Link a platform identity to a userId.
 * POST /api/link { userId, code }
 */
app.post("/api/link", async (c) => {
  const { userId, code } = await c.req.json<{ userId: string; code: string }>();
  if (!userId || !code) return c.json({ error: "userId and code required" }, 400);

  const raw = await c.env.LINKS.get(kv.linkCode(code.toUpperCase()));
  if (!raw) return c.json({ error: "Invalid or expired link code" }, 400);

  const { platform, externalId } = JSON.parse(raw) as { platform: string; externalId: string };
  await c.env.LINKS.put(kv.link(platform, externalId), userId);
  await c.env.LINKS.delete(kv.linkCode(code.toUpperCase()));

  // Ensure plan key exists in KV (gateway may have already written it, but be defensive)
  const existingPlan = await c.env.LINKS.get(`plan:${userId}`);
  if (!existingPlan) {
    // No plan in KV — this was the bug. Can't read D1 from core worker, but
    // the gateway's /api/link handler writes it. Log for visibility.
    console.warn(`Link completed but no plan:${userId} in KV — gateway should sync this`);
  }

  return c.json({ ok: true, platform, externalId, userId });
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

  const { doName, linkedUserId } = await resolveDoName(c.env.LINKS, "tg", chatId);

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
      "x-partykit-room": doName,
    },
    body: JSON.stringify(update),
  }));
});

app.post("/webhook/discord", async (c) => {
  const publicKey = c.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) return c.json({ error: "Not configured" }, 501);

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

  // Handle Discord PING (required for endpoint verification)
  const body = JSON.parse(rawBody);
  if (body.type === 1) return c.json({ type: 1 });

  return c.json({ error: "Discord not implemented" }, 501);
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

  const { doName, linkedUserId } = await resolveDoName(c.env.LINKS, "wa", from);

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
