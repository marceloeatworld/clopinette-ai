import { describe, it, expect } from "vitest";
import { buildCredentialFetcher } from "../src/tools/credential-fetcher.js";

// Narrow shape of the outbound service binding — matches what DynamicWorkerExecutor
// passes through as `globalOutbound`. Keeping it local avoids depending on the
// full workers-types Fetcher (which requires a `connect` implementation).
type OutboundLike = Parameters<typeof buildCredentialFetcher>[0];

function makeOutboundSpy() {
  const calls: Request[] = [];
  const outbound = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
      calls.push(req);
      return new Response("ok", { status: 200 });
    },
    connect: (() => { throw new Error("not needed"); }),
  } as unknown as OutboundLike;
  return { outbound, calls };
}

describe("buildCredentialFetcher", () => {
  it("returns the original outbound unchanged when no tokens are configured", () => {
    const { outbound } = makeOutboundSpy();
    expect(buildCredentialFetcher(outbound, {})).toBe(outbound);
  });

  it("forwards unknown hostnames without injecting Authorization", async () => {
    const { outbound, calls } = makeOutboundSpy();
    const wrapped = buildCredentialFetcher(outbound, { github: "ghp_test" });

    await wrapped.fetch("https://example.com/api");

    expect(calls.length).toBe(1);
    expect(calls[0].headers.get("Authorization")).toBeNull();
  });

  it("injects Bearer token for known GitHub hostnames", async () => {
    const { outbound, calls } = makeOutboundSpy();
    const wrapped = buildCredentialFetcher(outbound, { github: "ghp_test" });

    await wrapped.fetch("https://api.github.com/user");
    await wrapped.fetch("https://raw.githubusercontent.com/foo/bar/main/README.md");

    expect(calls[0].headers.get("Authorization")).toBe("Bearer ghp_test");
    expect(calls[1].headers.get("Authorization")).toBe("Bearer ghp_test");
  });

  it("overrides any Authorization header set by sandbox code", async () => {
    const { outbound, calls } = makeOutboundSpy();
    const wrapped = buildCredentialFetcher(outbound, { github: "ghp_real" });

    await wrapped.fetch("https://api.github.com/user", {
      headers: { Authorization: "Bearer ghp_attacker_injected" },
    });

    expect(calls[0].headers.get("Authorization")).toBe("Bearer ghp_real");
  });

  it("does not inject if the service slug has no configured token", async () => {
    const { outbound, calls } = makeOutboundSpy();
    const wrapped = buildCredentialFetcher(outbound, { stripe: "sk_test" });

    await wrapped.fetch("https://api.github.com/user");

    expect(calls[0].headers.get("Authorization")).toBeNull();
  });

  it("matches hostname case-insensitively", async () => {
    const { outbound, calls } = makeOutboundSpy();
    const wrapped = buildCredentialFetcher(outbound, { github: "ghp_test" });

    await wrapped.fetch("https://API.GITHUB.COM/user");

    expect(calls[0].headers.get("Authorization")).toBe("Bearer ghp_test");
  });

  it("preserves request body and method when injecting", async () => {
    const { outbound, calls } = makeOutboundSpy();
    const wrapped = buildCredentialFetcher(outbound, { github: "ghp_test" });

    await wrapped.fetch("https://api.github.com/repos/foo/bar/issues", {
      method: "POST",
      body: JSON.stringify({ title: "bug" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("Content-Type")).toBe("application/json");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer ghp_test");
    expect(await calls[0].text()).toBe('{"title":"bug"}');
  });

  it("connect() throws — raw TCP is not exposed through this wrapper", () => {
    const { outbound } = makeOutboundSpy();
    const wrapped = buildCredentialFetcher(outbound, { github: "ghp_test" });

    expect(() => (wrapped.connect as () => void)()).toThrow(/not supported/);
  });

  it("gracefully forwards requests with malformed URLs to outbound", async () => {
    const { outbound, calls } = makeOutboundSpy();
    const wrapped = buildCredentialFetcher(outbound, { github: "ghp_test" });
    // Use a Request object so we bypass the Request constructor's URL validation
    // at the top level and exercise the internal URL parse.
    const badReq = new Request("https://api.github.com/ok");
    // Monkey-patch url getter to return a non-parseable string
    Object.defineProperty(badReq, "url", { value: "not a url", configurable: true });

    await wrapped.fetch(badReq);

    expect(calls.length).toBe(1);
    expect(calls[0].headers.get("Authorization")).toBeNull();
  });
});

