/**
 * Evolution API gateway (self-hosted WhatsApp via Baileys).
 *
 * Each user gets their own instance: "clop-{userId}"
 * Evolution API runs on Coolify (Docker) and sends webhooks to this worker.
 *
 * Env secrets:
 *   EVOLUTION_API_URL  — Base URL of Evolution API server
 *   EVOLUTION_API_KEY  — Global admin API key
 */

import type { SqlFn } from "../config/sql.js";
import type { MediaAsset } from "../config/types.js";
import type { MediaDelivery } from "../pipeline.js";
import { handleCommand } from "../commands.js";

// ───────────────────────── Types ─────────────────────────

export interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  data: {
    key: {
      id: string;
      fromMe: boolean;
      remoteJid: string;
      participant?: string;
    };
    pushName?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text: string };
      imageMessage?: { base64?: string; mimetype?: string; caption?: string };
      audioMessage?: { base64?: string; mimetype?: string; seconds?: number; ptt?: boolean };
      documentMessage?: { base64?: string; mimetype?: string; fileName?: string; caption?: string };
      locationMessage?: { degreesLatitude: number; degreesLongitude: number; name?: string; address?: string };
    };
    messageType?: string;
    messageTimestamp?: number;
  };
  sender: string;
  server_url: string;
  apikey: string;
}

export interface EvolutionContext {
  sql: SqlFn;
  env: Env;
  sessionId: string;
  userId: string;
  apiUrl: string;
  apiKey: string;
  instanceName: string;
  runPrompt: (text: string, media?: MediaAsset[], onToolProgress?: (toolName: string, preview: string) => void) => Promise<{ text: string; mediaDelivery?: MediaDelivery[] } | { error: string }>;
  r2Memories: R2Bucket;
  onCacheInvalidate?: () => void;
}

// ───────────────────────── Webhook Handler ─────────────────────────

export async function handleEvolutionUpdate(
  rawBody: string,
  ctx: EvolutionContext,
): Promise<Response> {
  let payload: EvolutionWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Only process incoming messages
  if (payload.event !== "messages.upsert") return new Response("ok");
  if (payload.data.key.fromMe) return new Response("ok");

  const remoteJid = payload.data.key.remoteJid;
  const msg = payload.data.message;
  if (!msg) return new Response("ok");

  const text = msg.conversation
    ?? msg.extendedTextMessage?.text
    ?? msg.imageMessage?.caption
    ?? msg.documentMessage?.caption
    ?? "";

  const messageType = payload.data.messageType ?? "";

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
      await sendEvolutionMessage(ctx.apiUrl, ctx.apiKey, ctx.instanceName, remoteJid, sharedResult.text);
      return new Response("ok");
    }
  }

  // Download media from base64 → R2
  const mediaAssets: MediaAsset[] = [];
  try {
    if (messageType === "imageMessage" && msg.imageMessage?.base64) {
      const asset = await storeBase64Media(msg.imageMessage.base64, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.imageMessage.mimetype ?? "image/jpeg", type: "image",
      });
      if (asset) mediaAssets.push(asset);
    }
    if (messageType === "audioMessage" && msg.audioMessage?.base64) {
      const asset = await storeBase64Media(msg.audioMessage.base64, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.audioMessage.mimetype ?? "audio/ogg", type: "voice",
      });
      if (asset) mediaAssets.push(asset);
    }
    if (messageType === "documentMessage" && msg.documentMessage?.base64) {
      const asset = await storeBase64Media(msg.documentMessage.base64, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.documentMessage.mimetype ?? "application/octet-stream", type: "document",
        originalName: msg.documentMessage.fileName,
      });
      if (asset) mediaAssets.push(asset);
    }
  } catch (err) {
    console.warn("Evolution media store failed:", err);
  }

  // Build prompt
  try {
    let prompt = text;

    if (messageType === "locationMessage" && msg.locationMessage) {
      const loc = msg.locationMessage;
      const parts = ["[The user shared a location pin.]"];
      if (loc.name) parts.push(`Place: ${loc.name}`);
      if (loc.address) parts.push(`Address: ${loc.address}`);
      parts.push(`Latitude: ${loc.degreesLatitude}, Longitude: ${loc.degreesLongitude}`);
      parts.push(`Map: https://www.google.com/maps/search/?api=1&query=${loc.degreesLatitude},${loc.degreesLongitude}`);
      parts.push("The user shared this location. Do NOT assume they are there or traveling there. Simply acknowledge the location and ask what they'd like to do with it.");
      prompt = parts.join("\n");
    }

    if (!prompt && mediaAssets.length > 0) {
      const types = mediaAssets.map(a => a.type);
      if (types.includes("image")) prompt = "I sent you an image. Describe what you see.";
      else if (types.includes("voice")) prompt = "Voice message — transcription below. Treat it as my direct message: if it contains a request or action (save, note, reminder, calendar, todo, search…), execute it immediately with the appropriate tool BEFORE responding.";
      else prompt = "I sent you a file. Please analyze it.";
    }

    if (!prompt) return new Response("ok");

    const result = await ctx.runPrompt(prompt, mediaAssets.length > 0 ? mediaAssets : undefined);

    if ("error" in result) {
      await sendEvolutionMessage(ctx.apiUrl, ctx.apiKey, ctx.instanceName, remoteJid, `Error: ${result.error}`);
    } else {
      if (result.text && result.text !== "(no response)") {
        await sendEvolutionMessage(ctx.apiUrl, ctx.apiKey, ctx.instanceName, remoteJid, result.text);
      }
      if (result.mediaDelivery?.length) {
        for (const media of result.mediaDelivery) {
          try {
            const obj = await ctx.r2Memories.get(media.r2Key);
            if (!obj) continue;
            if (media.type === "audio") {
              await sendEvolutionAudio(ctx.apiUrl, ctx.apiKey, ctx.instanceName, remoteJid, obj, media.format);
            } else if (media.type === "image") {
              await sendEvolutionImage(ctx.apiUrl, ctx.apiKey, ctx.instanceName, remoteJid, obj);
            }
          } catch (err) {
            console.warn(`Evolution media delivery failed for ${media.r2Key}:`, err);
          }
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Internal error";
    await sendEvolutionMessage(ctx.apiUrl, ctx.apiKey, ctx.instanceName, remoteJid, `Error: ${errMsg}`);
  }

  return new Response("ok");
}

// ───────────────────────── Send Message ─────────────────────────

const MAX_LENGTH = 4096;

export async function sendEvolutionMessage(
  apiUrl: string,
  apiKey: string,
  instanceName: string,
  to: string,
  text: string,
): Promise<boolean> {
  const chunks = splitMessage(text, MAX_LENGTH);
  let success = true;
  for (const chunk of chunks) {
    const resp = await fetch(`${apiUrl}/message/sendText/${instanceName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ number: to, text: chunk }),
    });
    if (!resp.ok) {
      console.warn(`Evolution sendMessage failed: ${resp.status} ${await resp.text()}`);
      success = false;
    }
  }
  return success;
}

async function sendEvolutionAudio(
  apiUrl: string,
  apiKey: string,
  instanceName: string,
  to: string,
  r2Object: R2ObjectBody,
  format: string,
): Promise<void> {
  const bytes = await r2Object.arrayBuffer();
  const b64 = arrayBufferToBase64(bytes);
  const mime = format === "ogg" ? "audio/ogg" : "audio/mpeg";
  await fetch(`${apiUrl}/message/sendWhatsAppAudio/${instanceName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({ number: to, audio: `data:${mime};base64,${b64}` }),
  });
}

async function sendEvolutionImage(
  apiUrl: string,
  apiKey: string,
  instanceName: string,
  to: string,
  r2Object: R2ObjectBody,
): Promise<void> {
  const ct = r2Object.httpMetadata?.contentType || "image/jpeg";
  const bytes = await r2Object.arrayBuffer();
  const b64 = arrayBufferToBase64(bytes);
  await fetch(`${apiUrl}/message/sendMedia/${instanceName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({
      number: to,
      mediatype: "image",
      mimetype: ct,
      media: `data:${ct};base64,${b64}`,
    }),
  });
}

// ───────────────────────── Media Storage ─────────────────────────

async function storeBase64Media(
  dataUri: string,
  r2: R2Bucket,
  userId: string,
  opts: { mimeType: string; type: MediaAsset["type"]; originalName?: string },
): Promise<MediaAsset | null> {
  let base64 = dataUri;
  let mimeType = opts.mimeType;
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    mimeType = match[1];
    base64 = match[2];
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

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

  return { type: opts.type, r2Key, mimeType, originalName: opts.originalName, sizeBytes: bytes.byteLength };
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
    "video/mp4": "mp4", "application/pdf": "pdf", "text/plain": "txt",
  };
  return map[mime] || "bin";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** "5511999@s.whatsapp.net" → "5511999", group JIDs pass through */
export function jidToPhone(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net$/, "");
}
