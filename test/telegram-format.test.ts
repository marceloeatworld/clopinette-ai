import { describe, expect, it } from "vitest";
import {
  formatTelegramMessage,
  splitTelegramMessage,
  stripTelegramMarkdown,
} from "../src/gateway/telegram-format.js";

describe("telegram formatting", () => {
  it("converts standard markdown into Telegram-safe MarkdownV2", () => {
    const formatted = formatTelegramMessage(
      "## Heading\n**Bold** and *italic*\n`npm run dev`\n[Docs](https://example.com/docs)",
    );

    expect(formatted).toContain("*Heading*");
    expect(formatted).toContain("*Bold*");
    expect(formatted).toContain("_italic_");
    expect(formatted).toContain("`npm run dev`");
    expect(formatted).toContain("[Docs](https://example.com/docs)");
  });

  it("strips Telegram markdown markers for plain-text fallback", () => {
    const plain = stripTelegramMarkdown("*Hello* _world_ ~test~ ||secret||");
    expect(plain).toBe("Hello world test secret");
  });

  it("splits long messages while preserving fenced code blocks", () => {
    const input = [
      "Intro",
      "```ts",
      "const x = 1;",
      "const y = 2;",
      "```",
      "Outro",
    ].join("\n");

    const chunks = splitTelegramMessage(input, 24);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("```");
    expect(chunks[0].endsWith("```")).toBe(true);
    expect(chunks[1].startsWith("```ts\n")).toBe(true);
  });
});
