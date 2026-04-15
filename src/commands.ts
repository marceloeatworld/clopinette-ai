import type { SqlFn } from "./config/sql.js";
import { searchSessions } from "./memory/session-search.js";
import { PERSONALITIES, PERSONALITY_NAMES } from "./config/personalities.js";
import { DEFAULT_SOUL_MD, DEFAULT_MODEL, WORKERS_AI_MODELS, isWorkersAiModel } from "./config/constants.js";
import { buildResearchRewritePrompt } from "./delegation.js";
import { readMonthlyUsage } from "./enterprise/budget.js";

/**
 * Shared slash commands — work on ALL gateways (Telegram, WebSocket, Discord, Slack, API).
 *
 * Returns plain text (no MarkdownV2 escaping — each gateway formats for its platform).
 * Returns null if the text is not a slash command.
 */

export interface CommandContext {
  sql: SqlFn;
  sessionId: string;
  userId: string;
  env: Env;
  r2Memories?: R2Bucket;
  r2Skills?: R2Bucket;
  /** Called when a command changes config that affects the system prompt (e.g. /personality, /reset). */
  onCacheInvalidate?: () => void;
}

export interface CommandResult {
  text: string;
  /** If true, don't pass this message to the pipeline */
  handled: true;
}

/**
 * Rewrite variant — the command is recognized but instead of returning text,
 * it asks the caller to run the pipeline with a rewritten userText. Used by
 * /research and similar "mode-switch" commands that craft a structured prompt
 * for the LLM while keeping the rest of the pipeline (tools, memory, BYOK) intact.
 */
export interface CommandRewrite {
  handled: false;
  rewriteAs: string;
}

export type CommandReturn = CommandResult | CommandRewrite | null;

export async function handleCommand(
  text: string,
  ctx: CommandContext
): Promise<CommandReturn> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.*$/, ""); // strip @botname
  const arg = trimmed.slice(parts[0].length).trim();

  switch (cmd) {
    case "/clear":
    case "/reset":
      ctx.sql`DELETE FROM session_messages WHERE session_id = ${ctx.sessionId}`;
      ctx.sql`DELETE FROM cf_ai_chat_agent_messages`;
      ctx.sql`DELETE FROM agent_config WHERE key = 'personality'`;
      ctx.onCacheInvalidate?.();
      return { text: "Session reset. All pending research purged.", handled: true };

    case "/memory": {
      const memRows = ctx.sql<{ content: string }>`
        SELECT content FROM prompt_memory WHERE type = 'memory'
      `;
      const userRows = ctx.sql<{ content: string }>`
        SELECT content FROM prompt_memory WHERE type = 'user'
      `;
      const mem = memRows[0]?.content || "(empty)";
      const usr = userRows[0]?.content || "(empty)";
      return { text: `**MEMORY.md**\n\`\`\`\n${mem}\n\`\`\`\n\n**USER.md**\n\`\`\`\n${usr}\n\`\`\``, handled: true };
    }

    case "/status": {
      const configRows = ctx.sql<{ key: string; value: string }>`
        SELECT key, value FROM agent_config WHERE key IN ('model', 'provider', 'display_name') OR key LIKE 'model:%'
      `;
      const configMap = new Map(configRows.map(r => [r.key, r.value]));
      const provider = configMap.get("provider");
      // Prefer model:{provider}, fall back to legacy model, then default
      const model = (provider && configMap.get(`model:${provider}`))
        || configMap.get("model")
        || DEFAULT_MODEL;
      const name = configMap.get("display_name") || "not set";

      const tokens = readMonthlyUsage(ctx.sql);

      const skillRows = ctx.sql<{ count: number }>`SELECT COUNT(*) as count FROM skills`;
      const sessionRows = ctx.sql<{ count: number }>`SELECT COUNT(*) as count FROM sessions`;

      // Session age
      const currentSession = ctx.sql<{ started_at: string; updated_at: string | null; total_tokens: number }>`
        SELECT started_at, updated_at, total_tokens FROM sessions WHERE id = ${ctx.sessionId}
      `;
      const sessionAge = currentSession[0]
        ? Math.round((Date.now() - new Date(currentSession[0].started_at + "Z").getTime()) / 60_000)
        : 0;
      const resetCfg = ctx.sql<{ key: string; value: string }>`
        SELECT key, value FROM agent_config WHERE key IN ('_session_reset_mode', '_session_idle_minutes')
      `;
      const rcMap = new Map(resetCfg.map(r => [r.key, r.value]));
      const idleMin = rcMap.get("_session_idle_minutes") ?? "120";

      return {
        text: [
          "**Agent Status**",
          `Name: ${name}`,
          `Model: \`${model}\``,
          `Tokens this month: ${tokens.toLocaleString()}`,
          `Sessions: ${sessionRows[0]?.count ?? 0}`,
          `Skills: ${skillRows[0]?.count ?? 0}`,
          `Session age: ${sessionAge} min (auto-reset after ${idleMin} min idle)`,
        ].join("\n"),
        handled: true,
      };
    }

    case "/insights": {
      // Per-model cost breakdown for the current calendar month.
      // Assumes a 30/70 input/output split — a typical long-reply chat pattern.
      // Users get a `Prices updated: ...` footer so stale estimates are obvious.
      const { estimateCost, isKnownModel, PRICING_UPDATED_AT } = await import("./inference/pricing.js");

      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      const perModel = ctx.sql<{ model: string | null; tokens: number; sessions: number }>`
        SELECT model, COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS sessions
        FROM sessions
        WHERE started_at >= ${monthStart}
        GROUP BY model
        HAVING tokens > 0
        ORDER BY tokens DESC
      `;

      if (perModel.length === 0) {
        return { text: "No recorded usage this month yet. Have a chat first.", handled: true };
      }

      const INPUT_RATIO = 0.3;
      const OUTPUT_RATIO = 0.7;
      let totalCost = 0;
      let totalTokens = 0;
      let hasUnknown = false;

      const lines: string[] = [
        "**Month usage by model**",
        "",
        "| Model | Sessions | Tokens | Est. cost |",
        "| --- | ---:| ---:| ---:|",
      ];

      for (const row of perModel) {
        const model = row.model ?? "(unknown)";
        const inputTokens = Math.round(row.tokens * INPUT_RATIO);
        const outputTokens = Math.round(row.tokens * OUTPUT_RATIO);
        const cost = estimateCost(model, inputTokens, outputTokens);
        totalCost += cost;
        totalTokens += row.tokens;
        const flag = isKnownModel(model) ? "" : " ⚠︎";
        const label = model.length > 42 ? model.slice(0, 39) + "..." : model;
        if (!isKnownModel(model)) hasUnknown = true;
        lines.push(`| \`${label}\`${flag} | ${row.sessions} | ${(row.tokens / 1000).toFixed(1)}k | $${cost.toFixed(3)} |`);
      }

      lines.push("");
      lines.push(`**Total:** ${(totalTokens / 1000).toFixed(1)}k tokens — **$${totalCost.toFixed(2)}** (estimated)`);
      lines.push("");
      lines.push(`_Assumes 30/70 input/output split. Prices updated: ${PRICING_UPDATED_AT}._`);
      if (hasUnknown) {
        lines.push(`_⚠︎ = model not in pricing table, default rate applied._`);
      }

      return { text: lines.join("\n"), handled: true };
    }

    case "/forget":
      ctx.sql`UPDATE prompt_memory SET content = '', updated_at = datetime('now')`;
      return { text: "Memory cleared. MEMORY.md and USER.md are now empty.", handled: true };

    case "/wipe": {
      // Require confirmation: /wipe CONFIRM
      if (arg !== "CONFIRM") {
        return {
          text: "**This will permanently delete:**\n" +
            "- Memory (MEMORY.md + USER.md)\n" +
            "- All conversation sessions and history\n" +
            "- All skills, todos, notes, calendar events\n" +
            "- All uploaded documents and generated media (R2)\n" +
            "- Document context + pending delegated research\n\n" +
            "**Preserved (so you don't have to re-setup):**\n" +
            "- Your BYOK provider + API key + model selection\n" +
            "- Your auxiliary provider config\n\n" +
            "This action **cannot be undone**.\n\n" +
            "To confirm, type: `/wipe CONFIRM`",
          handled: true,
        };
      }
      // SQLite wipe — app tables
      ctx.sql`UPDATE prompt_memory SET content = '', updated_at = datetime('now')`;
      ctx.sql`DELETE FROM session_messages`;
      ctx.sql`DELETE FROM sessions`;
      ctx.sql`DELETE FROM skills`;
      ctx.sql`DELETE FROM todos`;
      ctx.sql`DELETE FROM notes`;
      ctx.sql`DELETE FROM calendar_events`;
      ctx.sql`DELETE FROM doc_context`;
      ctx.sql`DELETE FROM hub_installed`;
      ctx.sql`DELETE FROM pending_delegates`;
      ctx.sql`DELETE FROM agent_config WHERE key = '_turn_count'`;
      // Clear personality preset and reset soul to default
      ctx.sql`DELETE FROM agent_config WHERE key = 'personality'`;
      ctx.sql`INSERT OR REPLACE INTO agent_config (key, value, encrypted, updated_at)
        VALUES ('soul_md', ${DEFAULT_SOUL_MD}, 0, datetime('now'))`;
      // Wipe Agents SDK message persistence (this.messages)
      ctx.sql`DELETE FROM cf_ai_chat_agent_messages`;
      ctx.onCacheInvalidate?.();

      // R2 wipe (docs, audio, images, skills, spillovers).
      // Pagination: r2.list returns max 1000 keys per call. Loop until !truncated
      // so users with thousands of files don't end up with stragglers.
      const safeId = ctx.userId.replace(/[^a-zA-Z0-9_-]/g, "");
      const purgeR2 = async (bucket: R2Bucket): Promise<void> => {
        let cursor: string | undefined;
        do {
          const listed = await bucket.list({ prefix: `${safeId}/`, cursor, limit: 1000 });
          if (listed.objects.length > 0) {
            await bucket.delete(listed.objects.map((o) => o.key));
          }
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
      };
      if (ctx.r2Memories) await purgeR2(ctx.r2Memories);
      if (ctx.r2Skills) await purgeR2(ctx.r2Skills);

      return {
        text: "Full wipe complete. Memory, sessions, skills, todos, files, and pending research deleted. Your BYOK provider config was preserved.",
        handled: true,
      };
    }

    case "/skills": {
      const rows = ctx.sql<{ name: string; description: string | null }>`
        SELECT name, description FROM skills ORDER BY name
      `;
      if (rows.length === 0) return { text: "No skills installed.", handled: true };
      const list = rows.map(r => `- \`${r.name}\`${r.description ? ` — ${r.description}` : ""}`);
      return { text: `**Skills (${rows.length})**\n${list.join("\n")}`, handled: true };
    }

    case "/search": {
      if (!arg) return { text: "Usage: `/search your query here`", handled: true };
      const results = searchSessions(ctx.sql, arg, 5);
      if (results.length === 0) return { text: `No results for "${arg}"`, handled: true };
      const lines = results.map(r => `[${r.role}] ${r.content.slice(0, 100)}`);
      return { text: `**Search: "${arg}"**\n\n${lines.join("\n\n")}`, handled: true };
    }

    case "/soul": {
      if (arg.toLowerCase() === "reset") {
        const { DEFAULT_SOUL_MD } = await import("./config/constants.js");
        ctx.sql`UPDATE agent_config SET value = ${DEFAULT_SOUL_MD}, updated_at = datetime('now') WHERE key = 'soul_md'`;
        ctx.onCacheInvalidate?.();
        return { text: "SOUL.md reset to default.", handled: true };
      }
      const rows = ctx.sql<{ value: string }>`
        SELECT value FROM agent_config WHERE key = 'soul_md'
      `;
      const content = rows[0]?.value || "(no personality set)";
      return { text: `**SOUL.md**\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``, handled: true };
    }

    case "/session": {
      if (!arg) {
        const sRows = ctx.sql<{ started_at: string; updated_at: string | null; total_tokens: number }>`
          SELECT started_at, updated_at, total_tokens FROM sessions WHERE id = ${ctx.sessionId}
        `;
        const s = sRows[0];
        const age = s ? Math.round((Date.now() - new Date(s.started_at + "Z").getTime()) / 60_000) : 0;
        const cfgRows = ctx.sql<{ key: string; value: string }>`
          SELECT key, value FROM agent_config
          WHERE key IN ('_session_reset_mode', '_session_idle_minutes', '_session_reset_hour')
        `;
        const c = new Map(cfgRows.map(r => [r.key, r.value]));
        return {
          text: [
            "**Session Info**",
            `Age: ${age} min | Tokens: ${s?.total_tokens ?? 0}`,
            `Reset mode: \`${c.get("_session_reset_mode") ?? "both"}\``,
            `Idle timeout: ${c.get("_session_idle_minutes") ?? "120"} min`,
            `Daily reset: ${c.get("_session_reset_hour") ?? "4"}h UTC`,
            "",
            "**Config:** `/session idle <min>` | `/session daily <hour>` | `/session mode <both|idle|daily|none>`",
          ].join("\n"),
          handled: true,
        };
      }
      const [subcmd, val] = arg.split(/\s+/);
      if (subcmd === "idle" && val) {
        const mins = parseInt(val, 10);
        if (isNaN(mins) || mins < 1) return { text: "Invalid minutes.", handled: true };
        ctx.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('_session_idle_minutes', ${String(mins)})`;
        return { text: `Idle timeout set to **${mins} min**.`, handled: true };
      }
      if (subcmd === "daily" && val) {
        const hour = parseInt(val, 10);
        if (isNaN(hour) || hour < 0 || hour > 23) return { text: "Invalid hour (0-23).", handled: true };
        ctx.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('_session_reset_hour', ${String(hour)})`;
        return { text: `Daily reset set to **${hour}h UTC**.`, handled: true };
      }
      if (subcmd === "mode" && val) {
        if (!["both", "idle", "daily", "none"].includes(val)) return { text: "Invalid mode. Use: both, idle, daily, none.", handled: true };
        ctx.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('_session_reset_mode', ${val})`;
        return { text: `Session reset mode set to **${val}**.`, handled: true };
      }
      return { text: "Usage: `/session idle <min>` | `/session daily <hour>` | `/session mode <mode>`", handled: true };
    }

    case "/model": {
      // Plan matrix (mirrors the gateway's validateConfigField):
      //   trial → Workers AI only (Kimi K2.5, Gemma 4)
      //   pro   → Workers AI + any BYOK provider the user has a key for
      //   byok  → BYOK only (no Workers AI)
      const plan = (await ctx.env.LINKS.get(`plan:${ctx.userId}`)) ?? "trial";
      const allowsWorkersAi = plan !== "byok";
      const allowsBYOK = plan !== "trial";

      // Read current provider + per-provider models + configured API keys in one pass
      const rows = ctx.sql<{ key: string; value: string; encrypted: number }>`
        SELECT key, value, encrypted FROM agent_config
        WHERE key = 'provider'
           OR key LIKE 'model:%'
           OR key LIKE 'api_key:%'
      `;
      const map = new Map(rows.map((r) => [r.key, r]));
      const currentProvider = map.get("provider")?.value ?? (allowsWorkersAi ? "workers-ai" : "");
      const currentModel = currentProvider
        ? (map.get(`model:${currentProvider}`)?.value ?? (allowsWorkersAi ? DEFAULT_MODEL : "(no model)"))
        : "(none)";

      // ── List mode (no args) ────────────────────────────────────────────
      if (!arg) {
        const sections: string[] = [];

        // Workers AI tier (Pro / Trial only)
        if (allowsWorkersAi) {
          const waLines = WORKERS_AI_MODELS.map((m) => {
            const active = currentProvider === "workers-ai" && currentModel === m;
            return `- \`${m}\`${active ? " **[active]**" : ""}`;
          });
          sections.push(`**Workers AI** _(included with your plan)_\n${waLines.join("\n")}`);
        }

        // BYOK tier (Pro / BYOK only)
        if (allowsBYOK) {
          const byokLines: string[] = [];
          for (const row of rows) {
            if (!row.key.startsWith("model:")) continue;
            const provider = row.key.slice(6);
            if (provider === "workers-ai") continue;
            const hasKey = map.has(`api_key:${provider}`);
            if (!hasKey) continue; // BYOK without a key is not usable — don't advertise it
            const active = provider === currentProvider;
            byokLines.push(`- \`${provider}\` → \`${row.value}\`${active ? " **[active]**" : ""}`);
          }
          if (byokLines.length > 0) {
            sections.push(`**Your BYOK providers**\n${byokLines.join("\n")}`);
          } else {
            sections.push(
              `**Your BYOK providers**\n_(none configured — add an API key in Settings → Provider)_`,
            );
          }
        }

        const planLabel = plan === "byok" ? "BYOK" : plan === "pro" ? "Pro" : "Trial";

        return {
          text: [
            `**Current:** \`${currentProvider || "(none)"}\` / \`${currentModel}\`  _(plan: ${planLabel})_`,
            "",
            ...sections,
            "",
            "**Switch with:** `/model <provider> <model-id>`",
            allowsWorkersAi ? "Example: `/model workers-ai @cf/google/gemma-4-26b-a4b-it`" : "",
            allowsBYOK ? "Example: `/model anthropic claude-sonnet-4-5`" : "",
          ].filter(Boolean).join("\n"),
          handled: true,
        };
      }

      // ── Switch mode (provider + model-id) ──────────────────────────────
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        return {
          text: "Usage: `/model <provider> <model-id>` — run `/model` alone to see what's available on your plan.",
          handled: true,
        };
      }
      const provider = parts[0].toLowerCase();
      const modelId = parts.slice(1).join(" ");
      if (!/^[a-z0-9_-]+$/.test(provider)) {
        return { text: `Invalid provider slug: \`${provider}\`.`, handled: true };
      }

      // Plan enforcement — identical rules to the gateway's validateConfigField
      if (provider === "workers-ai") {
        if (!allowsWorkersAi) {
          return {
            text: "Workers AI models are not available on the BYOK plan. Use one of your configured BYOK providers instead.",
            handled: true,
          };
        }
        if (!isWorkersAiModel(modelId)) {
          return {
            text: `\`${modelId}\` is not a managed Workers AI model. Available: ${WORKERS_AI_MODELS.map((m) => `\`${m}\``).join(", ")}.`,
            handled: true,
          };
        }
      } else {
        if (!allowsBYOK) {
          return {
            text: "BYOK providers require the Pro plan. Upgrade at clopinette.app/pricing.",
            handled: true,
          };
        }
        if (!map.has(`api_key:${provider}`)) {
          return {
            text: `No API key configured for \`${provider}\`. Add it in Settings → Provider first.`,
            handled: true,
          };
        }
      }

      ctx.sql`INSERT OR REPLACE INTO agent_config (key, value, encrypted, updated_at)
        VALUES ('provider', ${provider}, 0, datetime('now'))`;
      ctx.sql`INSERT OR REPLACE INTO agent_config (key, value, encrypted, updated_at)
        VALUES (${`model:${provider}`}, ${modelId}, 0, datetime('now'))`;
      ctx.onCacheInvalidate?.();

      return {
        text: `Switched to \`${provider}\` / \`${modelId}\`. Next message will use the new model.`,
        handled: true,
      };
    }

    case "/personality": {
      if (!arg) {
        // List available personalities
        const currentRows = ctx.sql<{ value: string }>`
          SELECT value FROM agent_config WHERE key = 'personality'
        `;
        const current = currentRows[0]?.value || "(none)";
        const list = PERSONALITY_NAMES.map((name) => {
          const preview = PERSONALITIES[name].slice(0, 60);
          const marker = name === current ? " **[active]**" : "";
          return `- \`${name}\`${marker} — ${preview}...`;
        });
        return {
          text: `**Personalities** (current: \`${current}\`)\n\n${list.join("\n")}\n\nUsage: \`/personality <name>\` or \`/personality none\` to clear`,
          handled: true,
        };
      }
      const name = arg.toLowerCase().trim();
      if (name === "none" || name === "default" || name === "neutral") {
        ctx.sql`DELETE FROM agent_config WHERE key = 'personality'`;
        ctx.onCacheInvalidate?.();
        return { text: "Personality cleared. Using default style.", handled: true };
      }
      if (!(name in PERSONALITIES)) {
        return { text: `Unknown personality: \`${name}\`. Use \`/personality\` to see the list.`, handled: true };
      }
      ctx.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('personality', ${name})`;
      ctx.onCacheInvalidate?.();
      return { text: `Personality set to **${name}**. ${PERSONALITIES[name].slice(0, 80)}...`, handled: true };
    }

    case "/note": {
      if (!arg) {
        const rows = ctx.sql<{ id: number; content: string; created_at: string }>`
          SELECT id, content, created_at FROM notes ORDER BY created_at DESC LIMIT 5
        `;
        if (rows.length === 0) return { text: "No notes yet. Use `/note your text here` to save one.", handled: true };
        const list = rows.map(r => `- ${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""} _(${r.created_at.slice(0, 10)})_`);
        return { text: `**Recent notes (${rows.length})**\n${list.join("\n")}`, handled: true };
      }
      const enriched = await enrichNoteContent(arg);
      ctx.sql`INSERT INTO notes (content, source) VALUES (${enriched}, 'command')`;
      return { text: `Note saved.`, handled: true };
    }

    case "/notes": {
      const rows = ctx.sql<{ id: number; content: string; source: string; created_at: string }>`
        SELECT id, content, source, created_at FROM notes ORDER BY created_at DESC LIMIT 20
      `;
      if (rows.length === 0) return { text: "No notes yet.", handled: true };
      const grouped: Record<string, typeof rows> = {};
      for (const r of rows) {
        const day = r.created_at.slice(0, 10);
        (grouped[day] ??= []).push(r);
      }
      const lines: string[] = [];
      for (const [day, notes] of Object.entries(grouped)) {
        lines.push(`\n**${day}**`);
        for (const n of notes) {
          lines.push(`- ${n.content.slice(0, 150)}${n.content.length > 150 ? "..." : ""}`);
        }
      }
      return { text: `**Notes**${lines.join("\n")}`, handled: true };
    }

    case "/research":
    case "/deepsearch": {
      if (!arg) {
        return {
          text: "Usage: `/research <topic>` — launches 2-3 parallel sub-agents to research the topic from different angles, then synthesizes the findings.",
          handled: true,
        };
      }
      return { handled: false, rewriteAs: buildResearchRewritePrompt(arg) };
    }

    case "/help":
      return {
        text: [
          "**Available commands:**",
          "/status — Model, tokens, agent info",
          "/model — Show or switch the active model (`/model <provider> <id>`)",
          "/insights — Cost breakdown by model this month",
          "/research <topic> — Deep research with parallel sub-agents",
          "/memory — Show persistent memory",
          "/soul — Show personality file",
          "/session — Session info and auto-reset config",
          "/personality — Switch personality preset",
          "/skills — List installed skills",
          "/search <query> — Search past conversations",
          "/note <text> — Save a note (no text = show recent)",
          "/notes — List all notes grouped by day",
          "/forget — Clear memory (MEMORY.md + USER.md)",
          "/reset — Reset current session",
          "/wipe — Nuclear wipe (memory + sessions + skills + todos)",
          "/help — This help",
        ].join("\n"),
        handled: true,
      };

    default:
      return null; // not a recognized command, pass to pipeline
  }
}

const URL_RE = /^https?:\/\/\S+$/i;
const BLOCKED_HOSTS = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|100\.100\.|fd[0-9a-f]{2}:|fc[0-9a-f]{2}:|::1|metadata\.google)/i;

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

async function enrichNoteContent(content: string): Promise<string> {
  if (!URL_RE.test(content)) return content;
  try {
    const url = new URL(content);
    if (BLOCKED_HOSTS.test(url.hostname) || !["http:", "https:"].includes(url.protocol)) return content;

    const resp = await fetch(content, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Clopinette/1.0; +https://clopinette.app)",
        "Accept": "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return content;

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
