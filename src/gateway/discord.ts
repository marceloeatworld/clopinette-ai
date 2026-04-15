/**
 * Discord gateway — handles both:
 *   1. Interactions (slash commands) — direct from Discord HTTP webhook
 *   2. Bridge messages — forwarded by external Gateway bridge service
 *
 * Discord requires a persistent WebSocket (Gateway) for regular messages,
 * which Workers can't maintain. A small external bridge connects to the
 * Discord Gateway and POSTs MESSAGE_CREATE events here — same pattern
 * as Evolution API for WhatsApp.
 *
 * Secrets:
 *   DISCORD_PUBLIC_KEY      — Ed25519 (Interactions signature verification)
 *   DISCORD_APPLICATION_ID  — for interaction followup URLs
 *   DISCORD_TOKEN           — bot token for REST API calls
 *
 * User ID: author.id (bridge) or interaction member/user id
 * DO name: dc_{discordUserId}
 */

import type { SqlFn } from "../config/sql.js";
import type { MediaAsset } from "../config/types.js";
import type { MediaDelivery } from "../pipeline.js";
import { downloadAndStore } from "../media/handler.js";
import { handleCommand } from "../commands.js";
import { DiscordProgressController, type DiscordEditResult } from "./discord-progress.js";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_LENGTH = 2000;

// ───────────────────────── Types ─────────────────────────

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
  proxy_url: string;
}

/** Message forwarded by bridge (Gateway MESSAGE_CREATE → HTTP POST) */
export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  attachments?: DiscordAttachment[];
  referenced_message?: { id: string; content?: string; author?: DiscordUser };
  guild_id?: string;
}

/** Discord Interaction (slash commands, type 2 = APPLICATION_COMMAND) */
export interface DiscordInteraction {
  type: number;
  id: string;
  application_id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    name: string;
    options?: Array<{ name: string; value: string; type: number }>;
  };
}

/** Payload from bridge service */
export interface DiscordBridgePayload {
  type: "MESSAGE_CREATE";
  message: DiscordMessage;
}

export interface DiscordRoutingOptions {
  applicationId: string;
  requireMention?: boolean;
  freeResponseChannels?: Iterable<string>;
}

export interface DiscordContext {
  sql: SqlFn;
  env: Env;
  sessionId: string;
  userId: string;
  botToken: string;
  applicationId: string;
  runPrompt: (text: string, media?: MediaAsset[], onToolProgress?: (toolName: string, preview: string) => void, chatId?: string) => Promise<{ text: string; mediaDelivery?: MediaDelivery[] } | { error: string }>;
  r2Memories: R2Bucket;
  onCacheInvalidate?: () => void;
}

// ───────────────────────── Slash Command Registration ─────────────────────────

export async function registerDiscordCommands(
  applicationId: string,
  botToken: string,
): Promise<{ ok: boolean; count: number }> {
  const commands = [
    {
      name: "ask",
      description: "Ask Clopinette anything",
      options: [{ name: "prompt", description: "Your message", type: 3 /* STRING */, required: true }],
    },
    {
      name: "research",
      description: "Deep research with parallel sub-agents",
      options: [{ name: "topic", description: "What to research", type: 3, required: true }],
    },
    {
      name: "model",
      description: "Show or switch the active LLM",
      options: [
        { name: "provider", description: "Provider slug (e.g. anthropic, workers-ai)", type: 3, required: false },
        { name: "id", description: "Model id (e.g. claude-sonnet-4-5)", type: 3, required: false },
      ],
    },
    { name: "insights", description: "Cost breakdown by model this month" },
    { name: "status", description: "Model, tokens, agent info" },
    { name: "memory", description: "Show persistent memory" },
    { name: "forget", description: "Clear MEMORY.md and USER.md" },
    { name: "skills", description: "List installed skills" },
    { name: "search", description: "Search past conversations", options: [{ name: "query", description: "Search query", type: 3, required: true }] },
    { name: "session", description: "Session info and auto-reset config" },
    { name: "personality", description: "Switch personality preset", options: [{ name: "name", description: "Personality name", type: 3, required: false }] },
    { name: "note", description: "Save a note", options: [{ name: "text", description: "Note content", type: 3, required: false }] },
    { name: "notes", description: "List all notes" },
    { name: "reset", description: "Reset current session" },
    { name: "help", description: "Show available commands" },
    { name: "link", description: "Link Discord to your clopinette.app account", options: [{ name: "mode", description: "trusted (family, full memory) or shared (public, no memory)", type: 3, required: false, choices: [{ name: "Trusted (family — full memory)", value: "trusted" }, { name: "Shared (public — no private memory)", value: "shared" }] }] },
  ];

  const resp = await fetch(`${DISCORD_API}/applications/${applicationId}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });

  return { ok: resp.ok, count: commands.length };
}

// ───────────────────────── Interaction Handler (Slash Commands) ─────────────────────────

/**
 * Handle a Discord Interaction. Returns the initial response to Discord
 * (type 4 for instant, type 5 for deferred). For deferred, the actual
 * processing + followup edit happens asynchronously (caller uses waitUntil).
 */
export async function handleDiscordInteraction(
  interaction: DiscordInteraction,
  ctx: DiscordContext,
): Promise<Response> {
  if (interaction.type === 1) return Response.json({ type: 1 }); // PING

  if (interaction.type !== 2 || !interaction.data) {
    return Response.json({ type: 1 });
  }

  const commandName = interaction.data.name;

  // /link — ephemeral, no DO needed
  // Guild → link the server (trusted or shared), DM → link the user
  if (commandName === "link") {
    const dcUserId = interaction.member?.user?.id ?? interaction.user?.id ?? "";
    const isGuild = !!interaction.guild_id;
    const mode = interaction.data.options?.find(o => o.name === "mode")?.value;

    // In guilds, require mode choice
    if (isGuild && !mode) {
      return Response.json({
        type: 4,
        data: {
          content: [
            "**Choose a linking mode:**",
            "",
            "`/link mode:trusted` — Family mode. Full memory, skills, and history shared with everyone in this server.",
            "`/link mode:shared` — Public mode. Clean bot, no private memory. Good for friend groups.",
          ].join("\n"),
          flags: 64,
        },
      });
    }

    const isShared = isGuild && mode === "shared";
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(b => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 36]).join("");
    const payload = JSON.stringify({
      platform: isGuild ? "dcg" : "dc",
      externalId: isGuild ? interaction.guild_id : dcUserId,
      ...(isShared && { shared: true }),
    });
    await ctx.env.LINKS.put(`link_code:${code}`, payload, { expirationTtl: 300 });
    const target = isGuild ? "this server" : "your Discord account";
    const modeLabel = isShared ? " (shared — no private memory)" : isGuild ? " (trusted — full memory)" : "";
    return Response.json({
      type: 4,
      data: {
        content: `Your link code: \`${code}\`${modeLabel}\n\nEnter this code at **clopinette.app** to link ${target}. Expires in 5 minutes.`,
        flags: 64,
      },
    });
  }

  // /help — ephemeral, instant
  if (commandName === "help") {
    return Response.json({
      type: 4,
      data: {
        content: [
          "**Clopinette** — AI agent with memory, web search, image generation, and more.",
          "",
          "**Commands:**",
          "`/ask <prompt>` — Ask anything",
          "`/status` — Model & usage info",
          "`/memory` — Persistent memory",
          "`/skills` — Installed skills",
          "`/search <query>` — Search conversations",
          "`/session` — Session info",
          "`/personality [name]` — Switch personality",
          "`/note [text]` — Save or show notes",
          "`/notes` — List all notes",
          "`/reset` — New session",
          "`/link` — Link to clopinette.app (DMs)",
          "`/link mode:trusted` — Link server, full memory (family)",
          "`/link mode:shared` — Link server, no memory (public)",
          "",
          "**In DMs:** just type naturally — no slash command needed.",
          "",
          "Sign up at **clopinette.app**",
        ].join("\n"),
        flags: 64,
      },
    });
  }

  // All other commands: defer (type 5), process async, edit followup
  // Return the deferred response to Discord immediately.
  // The caller (agent.ts) wraps the processing in waitUntil.
  return Response.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
}

/**
 * Process a deferred interaction (called inside waitUntil after returning type 5).
 * Runs the command or prompt, then edits the original deferred response.
 */
export async function processInteractionDeferred(
  interaction: DiscordInteraction,
  ctx: DiscordContext,
): Promise<void> {
  const commandName = interaction.data!.name;
  // Join ALL option values so multi-option commands like `/model <provider> <id>`
  // produce `provider id` instead of just the first option's value.
  const arg = (interaction.data!.options ?? [])
    .map((o) => String(o.value ?? ""))
    .filter(Boolean)
    .join(" ");

  // /ask — run through the full pipeline
  if (commandName === "ask") {
    const result = await ctx.runPrompt(arg);
    if ("error" in result) {
      await editOriginalResponse(ctx.applicationId, interaction.token, `Error: ${result.error}`);
    } else {
      await editOriginalResponse(ctx.applicationId, interaction.token, result.text || "(no response)");
      // Deliver media
      if (result.mediaDelivery?.length && interaction.channel_id) {
        await deliverMedia(ctx, interaction.channel_id, result.mediaDelivery);
      }
    }
    return;
  }

  // Shared commands (/status, /memory, /reset, /skills, /search, /session, /personality, /note, /notes)
  const cmdText = arg ? `/${commandName} ${arg}` : `/${commandName}`;
  const sharedResult = await handleCommand(cmdText, {
    sql: ctx.sql,
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    env: ctx.env,
    r2Memories: ctx.r2Memories,
    r2Skills: ctx.env.SKILLS,
    onCacheInvalidate: ctx.onCacheInvalidate,
  });

  if (sharedResult?.handled === false) {
    // Rewrite mode (e.g. /research) — run the rewritten prompt through the pipeline
    // and edit the original deferred response with the synthesized answer.
    const result = await ctx.runPrompt(sharedResult.rewriteAs, undefined, undefined, interaction.channel_id);
    const reply = "error" in result ? `Error: ${result.error}` : result.text;
    await editOriginalResponse(ctx.applicationId, interaction.token, reply || "Done.");
    return;
  }

  await editOriginalResponse(
    ctx.applicationId,
    interaction.token,
    sharedResult?.text ?? "Done.",
  );
}

// ───────────────────────── Bridge Message Handler ─────────────────────────

/**
 * Handle a message forwarded by the Discord Gateway bridge.
 * Same pattern as handleTelegramUpdate — thin I/O, all intelligence from runPrompt.
 */
export async function handleDiscordMessage(
  message: DiscordMessage,
  ctx: DiscordContext,
): Promise<void> {
  if (!shouldProcessDiscordMessage(message, resolveDiscordRoutingOptions(ctx))) return;

  const channelId = message.channel_id;
  let text = stripDiscordBotMentions(message.content ?? "", ctx.applicationId);

  // Handle slash commands (typed manually in DMs, e.g. "/status")
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
    if (sharedResult?.handled === true) {
      await sendDiscordMessage(ctx.botToken, channelId, sharedResult.text);
      return;
    }
    if (sharedResult?.handled === false) {
      text = sharedResult.rewriteAs;
    }
    // Discord-specific commands
    const dcReply = await handleDiscordOnlyCommand(text, ctx, message.author.id, message.guild_id);
    if (dcReply) {
      await sendDiscordMessage(ctx.botToken, channelId, dcReply);
      return;
    }
  }

  // Download media attachments (Discord provides direct URLs — no getFile step)
  const mediaAssets: MediaAsset[] = [];
  try {
    if (message.attachments?.length) {
      for (const att of message.attachments) {
        const mime = att.content_type ?? guessMimeFromFilename(att.filename);
        const type = mediaTypeFromMime(mime);
        const asset = await downloadAndStore(att.url, ctx.r2Memories, ctx.userId, {
          mimeType: mime,
          type,
          originalName: att.filename,
        });
        mediaAssets.push(asset);
      }
    }
  } catch (err) {
    console.warn("Discord media download failed:", err);
  }

  // Typing indicator
  const typingLoop = startTypingLoop(ctx.botToken, channelId);

  try {
    let prompt = text;

    // Reply context — inject quoted message
    if (message.referenced_message?.content) {
      prompt = `[Replying to: "${message.referenced_message.content.slice(0, 300)}"]\n${prompt}`;
    }

    // Auto-prompt for media without text
    if (!prompt && mediaAssets.length > 0) {
      const types = mediaAssets.map(a => a.type);
      if (types.includes("image")) prompt = "I sent you an image. Describe what you see.";
      else if (types.includes("voice")) prompt = "Voice message — transcription below. Treat it as my direct message: if it contains a request or action (save, note, reminder, calendar, todo, search…), execute it immediately with the appropriate tool BEFORE responding.";
      else prompt = "I sent you a file. Please analyze it.";
    }

    if (!prompt) {
      typingLoop.stop();
      return;
    }

    const placeholderMsgId = await sendDiscordMessage(
      ctx.botToken,
      channelId,
      DiscordProgressController.initialText(),
    );
    const progressController = placeholderMsgId
      ? new DiscordProgressController({
          editMessage: (content) => editDiscordMessage(ctx.botToken, channelId, placeholderMsgId, content),
          pingTyping: () => triggerTyping(ctx.botToken, channelId),
        })
      : null;
    progressController?.start();
    const onToolProgress = placeholderMsgId
      ? (toolName: string, preview: string) => progressController?.pushToolProgress(toolName, preview)
      : undefined;

    const result = await ctx.runPrompt(prompt, mediaAssets.length > 0 ? mediaAssets : undefined, onToolProgress, channelId);

    typingLoop.stop();
    progressController?.stop();

    if ("error" in result) {
      if (placeholderMsgId) {
        const sentMsgId = await replaceDiscordPlaceholder(ctx.botToken, channelId, placeholderMsgId, `Error: ${result.error}`);
        if (!sentMsgId) {
          await sendDiscordMessage(ctx.botToken, channelId, `Error: ${result.error}`);
        }
      } else {
        await sendDiscordMessage(ctx.botToken, channelId, `Error: ${result.error}`);
      }
    } else {
      if (result.text && result.text !== "(no response)") {
        if (placeholderMsgId) {
          const sentMsgId = await replaceDiscordPlaceholder(ctx.botToken, channelId, placeholderMsgId, result.text);
          if (!sentMsgId) {
            await sendDiscordMessage(ctx.botToken, channelId, result.text);
          }
        } else {
          await sendDiscordMessage(ctx.botToken, channelId, result.text);
        }
      }

      // Deliver generated media
      if (result.mediaDelivery?.length) {
        await deliverMedia(ctx, channelId, result.mediaDelivery);
      }
    }
  } catch (err) {
    typingLoop.stop();
    const errMsg = err instanceof Error ? err.message : "Internal error";
    await sendDiscordMessage(ctx.botToken, channelId, `Error: ${errMsg}`);
  }
}

// ───────────────────────── Discord-Only Commands ─────────────────────────

async function handleDiscordOnlyCommand(
  text: string,
  ctx: DiscordContext,
  discordUserId: string,
  guildId?: string,
): Promise<string | null> {
  const cmd = text.split(/\s+/)[0].toLowerCase();

  switch (cmd) {
    case "/start":
      return [
        "Hi! I'm Clopinette.",
        "",
        "Send me a message, a photo, or a file and I'll help you out.",
        "",
        "**Link your account:**",
        "In DMs: `/link` — connects to your clopinette.app account",
        "In a server:",
        "• `/link trusted` — family mode, full memory shared with everyone",
        "• `/link shared` — public mode, clean bot, no private memory",
        "",
        "New here? Sign up at **clopinette.app**",
      ].join("\n");

    case "/link": {
      const isGuild = !!guildId;
      const arg = text.split(/\s+/)[1]?.toLowerCase();

      if (isGuild && !arg) {
        return [
          "**Choose a linking mode:**",
          "",
          "`/link trusted` — Family mode. Full memory, skills, and history shared with everyone.",
          "`/link shared` — Public mode. Clean bot, no private memory.",
        ].join("\n");
      }

      const isShared = isGuild && arg === "shared";
      const code = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 36]).join("");
      const payload = JSON.stringify({
        platform: isGuild ? "dcg" : "dc",
        externalId: isGuild ? guildId : discordUserId,
        ...(isShared && { shared: true }),
      });
      await ctx.env.LINKS.put(`link_code:${code}`, payload, { expirationTtl: 300 });
      const target = isGuild ? "this server" : "your Discord account";
      const mode = isShared ? " (shared)" : isGuild ? " (trusted)" : "";
      return `Your link code: \`${code}\`${mode}\n\nEnter this code at **clopinette.app** to link ${target}. Expires in 5 minutes.`;
    }

    default:
      return null;
  }
}

// ───────────────────────── Typing Indicator ─────────────────────────

function startTypingLoop(botToken: string, channelId: string): { stop: () => void; ping: () => void } {
  void triggerTyping(botToken, channelId);
  // Discord typing indicator lasts 10s, refresh every 8s
  const timer = setInterval(() => {
    void triggerTyping(botToken, channelId);
  }, 8000);
  return {
    stop: () => clearInterval(timer),
    ping: () => {
      void triggerTyping(botToken, channelId);
    },
  };
}

async function triggerTyping(botToken: string, channelId: string): Promise<void> {
  try {
    await fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}` },
    });
  } catch {
    // Non-fatal
  }
}

// ───────────────────────── Send Message ─────────────────────────

export async function sendDiscordMessage(
  botToken: string,
  channelId: string,
  text: string,
): Promise<string | undefined> {
  const chunks = splitMessage(text, MAX_LENGTH);
  let lastMessageId: string | undefined;

  for (const chunk of chunks) {
    try {
      const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: chunk }),
      });
      if (resp.ok) {
        const data = await resp.json<{ id?: string }>().catch(() => null);
        if (data?.id) lastMessageId = data.id;
      } else {
        const err = await resp.text().catch(() => "");
        console.warn(`Discord sendMessage failed: ${resp.status} ${err}`);
        // Rate limit handling
        if (resp.status === 429) {
          const retryData = await resp.json<{ retry_after?: number }>().catch(() => null);
          if (retryData?.retry_after) await sleep(retryData.retry_after * 1000);
        }
      }
    } catch (err) {
      console.warn("Discord sendMessage error:", err);
    }
  }
  return lastMessageId;
}

// ───────────────────────── Edit Message ─────────────────────────

async function editDiscordMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  text: string,
): Promise<DiscordEditResult> {
  const content = text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH - 3) + "..." : text;
  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (resp.ok) return { ok: true };

    if (resp.status === 404) {
      return { ok: false, reason: "missing" };
    }

    if (resp.status === 429) {
      const data = await resp.json<{ retry_after?: number }>().catch(() => null);
      const retryAfter = data?.retry_after;
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterMs: typeof retryAfter === "number" ? Math.ceil(retryAfter * 1000) : undefined,
      };
    }

    const errText = await resp.text().catch(() => "");
    if (errText.includes("Must be 2000 or fewer")) {
      return { ok: false, reason: "too_long" };
    }

    return { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ───────────────────────── Interaction Response Helpers ─────────────────────────

/** Edit the original deferred interaction response (PATCH followup @original). */
async function editOriginalResponse(
  applicationId: string,
  interactionToken: string,
  text: string,
): Promise<void> {
  const chunks = splitMessage(text, MAX_LENGTH);

  // First chunk → edit the original deferred message
  await fetch(`${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: chunks[0] }),
  });

  // Remaining chunks → send as followup messages
  for (let i = 1; i < chunks.length; i++) {
    await fetch(`${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: chunks[i] }),
    });
  }
}

// ───────────────────────── Media Delivery ─────────────────────────

async function deliverMedia(
  ctx: DiscordContext,
  channelId: string,
  mediaDelivery: MediaDelivery[],
): Promise<void> {
  for (const media of mediaDelivery) {
    try {
      const obj = await ctx.r2Memories.get(media.r2Key);
      if (!obj) continue;
      const bytes = await obj.arrayBuffer();
      if (media.type === "image") {
        await sendDiscordFile(ctx.botToken, channelId, bytes, "image.jpg", "image/jpeg");
      } else if (media.type === "audio") {
        const mime = media.format === "ogg" ? "audio/ogg" : "audio/mpeg";
        await sendDiscordFile(ctx.botToken, channelId, bytes, `audio.${media.format}`, mime);
      }
    } catch (err) {
      console.warn(`Discord media delivery failed for ${media.r2Key}:`, err);
    }
  }
}

async function sendDiscordFile(
  botToken: string,
  channelId: string,
  fileBytes: ArrayBuffer,
  filename: string,
  mimeType: string,
): Promise<void> {
  const blob = new Blob([fileBytes], { type: mimeType });
  const form = new FormData();
  form.append("files[0]", blob, filename);

  await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}` },
    body: form,
  });
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

async function replaceDiscordPlaceholder(
  botToken: string,
  channelId: string,
  placeholderMsgId: string,
  text: string,
): Promise<string | undefined> {
  const chunks = splitMessage(text, MAX_LENGTH);
  if (chunks.length === 0) return undefined;

  const edited = await editDiscordMessage(botToken, channelId, placeholderMsgId, chunks[0]);
  let lastMessageId = edited.ok ? placeholderMsgId : undefined;
  const startIndex = edited.ok ? 1 : 0;

  for (let i = startIndex; i < chunks.length; i++) {
    const sentId = await sendDiscordMessage(botToken, channelId, chunks[i]);
    if (sentId) lastMessageId = sentId;
  }

  return lastMessageId;
}

function resolveDiscordRoutingOptions(ctx: DiscordContext): DiscordRoutingOptions {
  return {
    applicationId: ctx.applicationId,
    requireMention: parseBooleanFlag(ctx.env.DISCORD_REQUIRE_MENTION, true),
    freeResponseChannels: parseCsvSet(ctx.env.DISCORD_FREE_RESPONSE_CHANNELS),
  };
}

export function shouldProcessDiscordMessage(
  message: DiscordMessage,
  options: DiscordRoutingOptions,
): boolean {
  if (!message.guild_id) return true;
  if ((message.content ?? "").trim().startsWith("/")) return true;

  const freeChannels = new Set(options.freeResponseChannels ?? []);
  if (freeChannels.has(message.channel_id)) return true;
  if (isReplyToBot(message, options.applicationId)) return true;
  if (options.requireMention === false) return true;

  const content = message.content ?? "";
  if (mentionsDiscordBot(content, options.applicationId)) return true;
  if (containsAnyDiscordMention(content)) return false;
  return false;
}

export function stripDiscordBotMentions(text: string, applicationId: string): string {
  if (!text.trim()) return text;
  const pattern = new RegExp(`<@!?${escapeRegExp(applicationId)}>\\s*`, "g");
  const stripped = text.replace(pattern, "").trim();
  return stripped || text.trim();
}

function isReplyToBot(message: DiscordMessage, applicationId: string): boolean {
  return message.referenced_message?.author?.id === applicationId;
}

function mentionsDiscordBot(content: string, applicationId: string): boolean {
  return new RegExp(`<@!?${escapeRegExp(applicationId)}>`, "g").test(content);
}

function containsAnyDiscordMention(content: string): boolean {
  return /<@!?\d+>/.test(content);
}

function parseCsvSet(value?: string): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function guessMimeFromFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
    mp4: "video/mp4", webm: "video/webm",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv", md: "text/markdown",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[ext] ?? "application/octet-stream";
}

function mediaTypeFromMime(mime: string): MediaAsset["type"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "voice";
  return "document";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
