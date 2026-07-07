/**
 * Codemode Outbound Worker — SSRF-safe fetch proxy for LLM-generated sandbox code.
 *
 * All fetch() calls from codemode sandboxes are routed here via the
 * DynamicWorkerExecutor's globalOutbound service binding.
 *
 * Security: blocks private IPs (SSRF), non-HTTP protocols, and oversized responses.
 */

const PRIVATE_RANGES = [
  /^127\./,                          // loopback
  /^10\./,                           // class A private
  /^172\.(1[6-9]|2\d|3[01])\./,     // class B private
  /^192\.168\./,                     // class C private
  /^169\.254\./,                     // link-local
  /^0\./,                            // current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
];

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",  // cloud metadata
]);

function isPrivateHost(hostname: string): boolean {
  if (PRIVATE_HOSTNAMES.has(hostname)) return true;
  if (hostname.startsWith("[")) return true; // block all IPv6 literals (conservative)
  return PRIVATE_RANGES.some((re) => re.test(hostname));
}

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Block non-HTTP protocols
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return new Response("Blocked: only HTTP/HTTPS allowed", { status: 403 });
    }

    // SSRF guard: block private/loopback/metadata IPs
    if (isPrivateHost(url.hostname)) {
      return new Response("Blocked: private network access denied", { status: 403 });
    }

    // Proxy the request to the real internet
    const response = await fetch(request);

    // Guard against oversized responses filling sandbox memory
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      return new Response("Blocked: response too large", { status: 413 });
    }

    return response;
  },
};
