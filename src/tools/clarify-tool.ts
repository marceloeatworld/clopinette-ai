import { z } from "zod";

/**
 * Clarify tool — lets the agent ask the user structured questions.
 *
 * Instead of guessing when the request is ambiguous, the agent can ask
 * multiple-choice or open-ended questions. The response is returned to
 * the model as a tool result so it can continue with the answer.
 *
 * Like Hermes: supports up to 4 choices + "Other" auto-appended.
 * The actual question is rendered as the tool's text output —
 * the model includes it in the response to the user.
 */
export function createClarifyTool() {
  return {
    description:
      "Ask the user a clarifying question when their request is ambiguous.\n" +
      "USE when:\n" +
      "- The request could mean multiple things and guessing wrong wastes effort\n" +
      "- You need a preference or choice before proceeding\n" +
      "- Critical information is missing\n" +
      "DO NOT use for trivial questions — just make a reasonable choice and proceed.\n" +
      "The question text will be shown to the user as your response.",
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
      // Format the question for display
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
