import type { LanguageModel } from "ai";
import { createWebTool } from "./tools/web-tool.js";

export interface DelegateToolsetContext {
  cfAccountId: string;
  cfBrowserToken?: string;
  auxModel?: LanguageModel;
  searxngUrl?: string;
  braveApiKey?: string;
}

export function buildDelegateTools(ctx: DelegateToolsetContext) {
  return {
    web: createWebTool(
      ctx.cfAccountId,
      ctx.cfBrowserToken,
      ctx.auxModel,
      ctx.searxngUrl,
      ctx.braveApiKey,
    ),
  };
}

export function buildDelegateSystemPrompt(goal: string, context?: string): string {
  return [
    "You are a focused research sub-agent. You only have the web tool and a STRICT budget of 2 tool calls.",
    "",
    "Rules:",
    "- Start with exactly 1 web search.",
    "- If search snippets already answer the task, respond immediately.",
    "- Otherwise read exactly 1 high-value URL from the search results.",
    "- Never run a second search or browse interactively.",
    "- Prefer primary and official sources when available.",
    "- Never make up information. If the evidence is weak, missing, or conflicting, say so clearly.",
    "",
    "Return this structure exactly:",
    "## Answer",
    "A direct answer in 1-3 short paragraphs.",
    "",
    "## Key Findings",
    "- Finding - source URL",
    "- Finding - source URL",
    "",
    "## Gaps",
    "- Missing info, uncertainty, or contradictions",
    "",
    `YOUR TASK:\n${goal}`,
    context ? `\nCONTEXT:\n${context}` : "",
  ].join("\n");
}

export function buildResearchRewritePrompt(topic: string): string {
  return [
    "[RESEARCH MODE] You MUST use the delegate tool to launch 2 or 3 parallel sub-agents with complementary, non-overlapping angles on this topic.",
    "",
    "Design the delegate({ tasks: [...] }) batch before you call it:",
    "- One task should target primary or official sources.",
    "- One task should target recent developments, changelogs, or reporting.",
    "- If a third task is useful, make it an independent technical, community, or data angle that does NOT duplicate the first two.",
    "- Each delegated goal should explicitly name its angle and preferred source family.",
    "- For technical or product topics, the primary-source angle should prefer official docs, changelogs, release notes, repos, or issue trackers.",
    "",
    "Hard rules:",
    "- DO use delegate({ tasks: [...] }) with 2-3 distinct goals.",
    "- DO give each task enough context to stay narrow and self-contained.",
    "- DO NOT call web/docs directly first - go straight to delegate.",
    "- DO NOT create overlapping tasks that chase the same evidence from the same angle.",
    "- After delegating, send only a brief in-progress note to the user. The auto-resume will synthesize the final answer when all delegates complete.",
    "- Do NOT answer from memory.",
    "",
    `Topic: ${topic}`,
  ].join("\n");
}
