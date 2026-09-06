import { describe, expect, it, vi } from "vitest";
import { DiscordProgressController } from "../src/gateway/discord-progress.js";

describe("discord progress controller", () => {
  it("renders stacked tool progress and deduplicates repeated events", async () => {
    const edits: string[] = [];
    const controller = new DiscordProgressController({
      editMessage: async (text) => {
        edits.push(text);
        return { ok: true };
      },
      frames: ["a", "b"],
    });

    expect(controller.snapshot()).toBe("⏳ a");

    controller.pushToolProgress("web", "cloudflare docs");
    controller.pushToolProgress("web", "cloudflare docs");
    await controller.flushNow();

    expect(controller.snapshot()).toContain('🔍 web: "cloudflare docs" (x2)');
    expect(edits[0]).toContain('🔍 web: "cloudflare docs" (x2)');
  });

  it("stops editing after a long discord rate limit", async () => {
    const editMessage = vi.fn(async () => ({
      ok: false as const,
      reason: "rate_limited" as const,
      retryAfterMs: 6000,
    }));
    const controller = new DiscordProgressController({ editMessage });

    controller.pushToolProgress("docs", "browser run");
    await controller.flushNow();

    expect(controller.editable).toBe(false);
    expect(editMessage).toHaveBeenCalledOnce();
  });
});
