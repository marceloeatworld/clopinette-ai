import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_RESPONSE_FALLBACK,
  resolveGatewayResponseText,
} from "../src/gateway/response-text.js";

describe("gateway response text", () => {
  it("preserves normal model output", () => {
    expect(resolveGatewayResponseText("Bonjour.")).toBe("Bonjour.");
  });

  it("replaces empty and sentinel values with a user-facing fallback", () => {
    expect(resolveGatewayResponseText("")).toBe(DEFAULT_GATEWAY_RESPONSE_FALLBACK);
    expect(resolveGatewayResponseText("(no response)")).toBe(DEFAULT_GATEWAY_RESPONSE_FALLBACK);
    expect(resolveGatewayResponseText(undefined, "fallback")).toBe("fallback");
  });
});
