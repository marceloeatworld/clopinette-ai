import { describe, expect, it } from "vitest";
import { buildToolSummaryContext } from "../src/tool-summary.js";

describe("tool summary context", () => {
  it("extracts tool outputs into a compact summary block", () => {
    const steps = [
      {
        toolResults: [
          { toolName: "web", output: "France SP95 average: 1.82 EUR/L" },
          { toolName: "search", output: { source: "INSEE", trend: "down slightly" } },
        ],
      },
    ];

    expect(buildToolSummaryContext(steps)).toBe(
      '[web] France SP95 average: 1.82 EUR/L\n\n[search] {"source":"INSEE","trend":"down slightly"}',
    );
  });

  it("skips empty outputs and truncates oversized ones", () => {
    const longText = "a".repeat(20);
    const steps = [{ toolResults: [{ toolName: "web", output: "" }, { toolName: "docs", output: longText }] }];

    expect(buildToolSummaryContext(steps, 10)).toBe("[docs] aaaaaaaaaa...");
  });
});
