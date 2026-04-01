import type { SqlFn } from "../config/sql.js";
import type { MediaAsset } from "../config/types.js";
import type { MediaDelivery } from "../pipeline.js";
import { downloadTelegramFile } from "../media/handler.js";
import { handleCommand } from "../commands.js";

// ───────────────────────── Types ─────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string; title?: string };
    date: number;
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
    voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
    audio?: { file_id: string; duration: number; mime_type?: string; file_name?: string; file_size?: number };
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    video_note?: { file_id: string; length: number; duration: number; file_size?: number };
    location?: { latitude: number; longitude: number };
    venue?: { location: { latitude: number; longitude: number }; title: string; address: string };
    reply_to_message?: { message_id: number; text?: string; caption?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: TelegramUpdate["message"];
  };
  message_reaction?: {
    chat: { id: number };
    message_id: number;
    user?: { id: number; first_name: string };
    date: number;
    new_reaction: Array<{ type: string; emoji: string }>;
    old_reaction: Array<{ type: string; emoji: string }>;
  };
}

export interface TelegramContext {
  sql: SqlFn;
  env: Env;
  sessionId: string;
  userId: string;
  botToken: string;
  /** Pipeline callback — runs the prompt through the full agent pipeline */
  runPrompt: (text: string, media?: MediaAsset[], onToolProgress?: (toolName: string, preview: string) => void) => Promise<{ text: string; mediaDelivery?: MediaDelivery[] } | { error: string }>;
  /** R2 bucket for fetching generated media */
  r2Memories: R2Bucket;
  /** Called when a command changes config that affects the system prompt */
  onCacheInvalidate?: () => void;
  /** Check+mark an update as processed. Returns true if already seen (duplicate webhook retry). */
  isUpdateProcessed?: (updateId: number) => boolean;
}

// ───────────────────────── Webhook Registration ─────────────────────────

export async function registerTelegramWebhook(
  botToken: string,
  workerUrl: string,
  secretToken: string
): Promise<{ ok: boolean; description?: string }> {
  const webhookUrl = `${workerUrl}/webhook/telegram`;
  const [webhookResp] = await Promise.all([
    fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ["message", "callback_query", "message_reaction"],
      }),
    }),
    // Set bot description (shown on first open)
    fetch(`https://api.telegram.org/bot${botToken}/setMyDescription`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "AI agent with persistent memory, web search, image generation, voice, and document analysis. Learns from every conversation.",
      }),
    }),
    fetch(`https://api.telegram.org/bot${botToken}/setMyShortDescription`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        short_description: "AI agent that remembers, searches the web, and learns.",
      }),
    }),
    // Register bot menu commands
    fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "status", description: "Model, tokens, agent info" },
          { command: "memory", description: "Show persistent memory" },
          { command: "skills", description: "List installed skills" },
          { command: "search", description: "Search past conversations" },
          { command: "soul", description: "Show personality file" },
          { command: "session", description: "Session info and auto-reset config" },
          { command: "personality", description: "Switch personality preset" },
          { command: "note", description: "Save a note (or show recent)" },
          { command: "notes", description: "List all notes" },
          { command: "reset", description: "Reset current session" },
          { command: "help", description: "Show available commands" },
        ],
      }),
    }),
  ]);
  return webhookResp.json<{ ok: boolean; description?: string }>();
}

export async function deleteTelegramWebhook(botToken: string): Promise<boolean> {
  const resp = await fetch(
    `https://api.telegram.org/bot${botToken}/deleteWebhook`,
    { method: "POST" }
  );
  const result = await resp.json<{ ok: boolean }>();
  return result.ok;
}

// ───────────────────────── Webhook Handler ─────────────────────────

/**
 * Thin Telegram wrapper — handles I/O only.
 * All intelligence (tools, memory, routing, self-learning) comes from ctx.runPrompt.
 */
export async function handleTelegramUpdate(
  request: Request,
  ctx: TelegramContext
): Promise<Response> {
  // Secret is already verified by the Worker (index.ts). Parse the update.
  const update: TelegramUpdate = await request.json();
  const botToken = ctx.botToken;

  // ── Dedup: reject retried webhooks (Telegram retries after 60s timeout) ──
  if (ctx.isUpdateProcessed?.(update.update_id)) {
    console.log(`[telegram] Skipping duplicate update_id=${update.update_id}`);
    return new Response("ok");
  }

  // ── Handle message reactions (✍️ = save as note) ──
  if (update.message_reaction) {
    const reaction = update.message_reaction;
    const hasWriteEmoji = reaction.new_reaction.some(
      r => r.emoji === "✍" || r.emoji === "✍️"
    );
    if (hasWriteEmoji) {
      // No session_id filter — the message may belong to an older session (after auto-reset)
      const row = ctx.sql<{ content: string }>`
        SELECT content FROM session_messages
        WHERE platform_msg_id = ${reaction.message_id}
        ORDER BY id DESC LIMIT 1
      `;
      if (row[0]?.content?.trim()) {
        ctx.sql`INSERT INTO notes (content, source) VALUES (${row[0].content.trim().slice(0, 5000)}, 'reaction')`;
        await setReaction(botToken, reaction.chat.id, reaction.message_id, "✅");
      } else {
        console.warn(`[telegram] Reaction-to-note: no message found for platform_msg_id=${reaction.message_id}`);
        await setReaction(botToken, reaction.chat.id, reaction.message_id, "❓");
      }
    }
    return new Response("ok");
  }

  // ── Handle callback queries (inline keyboard buttons) ──
  if (update.callback_query) {
    const cbq = update.callback_query;
    if (cbq.data === "save_note" && cbq.message) {
      const noteText = cbq.message.text ?? cbq.message.caption ?? "";
      if (noteText.trim()) {
        ctx.sql`INSERT INTO notes (content, source) VALUES (${noteText.trim().slice(0, 5000)}, 'chat')`;
        await answerCallbackQuery(botToken, cbq.id, "📝 Note saved!");
      } else {
        await answerCallbackQuery(botToken, cbq.id, "Nothing to save.");
      }
    } else {
      await answerCallbackQuery(botToken, cbq.id);
    }
    return new Response("ok");
  }

  const msg = update.message;
  const text = msg?.text ?? msg?.caption ?? "";
  const chatId = msg?.chat.id;

  const messageId = msg?.message_id;
  const hasLocation = !!(msg?.location || msg?.venue);
  const hasMedia = !!(msg?.photo || msg?.voice || msg?.audio || msg?.document || msg?.video_note);
  if (!chatId || (!text && !hasMedia && !hasLocation)) {
    return new Response("ok");
  }

  // ── Handle ✍️ sent as text message (non-Premium users can't use custom reactions) ──
  const trimmedText = text.trim();
  if (trimmedText === "✍" || trimmedText === "✍️") {
    // Save the most recent assistant message as a note, or the replied-to message
    const replyMsgId = msg?.reply_to_message?.message_id;
    const row = replyMsgId
      ? ctx.sql<{ content: string }>`SELECT content FROM session_messages WHERE platform_msg_id = ${replyMsgId} ORDER BY id DESC LIMIT 1`
      : ctx.sql<{ content: string }>`SELECT content FROM session_messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1`;
    if (row[0]?.content?.trim()) {
      ctx.sql`INSERT INTO notes (content, source) VALUES (${row[0].content.trim().slice(0, 5000)}, 'reaction')`;
      await setReaction(botToken, chatId, messageId!, "✅");
    } else {
      await setReaction(botToken, chatId, messageId!, "❓");
    }
    return new Response("ok");
  }

  // Handle slash commands — shared commands first, then Telegram-specific
  if (text.startsWith("/")) {
    // Shared commands (work on all gateways)
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
      await sendTelegramMessage(botToken, chatId, escapeMarkdownV2(sharedResult.text), messageId);
      return new Response("ok");
    }
    // Telegram-specific commands (/start, /link)
    const chatTitle = msg?.chat.title ?? msg?.from?.first_name;
    const chatType = msg?.chat.type ?? "private";
    const tgReply = await handleTelegramOnlyCommand(text, ctx, chatId, { type: chatType, title: chatTitle });
    if (tgReply) {
      await sendTelegramMessage(botToken, chatId, tgReply, messageId);
      return new Response("ok");
    }
  }

  // 5. Download media attachments (if any)
  const mediaAssets: MediaAsset[] = [];
  try {
    if (msg?.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1]; // highest resolution
      const asset = await downloadTelegramFile(botToken, largest.file_id, ctx.env.MEMORIES, ctx.userId, {
        mimeType: "image/jpeg", type: "image",
      });
      mediaAssets.push(asset);
    }
    if (msg?.voice) {
      const asset = await downloadTelegramFile(botToken, msg.voice.file_id, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.voice.mime_type ?? "audio/ogg", type: "voice",
      });
      mediaAssets.push(asset);
    }
    if (msg?.audio) {
      const asset = await downloadTelegramFile(botToken, msg.audio.file_id, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.audio.mime_type ?? "audio/mpeg", type: "voice",
        originalName: msg.audio.file_name,
      });
      mediaAssets.push(asset);
    }
    if (msg?.document) {
      const asset = await downloadTelegramFile(botToken, msg.document.file_id, ctx.env.MEMORIES, ctx.userId, {
        mimeType: msg.document.mime_type ?? "application/octet-stream", type: "document",
        originalName: msg.document.file_name,
      });
      mediaAssets.push(asset);
    }
    if (msg?.video_note) {
      const asset = await downloadTelegramFile(botToken, msg.video_note.file_id, ctx.env.MEMORIES, ctx.userId, {
        mimeType: "video/mp4", type: "voice",
      });
      mediaAssets.push(asset);
    }
  } catch (err) {
    console.warn("Media download failed:", err);
  }

  // 6. React 👀 + send placeholder + start typing indicator
  if (messageId) setReaction(botToken, chatId, messageId, "👀");
  // Send a quick placeholder — edited later with the real response
  const placeholderMsgId = await sendQuickPlaceholder(botToken, chatId, messageId);
  const typingInterval = startTypingLoop(botToken, chatId);

  // 7. Build prompt — handle location, reply context, media auto-prompts
  try {
    let prompt = text;

    // Location messages → lat/lon + Google Maps link
    if (hasLocation && !prompt) {
      const loc = msg?.venue?.location ?? msg?.location;
      if (loc) {
        const parts = ["[The user shared a location pin.]"];
        if (msg?.venue) {
          parts.push(`Venue: ${msg.venue.title}`);
          parts.push(`Address: ${msg.venue.address}`);
        }
        parts.push(`Latitude: ${loc.latitude}, Longitude: ${loc.longitude}`);
        parts.push(`Map: https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`);
        parts.push("The user shared this location. Do NOT assume they are there or traveling there. Simply acknowledge the location and ask what they'd like to do with it (e.g. find nearby places, get directions, save it as a note, etc.).");
        prompt = parts.join("\n");
      }
    }

    // Reply context — inject quoted message text
    if (msg?.reply_to_message) {
      const quoted = msg.reply_to_message.text ?? msg.reply_to_message.caption;
      if (quoted) {
        prompt = `[Replying to: "${quoted.slice(0, 300)}"]\n${prompt}`;
      }
    }

    if (!prompt && mediaAssets.length > 0) {
      const types = mediaAssets.map(a => a.type);
      if (types.includes("image")) prompt = "I sent you an image. Describe what you see.";
      else if (types.includes("voice")) prompt = "Voice message — transcription below. Treat it as my direct message: if it contains a request or action (save, note, reminder, calendar, todo, search…), execute it immediately with the appropriate tool BEFORE responding.";
      else prompt = "I sent you a file. Please analyze it.";
    }
    if (!prompt) prompt = "";

    // Tool progress: edit the placeholder message with live tool status
    const TOOL_EMOJIS: Record<string, string> = {
      web: "🔍", memory: "🧠", history: "📜", skills: "📚", todo: "✅",
      docs: "📄", notes: "📝", calendar: "📅", image: "🎨", tts: "🔊",
      codemode: "⚡", browser: "🌐", clarify: "❓",
    };
    const progressLines: string[] = [];
    const onToolProgress = placeholderMsgId
      ? (toolName: string, preview: string) => {
          const emoji = TOOL_EMOJIS[toolName] ?? "⚙️";
          const line = preview ? `${emoji} ${toolName}: "${preview}"` : `${emoji} ${toolName}...`;
          progressLines.push(line);
          // Fire-and-forget edit — don't await to avoid blocking the pipeline
          editTelegramMessage(botToken, chatId, placeholderMsgId, progressLines.join("\n")).catch(() => {});
        }
      : undefined;

    const result = await ctx.runPrompt(prompt, mediaAssets.length > 0 ? mediaAssets : undefined, onToolProgress);

    clearInterval(typingInterval);

    // Stamp user message with Telegram message_id for ✍️ reaction-to-note
    if (messageId) {
      ctx.sql`UPDATE session_messages SET platform_msg_id = ${messageId}
        WHERE id = (SELECT id FROM session_messages WHERE session_id = ${ctx.sessionId} AND role = 'user' ORDER BY id DESC LIMIT 1)`;
    }

    if ("error" in result) {
      if (placeholderMsgId) {
        await editTelegramMessage(botToken, chatId, placeholderMsgId, escapeMarkdownV2(result.error));
      } else {
        await sendTelegramMessage(botToken, chatId, escapeMarkdownV2(result.error), messageId);
      }
    } else {
      // Edit placeholder with real response (or send new if placeholder failed)
      if (result.text && result.text !== "(no response)") {
        const noteKeyboard = {
          inline_keyboard: [[{ text: "📝", callback_data: "save_note" }]],
        };
        let sentMsgId: number | undefined;
        if (placeholderMsgId) {
          const edited = await editTelegramMessage(botToken, chatId, placeholderMsgId, result.text, noteKeyboard);
          sentMsgId = edited ? placeholderMsgId : undefined;
        }
        // Fallback: send new message if edit failed or no placeholder
        if (!sentMsgId) {
          sentMsgId = await sendTelegramMessage(botToken, chatId, result.text, messageId, noteKeyboard);
        }
        // Stamp bot message with Telegram message_id for ✍️ reaction-to-note
        if (sentMsgId) {
          ctx.sql`UPDATE session_messages SET platform_msg_id = ${sentMsgId}
            WHERE id = (SELECT id FROM session_messages WHERE session_id = ${ctx.sessionId} AND role = 'assistant' ORDER BY id DESC LIMIT 1)`;
        }
      }

      // Deliver generated media (TTS audio, images)
      if (result.mediaDelivery?.length) {
        for (const media of result.mediaDelivery) {
          try {
            const obj = await ctx.r2Memories.get(media.r2Key);
            if (!obj) continue;
            const bytes = await obj.arrayBuffer();

            if (media.type === "audio") {
              await sendTelegramAudio(botToken, chatId, bytes, media.format);
            } else if (media.type === "image") {
              await sendTelegramPhoto(botToken, chatId, bytes);
            }
          } catch (err) {
            console.warn(`Media delivery failed for ${media.r2Key}:`, err);
          }
        }
      }
    }
    // React ✅ when done
    if (messageId) setReaction(botToken, chatId, messageId, "✅");
  } catch (err) {
    clearInterval(typingInterval);
    if (messageId) setReaction(botToken, chatId, messageId, "❌");
    const msg = err instanceof Error ? err.message : "Internal error";
    await sendTelegramMessage(botToken, chatId, `Error: ${escapeMarkdownV2(msg)}`, messageId);
  }

  return new Response("ok");
}

// ───────────────────────── Telegram-Only Commands ─────────────────────────

async function handleTelegramOnlyCommand(
  text: string,
  ctx: TelegramContext,
  chatId: number,
  chatMeta?: { type: string; title?: string },
): Promise<string | null> {
  const cmd = text.split(" ")[0].toLowerCase().replace(/@.*$/, "");

  switch (cmd) {
    case "/start":
      return [
        "Hi\\! I'm Clopinette\\.",
        "",
        "Send me a message, a photo, or a voice note and I'll help you out\\.",
        "",
        "Already have an account? Use /link to connect your Telegram to your web account\\. Same memory, same files, everywhere\\.",
        "",
        "New here? Sign up at clopinette\\.app",
      ].join("\n");
    case "/link": {
      const chatIdStr = String(chatId);
      const isGroup = chatMeta?.type === "group" || chatMeta?.type === "supergroup";
      const arg = text.split(/\s+/)[1]?.toLowerCase();

      // Groups require mode choice: /link trusted or /link shared
      if (isGroup && !arg) {
        return [
          "*Choose a linking mode:*",
          "",
          "`/link trusted` \\— Family mode\\. Full memory, skills, and history shared with everyone in this group\\.",
          "`/link shared` \\— Public mode\\. Clean bot, no private memory\\. Good for friend groups\\.",
        ].join("\n");
      }

      const isShared = isGroup && arg === "shared";
      const code = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 36]).join("");
      const payload = JSON.stringify({
        platform: "tg",
        externalId: chatIdStr,
        chatType: chatMeta?.type ?? "private",
        chatTitle: chatMeta?.title ?? chatIdStr,
        ...(isShared && { shared: true }),
      });
      await ctx.env.LINKS.put(`link_code:${code}`, payload, { expirationTtl: 300 });
      const mode = isShared ? "shared \\(no private memory\\)" : "trusted \\(full memory\\)";
      return `Your link code: \`${code}\`\nMode: ${mode}\n\nEnter this code in the web app to link\\. Expires in 5 minutes\\.`;
    }
    default:
      return null;
  }
}

// ───────────────────────── Typing Indicator ─────────────────────────

function startTypingLoop(
  botToken: string,
  chatId: number
): ReturnType<typeof setInterval> {
  sendChatAction(botToken, chatId, "typing");
  return setInterval(() => sendChatAction(botToken, chatId, "typing"), 4000);
}

async function sendChatAction(
  botToken: string,
  chatId: number,
  action: string
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch { /* non-fatal */ }
}

async function setReaction(
  botToken: string,
  chatId: number,
  messageId: number,
  emoji: string | null
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/setMessageReaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: emoji ? [{ type: "emoji", emoji }] : [],
      }),
    });
  } catch { /* non-fatal */ }
}

// ───────────────────────── Placeholder ─────────────────────────

/** Send a quick "thinking" placeholder — will be edited with the real response. */
async function sendQuickPlaceholder(
  botToken: string,
  chatId: number,
  replyTo?: number,
): Promise<number | undefined> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "...",
        ...(replyTo && { reply_to_message_id: replyTo }),
      }),
    });
    if (!resp.ok) return undefined;
    const data = await resp.json<{ result?: { message_id?: number } }>().catch(() => null);
    return data?.result?.message_id;
  } catch { return undefined; }
}

// ───────────────────────── Edit Message ─────────────────────────

async function editTelegramMessage(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "MarkdownV2",
        ...(replyMarkup && { reply_markup: replyMarkup }),
      }),
    });
    if (!resp.ok) {
      // Fallback: if MarkdownV2 fails, retry plain text
      const resp2 = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, ""),
          ...(replyMarkup && { reply_markup: replyMarkup }),
        }),
      });
      return resp2.ok;
    }
    return true;
  } catch { return false; }
}

// ───────────────────────── Send Message ─────────────────────────

const TELEGRAM_MAX_LENGTH = 4096;
const MAX_SEND_RETRIES = 3;

export async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyToMessageId?: number,
  replyMarkup?: Record<string, unknown>
): Promise<number | undefined> {
  const chunks = splitMessage(text, TELEGRAM_MAX_LENGTH);
  const total = chunks.length;
  let lastMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (total > 1) {
      chunk += `\n\n\\(${i + 1}/${total}\\)`;
    }
    // Only reply-quote the first chunk, only attach keyboard to the last chunk
    const isLast = i === chunks.length - 1;
    const msgId = await sendChunkWithFallback(
      botToken, chatId, chunk,
      i === 0 ? replyToMessageId : undefined,
      isLast ? replyMarkup : undefined,
    );
    if (msgId) lastMessageId = msgId;
  }
  return lastMessageId;
}

async function sendChunkWithFallback(
  botToken: string,
  chatId: number,
  chunk: string,
  replyToMessageId?: number,
  replyMarkup?: Record<string, unknown>
): Promise<number | undefined> {
  for (let attempt = 0; attempt < MAX_SEND_RETRIES; attempt++) {
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: "MarkdownV2",
            ...(replyToMessageId && { reply_to_message_id: replyToMessageId }),
            ...(replyMarkup && { reply_markup: replyMarkup }),
          }),
        }
      );

      if (resp.ok) {
        const data = await resp.json<{ result?: { message_id?: number } }>().catch(() => null);
        return data?.result?.message_id;
      }

      const err = await resp.json<{ description?: string }>().catch(() => null);
      const desc = err?.description?.toLowerCase() ?? "";

      if (desc.includes("parse") || desc.includes("markdown") || desc.includes("entity")) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: stripMarkdown(chunk),
            ...(replyToMessageId && { reply_to_message_id: replyToMessageId }),
          }),
        });
        return;
      }

      const retryMatch = desc.match(/retry after (\d+)/);
      if (retryMatch) {
        await sleep(parseInt(retryMatch[1], 10) * 1000);
        continue;
      }

      return;
    } catch {
      if (attempt < MAX_SEND_RETRIES - 1) {
        await sleep(2 ** attempt * 1000);
      }
    }
  }
}

// ───────────────────────── Message Splitting ─────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openCodeLang: string | null = null;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen / 3) splitIdx = maxLen;

    let chunk = remaining.slice(0, splitIdx);
    remaining = remaining.slice(splitIdx);

    if (openCodeLang) {
      chunk = `\`\`\`${openCodeLang}\n${chunk}`;
      openCodeLang = null;
    }

    const totalFences = chunk.match(/```/g);
    const isOpen = totalFences ? totalFences.length % 2 !== 0 : false;

    if (isOpen) {
      const langMatch = chunk.match(/```(\w*)\n/);
      openCodeLang = langMatch?.[1] ?? "";
      chunk += "\n```";
    }

    chunks.push(chunk);
  }

  return chunks;
}

// ───────────────────────── Formatting ─────────────────────────

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~(.+?)~/g, "$1")
    .replace(/\|\|(.+?)\|\|/g, "$1");
}

async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text && { text }),
      }),
    });
  } catch { /* non-fatal */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────── Media Delivery ─────────────────────────

async function sendTelegramAudio(
  botToken: string,
  chatId: number,
  audioBytes: ArrayBuffer,
  format: string
): Promise<void> {
  const blob = new Blob([audioBytes], { type: format === "ogg" ? "audio/ogg" : "audio/mpeg" });
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("audio", blob, `audio.${format}`);

  await fetch(`https://api.telegram.org/bot${botToken}/sendAudio`, {
    method: "POST",
    body: form,
  });
}

async function sendTelegramPhoto(
  botToken: string,
  chatId: number,
  imageBytes: ArrayBuffer,
  format = "jpg"
): Promise<void> {
  const mimeType = format === "png" ? "image/png" : "image/jpeg";
  const blob = new Blob([imageBytes], { type: mimeType });
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", blob, `image.${format}`);

  await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    body: form,
  });
}
