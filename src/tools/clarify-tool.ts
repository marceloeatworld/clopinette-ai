import { z } from "zod";
import type { ElicitParams, ElicitResult } from "../pipeline.js";

/**
 * Clarify tool — lets the agent ask the user structured questions.
 *
 * Two modes:
 * - Interactive (web only): when the DO provides `elicitInput`, the question is
 *   pushed to the browser as a structured form and the tool BLOCKS until the
 *   user answers (or the 2-minute timeout fires). The model continues in the
 *   same turn with the real answer.
 * - Passive (Telegram / WhatsApp / other gateways): the formatted question is
 *   returned as the tool result; the model relays it and the user's answer
 *   arrives as the next message.
 *
 * Like Hermes: supports up to 4 choices + "Other" auto-appended.
 */
export function createClarifyTool(ctx?: {
  elicitInput?: (params: ElicitParams) => Promise<ElicitResult>;
  platform?: string;
}) {
  return {
    description:
      "Ask the user a clarifying question when their request is ambiguous.\n" +
      "USE when:\n" +
      "- The request could mean multiple things and guessing wrong wastes effort\n" +
      "- You need a preference or choice before proceeding\n" +
      "- Critical information is missing\n" +
      "DO NOT use for trivial questions — just make a reasonable choice and proceed.\n" +
      "On the web the user answers a form and you get the answer immediately; " +
      "elsewhere the question text is shown to the user as your response.",
    inputSchema: z.object({
      question: z.string().describe("The question to ask the user"),
      choices: z
        .array(z.string())
        .max(4)
        .optional()
        .describe("Up to 4 choices for multiple-choice (omit for open-ended)"),
    }),
    execute: async ({
      question,
      choices,
    }: {
      question: string;
      choices?: string[];
    }) => {
      // Interactive path — real mid-turn round-trip over the WebSocket
      if (ctx?.elicitInput && ctx.platform === "websocket") {
        const answerProp = choices && choices.length > 0
          ? { type: "string" as const, title: question, enum: [...choices, "Other"] }
          : { type: "string" as const, title: question };
        const res = await ctx.elicitInput({
          message: question,
          schema: { type: "object", properties: { answer: answerProp }, required: ["answer"] },
        });
        if (res.action === "accept" && res.content?.answer !== undefined && String(res.content.answer).trim() !== "") {
          return {
            ok: true,
            answer: String(res.content.answer),
            note: "The user answered your question. Continue using this answer.",
          };
        }
        return {
          ok: false,
          error: "The user did not answer (declined or timed out). Proceed with your best judgment, or end your turn restating the question.",
        };
      }

      // Passive path — format the question for display
      let formatted = question;
      if (choices && choices.length > 0) {
        const numbered = choices.map((c, i) => `${i + 1}. ${c}`);
        numbered.push(`${choices.length + 1}. Other`);
        formatted = `${question}\n\n${numbered.join("\n")}`;
      }

      // The tool result tells the model to wait for user input
      return {
        ok: true,
        question: formatted,
        awaiting_response: true,
        note: "Display this question to the user and wait for their response before continuing.",
      };
    },
  };
}
