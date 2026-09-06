import { describe, it, expect } from "vitest";
import {
  buildConversationSummary,
  REVIEW_INTERVAL,
  MIN_TURNS_BEFORE_REVIEW,
} from "../src/memory/self-learning.js";

describe("self-learning", () => {
  describe("buildConversationSummary", () => {
    it("builds summary from messages", () => {
      const messages = [
        { role: "user", parts: [{ type: "text", text: "Hello!" }] },
        { role: "assistant", parts: [{ type: "text", text: "Hi there." }] },
        { role: "user", parts: [{ type: "text", text: "Help with TS?" }] },
      ];
      const summary = buildConversationSummary(messages);
      expect(summary).toContain("[user]: Hello!");
      expect(summary).toContain("[assistant]: Hi there.");
      expect(summary).toContain("[user]: Help with TS?");
    });

    it("skips messages without text parts", () => {
      const messages = [
        { role: "user", parts: [{ type: "image" }] },
        { role: "assistant", parts: [{ type: "text", text: "I see." }] },
      ];
      const summary = buildConversationSummary(messages);
      expect(summary).not.toContain("[user]");
      expect(summary).toContain("[assistant]: I see.");
    });

    it("truncates long messages to 500 chars", () => {
      const messages = [
        { role: "user", parts: [{ type: "text", text: "x".repeat(1000) }] },
      ];
      const summary = buildConversationSummary(messages);
      // [user]: + 500 chars max
      expect(summary.length).toBeLessThan(520);
    });

    it("limits to last 20 messages", () => {
      const messages = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `Message ${i}` }],
      }));
      const summary = buildConversationSummary(messages);
      expect(summary).not.toContain("Message 0");
      expect(summary).not.toContain("Message 9");
      expect(summary).toContain("Message 10");
      expect(summary).toContain("Message 29");
    });

    it("handles empty parts array", () => {
      const messages = [{ role: "user", parts: [] }];
      const summary = buildConversationSummary(messages);
      expect(summary).toBe("");
    });

    it("handles undefined parts", () => {
      const messages = [{ role: "user" }];
      const summary = buildConversationSummary(messages);
      expect(summary).toBe("");
    });

    it("concatenates multiple text parts", () => {
      const messages = [
        {
          role: "user",
          parts: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      ];
      const summary = buildConversationSummary(messages);
      expect(summary).toContain("Part 1");
      expect(summary).toContain("Part 2");
    });
  });

  describe("constants", () => {
    it("review interval is 10 turns", () => {
      expect(REVIEW_INTERVAL).toBe(10);
    });

    it("minimum turns before first review is 6", () => {
      expect(MIN_TURNS_BEFORE_REVIEW).toBe(6);
    });
  });
});
