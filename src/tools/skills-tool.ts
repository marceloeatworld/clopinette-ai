import { z } from "zod";
import type { ToolContext } from "./registry.js";
import {
  listSkills,
  searchSkills,
  getSkill,
  createSkill,
  editSkill,
  patchSkill,
  deleteSkill,
} from "../memory/skills.js";

export function createSkillsTool(ctx: ToolContext) {
  return {
    description:
      "Manage reusable skills (.md files). Skills store proven solutions to complex problems.\n" +
      "WHEN TO USE:\n" +
      "- BEFORE starting a complex task: search for an existing skill that matches\n" +
      "- AFTER solving a complex problem (5+ tool calls): create a skill to save the approach\n" +
      "- If a loaded skill had wrong steps or missing pitfalls: patch it immediately\n" +
      "Actions: list, search, view, create, edit, patch (find/replace), delete.\n" +
      "Always include: steps, pitfalls discovered, verification method.",
    inputSchema: z.object({
      action: z
        .enum(["list", "search", "view", "create", "edit", "patch", "delete"])
        .describe("Action to perform"),
      name: z.string().optional().describe("Skill name (required for view/create/edit/patch/delete)"),
      query: z.string().optional().describe("Search query (for search action)"),
      category: z.string().optional().describe("Category filter (for list) or category (for create/edit)"),
      content: z.string().optional().describe("Skill content (for create/edit)"),
      description: z.string().optional().describe("One-line description (for create/edit)"),
      triggerPattern: z.string().optional().describe("When to activate (for create/edit)"),
      platforms: z.string().optional().describe("Allowed platforms as CSV or [list] (for create/edit)"),
      find: z.string().optional().describe("Text to find (for patch)"),
      replace: z.string().optional().describe("Replacement text (for patch)"),
    }),
    execute: async (params: {
      action: string;
      name?: string;
      query?: string;
      category?: string;
      content?: string;
      description?: string;
      triggerPattern?: string;
      platforms?: string;
      find?: string;
      replace?: string;
    }) => {
      switch (params.action) {
        case "list":
          return { ok: true, skills: listSkills(ctx.sql, params.category, ctx.platform) };

        case "search":
          if (!params.query) return { ok: false, error: "query required" };
          return { ok: true, skills: searchSkills(ctx.sql, params.query, ctx.platform) };

        case "view":
          if (!params.name) return { ok: false, error: "name required" };
          const skill = await getSkill(ctx.sql, ctx.r2Skills, ctx.userId, params.name);
          if (!skill) return { ok: false, error: `Skill "${params.name}" not found` };
          return { ok: true, skill };

        case "create":
          if (!params.name || !params.content)
            return { ok: false, error: "name and content required" };
          return createSkill(ctx.sql, ctx.r2Skills, ctx.userId, params.name, params.content, {
            category: params.category,
            description: params.description,
            triggerPattern: params.triggerPattern,
            platforms: params.platforms,
          });

        case "edit":
          if (!params.name || !params.content)
            return { ok: false, error: "name and content required" };
          return editSkill(ctx.sql, ctx.r2Skills, ctx.userId, params.name, params.content, {
            category: params.category,
            description: params.description,
            triggerPattern: params.triggerPattern,
            platforms: params.platforms,
          });

        case "patch":
          if (!params.name || !params.find || params.replace === undefined)
            return { ok: false, error: "name, find, and replace required" };
          return patchSkill(ctx.sql, ctx.r2Skills, ctx.userId, params.name, params.find, params.replace);

        case "delete":
          if (!params.name) return { ok: false, error: "name required" };
          return deleteSkill(ctx.sql, ctx.r2Skills, ctx.userId, params.name);

        default:
          return { ok: false, error: `Unknown action: ${params.action}` };
      }
    },
  };
}
