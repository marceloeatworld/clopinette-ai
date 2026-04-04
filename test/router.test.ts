import { describe, it, expect } from "vitest";
import { routeModel } from "../src/inference/router.js";

describe("smart model routing", () => {
  const PRIMARY = "@cf/moonshotai/kimi-k2.5";
  const AUXILIARY = "@cf/google/gemma-4-26b-a4b-it";

  it("routes simple greetings to auxiliary", () => {
    const result = routeModel("hello", PRIMARY, AUXILIARY, 0);
    expect(result.model).toBe(AUXILIARY);
    expect(result.reason).toBe("simple");
  });

  it("routes 'bonjour' to auxiliary", () => {
    const result = routeModel("bonjour", PRIMARY, AUXILIARY, 0);
    expect(result.model).toBe(AUXILIARY);
    expect(result.reason).toBe("simple");
  });

  it("routes complex messages to primary", () => {
    const result = routeModel(
      "Can you analyze this code and suggest improvements for the authentication flow?",
      PRIMARY, AUXILIARY,
      0
    );
    expect(result.model).toBe(PRIMARY);
    expect(result.reason).toBe("complex");
  });

  it("routes to primary when tools were used", () => {
    const result = routeModel("ok", PRIMARY, AUXILIARY, 3);
    expect(result.model).toBe(PRIMARY);
    expect(result.reason).toBe("complex");
  });

  it("respects forced model override", () => {
    const forced = "gpt-4o";
    const result = routeModel("hello", PRIMARY, AUXILIARY, 0, forced);
    expect(result.model).toBe(forced);
    expect(result.reason).toBe("forced");
  });

  it("routes long messages to primary even if simple pattern", () => {
    const longMsg = "hello " + "x".repeat(200);
    const result = routeModel(longMsg, PRIMARY, AUXILIARY, 0);
    expect(result.model).toBe(PRIMARY);
    expect(result.reason).toBe("complex");
  });

  it("uses caller-provided auxiliary model (BYOK case)", () => {
    const byokAuxiliary = "gpt-4o-mini";
    const result = routeModel("salut", PRIMARY, byokAuxiliary, 0);
    expect(result.model).toBe(byokAuxiliary);
    expect(result.reason).toBe("simple");
  });
});
