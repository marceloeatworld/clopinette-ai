/**
 * WhatsApp Business Cloud API gateway.
 *
 * Secrets:
 *   WHATSAPP_ACCESS_TOKEN     — System user permanent token for Graph API
 *   WHATSAPP_VERIFY_TOKEN     — arbitrary string for webhook URL verification (GET)
 *   WHATSAPP_APP_SECRET       — HMAC-SHA256 verification of incoming webhooks
 *   WHATSAPP_PHONE_NUMBER_ID  — your business phone number ID
 *
 * Setup:
 *   1. Create app at developers.facebook.com
 *   2. Add WhatsApp product
 *   3. Set webhook URL to /webhook/whatsapp, enter your verify token
 *   4. Subscribe to "messages" webhook field
 *   5. Set secrets via wrangler secret put
 *   6. Switch app to Live mode
 *
 * User ID: messages[].from (phone number E.164, no +)
 * DO name: wa_{phone}
 *
 * Notes:
 *   - 24h service window: free-form replies only within 24h of user's last message
 *   - Media URLs expire after 5 minutes
 *   - Must respond 200 quickly (Meta retries on timeout)
 */

import type { SqlFn } from "../config/sql.js";
import type { MediaAsset } from "../config/types.js";
import type { MediaDelivery } from "../pipeline.js";
import { handleCommand } from "../commands.js";

// ───────────────────────── Types ─────────────────────────

/** WhatsApp Cloud API webhook payload */
export interface WhatsAppWebhookPayload {
  object: "whatsapp_business_account";
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: "whatsapp";
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: Array<WhatsAppMessage>;
        statuses?: Array<{ id: string; status: string; timestamp: string }>;
      };
      field: string;
    }>;
  }>;
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: "text" | "image" | "audio" | "video" | "document" | "location" | "contacts" | "interactive" | "reaction";
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  audio?: { id: string; mime_type: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  context?: { message_id: string };
}

export interface WhatsAppContext {
  sql: SqlFn;
  env: Env;
  sessionId: string;
  userId: string;
  accessToken: string;
  phoneNumberId: string;
  runPrompt: (text: string, media?: MediaAsset[], onToolProgress?: (toolName: string, preview: string) => void) => Promise<{ text: string; mediaDelivery?: MediaDelivery[] } | { error: string }>;
  r2Memories: R2Bucket;
  /** Called when a command changes config that affects the system prompt */
  onCacheInvalidate?: () => void;
}

// ───────────────────────── Webhook Handler ─────────────────────────

export async function handleWhatsAppUpdate(
  rawBody: string,
  ctx: WhatsAppContext
): Promise<Response> {
  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Extract first message from webhook (Meta batches, but usually 1)
  const change = payload.entry?.[0]?.changes?.[0]?.value;
  if (!change?.messages?.length) {
    // Status update or other non-message event — acknowledge
    return new Response("ok");
  }

  const msg = change.messages[0];
  const from = msg.from; // phone number (E.164 without +)
  const text = msg.text?.body ?? msg.image?.caption ?? msg.video?.caption ?? msg.document?.caption ?? "";

  // Handle slash commands
  if (text.startsWith("/")) {
    const sharedResult = await handleCommand(text, {
      sql: ctx.sql,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      env: ctx.env,
      r2Memories: ctx.r2Memories,
      r2Skills: ctx.env.SKILLS,
      onCacheInvalidate: ctx.onCacheInvalidate,
    });
    if (sharedResult) {
      await sendWhatsAppMessage(ctx.accessToken, ctx.phoneNumberId, from, sharedResult.text);
      return new Response("ok");
    }
    // WhatsApp-specific commands
    const waReply = await handleWhatsAppOnlyCommand(text, ctx, from);
    if (waReply) {
      await sendWhatsAppMessage(ctx.accessToken, ctx.phoneNumberId, from, waReply);
      return new Response("ok");
    }
  }

  // Download media attachments
  const mediaAssets: MediaAsset[] = [];
  try {
    if (msg.type === "image" && msg.image) {
      const media = await downloadWhatsAppMediaToR2(ctx.accessToken, msg.image.id, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.image.mime_type, type: "image",
      });
      if (media) mediaAssets.push(media);
    }
    if (msg.type === "audio" && msg.audio) {
      const media = await downloadWhatsAppMediaToR2(ctx.accessToken, msg.audio.id, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.audio.mime_type, type: "voice",
      });
      if (media) mediaAssets.push(media);
    }
    if (msg.type === "video" && msg.video) {
      const media = await downloadWhatsAppMediaToR2(ctx.accessToken, msg.video.id, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.video.mime_type, type: "voice",
      });
      if (media) mediaAssets.push(media);
    }
    if (msg.type === "document" && msg.document) {
      const media = await downloadWhatsAppMediaToR2(ctx.accessToken, msg.document.id, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.document.mime_type, type: "document",
        originalName: msg.document.filename,
      });
      if (media) mediaAssets.push(media);
    }
  } catch (err) {
    console.warn("WhatsApp media download failed:", err);
  }

  // Mark message as read
  markAsRead(ctx.accessToken, ctx.phoneNumberId, msg.id);

  // Build prompt
  try {
    let prompt = text;

    // Location messages
    if (msg.type === "location" && msg.location) {
      const loc = msg.location;
      const parts = ["[The user shared a location pin.]"];
      if (loc.name) parts.push(`Place: ${loc.name}`);
      if (loc.address) parts.push(`Address: ${loc.address}`);
      parts.push(`Latitude: ${loc.latitude}, Longitude: ${loc.longitude}`);
      parts.push(`Map: https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`);
      parts.push("The user shared this location. Do NOT assume they are there or traveling there. Simply acknowledge the location and ask what they'd like to do with it (e.g. find nearby places, get directions, save it as a note, etc.).");
      prompt = parts.join("\n");
    }

    // Auto-prompt for media without text
    if (!prompt && mediaAssets.length > 0) {
      const types = mediaAssets.map(a => a.type);
      if (types.includes("image")) prompt = "I sent you an image. Describe what you see.";
      else if (types.includes("voice")) prompt = "Voice message — transcription below. Treat it as my direct message: if it contains a request or action (save, note, reminder, calendar, todo, search…), execute it immediately with the appropriate tool BEFORE responding.";
      else prompt = "I sent you a file. Please analyze it.";
    }

    if (!prompt) return new Response("ok");

    const result = await ctx.runPrompt(prompt, mediaAssets.length > 0 ? mediaAssets : undefined);

    if ("error" in result) {
      await sendWhatsAppMessage(ctx.accessToken, ctx.phoneNumberId, from, `Error: ${result.error}`);
    } else {
      // Send text response
      if (result.text && result.text !== "(no response)") {
        await sendWhatsAppMessage(ctx.accessToken, ctx.phoneNumberId, from, result.text);
      }

      // Deliver generated media (TTS audio, images)
      if (result.mediaDelivery?.length) {
        for (const media of result.mediaDelivery) {
          try {
            const obj = await ctx.r2Memories.get(media.r2Key);
            if (!obj) continue;
            if (media.type === "audio") {
              await sendWhatsAppAudio(ctx.accessToken, ctx.phoneNumberId, from, obj, media.format);
            } else if (media.type === "image") {
              await sendWhatsAppImage(ctx.accessToken, ctx.phoneNumberId, from, obj);
            }
          } catch (err) {
            console.warn(`WhatsApp media delivery failed for ${media.r2Key}:`, err);
          }
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Internal error";
    await sendWhatsAppMessage(ctx.accessToken, ctx.phoneNumberId, from, `Error: ${errMsg}`);
  }

  return new Response("ok");
}

// ───────────────────────── WhatsApp-Only Commands ─────────────────────────

async function handleWhatsAppOnlyCommand(text: string, ctx: WhatsAppContext, from: string): Promise<string | null> {
  const cmd = text.split(" ")[0].toLowerCase();

  switch (cmd) {
    case "/start":
      return [
        "Hi! I'm Clopinette.",
        "",
        "Send me a message, a photo, or a voice note and I'll help you out.",
        "",
        "Already have an account? Use /link to connect your WhatsApp to your web account.",
        "",
        "New here? Sign up at clopinette.app",
      ].join("\n");

    case "/link": {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 36]).join("");
      const payload = JSON.stringify({ platform: "wa", externalId: from });
      await ctx.env.LINKS.put(`link_code:${code}`, payload, { expirationTtl: 300 });
      return `Your link code: ${code}\n\nEnter this code in the web app at clopinette.app to link your WhatsApp. Expires in 5 minutes.`;
    }

    default:
      return null;
  }
}

// ───────────────────────── Webhook Verification (GET) ─────────────────────────

/**
 * Handle the WhatsApp webhook URL verification.
 * Meta sends GET with hub.mode, hub.verify_token, hub.challenge.
 */
export async function handleWhatsAppVerification(
  url: URL,
  verifyToken: string
): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const { timingSafeEqual } = await import("../enterprise/safe-compare.js");
  if (mode === "subscribe" && token && timingSafeEqual(token, verifyToken) && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// ───────────────────────── Signature Verification ─────────────────────────

/**
 * Verify WhatsApp webhook signature (HMAC-SHA256).
 * Header: X-Hub-Signature-256 = sha256={hex_hash}
 */
export async function verifyWhatsAppSignature(
  appSecret: string,
  rawBody: string,
  signature: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const { timingSafeEqual } = await import("../enterprise/safe-compare.js");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = `sha256=${arrayToHex(new Uint8Array(sig))}`;
  return timingSafeEqual(computed, signature);
}

// ───────────────────────── Send Message ─────────────────────────

const WHATSAPP_MAX_LENGTH = 4096;
const GRAPH_API_VERSION = "v22.0";

export async function sendWhatsAppMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string
): Promise<boolean> {
  // WhatsApp has a 4096 char limit per message — split if needed
  const chunks = splitMessage(text, WHATSAPP_MAX_LENGTH);
  let success = true;
  for (const chunk of chunks) {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: chunk },
        }),
      }
    );
    if (!resp.ok) {
      console.warn(`WhatsApp sendMessage failed: ${resp.status} ${await resp.text()}`);
      success = false;
    }
  }
  return success;
}

// ───────────────────────── Media Send ─────────────────────────

async function sendWhatsAppAudio(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  r2Object: R2ObjectBody,
  format: string
): Promise<void> {
  const mediaId = await uploadMedia(accessToken, phoneNumberId, r2Object, format === "ogg" ? "audio/ogg" : "audio/mpeg", `audio.${format}`);
  if (!mediaId) return;
  await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to, type: "audio",
      audio: { id: mediaId },
    }),
  });
}

async function sendWhatsAppImage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  r2Object: R2ObjectBody,
): Promise<void> {
  const contentType = r2Object.httpMetadata?.contentType || "image/jpeg";
  const ext = contentType.includes("png") ? "png" : "jpg";
  const mediaId = await uploadMedia(accessToken, phoneNumberId, r2Object, contentType, `image.${ext}`);
  if (!mediaId) return;
  await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to, type: "image",
      image: { id: mediaId },
    }),
  });
}

/**
 * Upload media to WhatsApp's servers and get a media_id for sending.
 * WhatsApp requires media to be uploaded first (no inline binary in send).
 */
async function uploadMedia(
  accessToken: string,
  phoneNumberId: string,
  r2Object: R2ObjectBody,
  mimeType: string,
  filename: string,
): Promise<string | null> {
  const bytes = await r2Object.arrayBuffer();
  const blob = new Blob([bytes], { type: mimeType });
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", blob, filename);
  form.append("type", mimeType);

  const resp = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form }
  );
  if (!resp.ok) {
    console.warn(`WhatsApp media upload failed: ${resp.status}`);
    return null;
  }
  const data = await resp.json<{ id: string }>();
  return data.id;
}

// ───────────────────────── Download Media ─────────────────────────

/**
 * Download a WhatsApp media file (two-step: get URL, then fetch) and store in R2.
 * Media URLs expire after 5 minutes.
 */
async function downloadWhatsAppMediaToR2(
  accessToken: string,
  mediaId: string,
  r2: R2Bucket,
  userId: string,
  opts: { mimeType: string; type: MediaAsset["type"]; originalName?: string },
): Promise<MediaAsset | null> {
  // Step 1: get the download URL from Graph API
  const metaResp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaResp.ok) return null;
  const metaData = await metaResp.json<{ url: string; mime_type: string }>();

  // Step 2: download the actual file (URL requires auth header)
  const fileResp = await fetch(metaData.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileResp.ok) return null;

  const bytes = await fileResp.arrayBuffer();
  const mimeType = metaData.mime_type || opts.mimeType;
  const ext = extensionFromMime(mimeType);
  const id = crypto.randomUUID().slice(0, 12);
  const filename = opts.originalName || `${opts.type}_${id}.${ext}`;
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const r2Key = `${sanitized}/docs/${filename}`;

  await r2.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: {
      context: `${opts.type} file from WhatsApp: ${filename}`,
      originalName: filename,
      uploadedAt: new Date().toISOString(),
      type: opts.type,
    },
  });

  return {
    type: opts.type,
    r2Key,
    mimeType,
    originalName: opts.originalName,
    sizeBytes: bytes.byteLength,
  };
}

// ───────────────────────── Mark as Read ─────────────────────────

function markAsRead(accessToken: string, phoneNumberId: string, messageId: string): void {
  // Fire-and-forget — shows blue ticks to the user
  fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  }).catch(() => { /* non-fatal */ });
}

// ───────────────────────── Helpers ─────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen / 3) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
    "video/mp4": "mp4", "video/3gpp": "3gp",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/plain": "txt",
  };
  return map[mime] || "bin";
}

function arrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}
