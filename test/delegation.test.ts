import { describe, expect, it } from "vitest";
import {
  buildDelegateSystemPrompt,
  buildDelegateTools,
  buildResearchRewritePrompt,
} from "../src/delegation.js";

describe("delegation helpers", () => {
  it("builds a strict web-only delegate prompt with structured output", () => {
    const prompt = buildDelegateSystemPrompt(
      "Find the latest Browser Run changelog details",
      "Focus on features relevant to operators.",
    );

    expect(prompt).toContain("only have the web tool");
    expect(prompt).toContain("STRICT budget of 2 tool calls");
    expect(prompt).toContain("## Answer");
    expect(prompt).toContain("## Key Findings");
    expect(prompt).toContain("## Gaps");
    expect(prompt).toContain("YOUR TASK:");
    expect(prompt).toContain("CONTEXT:");
  });

  it("builds a web-only delegate toolset", () => {
    const tools = buildDelegateTools({
      cfAccountId: "acct12345678",
      cfBrowserToken: "token",
    });

    expect(Object.keys(tools)).toEqual(["web"]);
  });

  it("builds a research rewrite with complementary angles", () => {
    const rewrite = buildResearchRewritePrompt("Cloudflare Browser Run");

    expect(rewrite).toContain("primary or official sources");
    expect(rewrite).toContain("recent developments, changelogs, or reporting");
    expect(rewrite).toContain("independent technical, community, or data angle");
    expect(rewrite).toContain("delegate({ tasks: [...] })");
  });
});
