import { describe, expect, it, vi } from "vitest";
import { TelegramProgressController } from "../src/gateway/telegram-progress.js";

describe("telegram progress controller", () => {
  it("renders a stacked progress message and deduplicates repeated tool events", async () => {
    const edits: string[] = [];
    const controller = new TelegramProgressController({
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

  it("stops editing when Telegram flood control would stall the placeholder", async () => {
    const editMessage = vi.fn(async () => ({
      ok: false as const,
      reason: "flood_control" as const,
      retryAfterMs: 6000,
    }));
    const controller = new TelegramProgressController({ editMessage });

    controller.pushToolProgress("docs", "workers ai");
    await controller.flushNow();

    expect(controller.editable).toBe(false);
    expect(editMessage).toHaveBeenCalledOnce();
  });
});
