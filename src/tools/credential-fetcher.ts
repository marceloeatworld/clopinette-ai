/**
 * Credential-injecting outbound Fetcher for codemode sandboxes.
 *
 * When the LLM writes `fetch("https://api.github.com/...")` inside a codemode
 * sandbox, this wrapper detects the hostname, looks up the corresponding
 * encrypted service token from the user's DO, strips any Authorization header
 * the sandbox code might have set, and injects `Authorization: Bearer <token>`
 * before forwarding to `clopinette-outbound` (which then runs the SSRF filter
 * and proxies to the real host).
 *
 * Security invariants:
 *  - Tokens are loaded inside the DO (has MASTER_KEY) and captured in a
 *    closure. The sandbox never receives them as bindings.
 *  - Authorization headers set by the sandbox are stripped for known-service
 *    hostnames, so the LLM cannot trick the proxy into forwarding an attacker
 *    token or remove the injected one.
 *  - Unknown hostnames pass through unchanged — SSRF guard still applies at
 *    the outbound worker.
 */

import type { SqlFn } from "../config/sql.js";
import type { AgentConfigRow } from "../config/types.js";
import { deriveMasterKey, decrypt } from "../crypto.js";

/**
 * Map of public hostnames to the service slug whose `service_token:{slug}`
 * entry in agent_config should be injected as a Bearer token.
 *
 * Add a new service: pick a stable slug, list every hostname the service
 * exposes for its REST surface, and ensure the slug matches the one shown
 * in the frontend Connections page.
 */
const HOSTNAME_TO_SERVICE: Record<string, string> = {
  "api.github.com": "github",
  "raw.githubusercontent.com": "github",
  "objects.githubusercontent.com": "github",
  "uploads.github.com": "github",
};

/**
 * Load and decrypt every `service_token:*` entry from the agent's config.
 * Invalid rows (decryption failure, empty value) are silently skipped so a
 * single corrupted token doesn't break the whole codemode outbound path.
 */
export async function loadServiceTokens(
  sql: SqlFn,
  masterKey: string,
): Promise<Record<string, string>> {
  const rows = sql<AgentConfigRow>`
    SELECT key, value, encrypted FROM agent_config
    WHERE key LIKE 'service_token:%'
  `;
  if (rows.length === 0) return {};
  const mk = await deriveMasterKey(masterKey);
  const tokens: Record<string, string> = {};
  for (const row of rows) {
    const slug = row.key.slice("service_token:".length);
    if (!slug) continue;
    try {
      const value = row.encrypted ? await decrypt(row.value, mk) : row.value;
      if (value) tokens[slug] = value;
    } catch {
      // Skip unreadable token rather than abort.
    }
  }
  return tokens;
}

/**
 * Wrap the outbound service binding with per-request credential injection.
 * Returns the original fetcher unchanged if there are no tokens to inject.
 */
export function buildCredentialFetcher(
  outbound: Fetcher,
  tokens: Record<string, string>,
): Fetcher {
  if (Object.keys(tokens).length === 0) return outbound;

  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input as RequestInfo, init);

      let hostname: string;
      try {
        hostname = new URL(req.url).hostname.toLowerCase();
      } catch {
        return outbound.fetch(req);
      }

      const service = HOSTNAME_TO_SERVICE[hostname];
      const token = service ? tokens[service] : undefined;
      if (!token) return outbound.fetch(req);

      const headers = new Headers(req.headers);
      headers.delete("authorization");
      headers.set("Authorization", `Bearer ${token}`);
      return outbound.fetch(new Request(req, { headers }));
    },
    // Raw TCP sockets are not exposed to codemode; fail loudly rather than
    // silently delegating to the underlying binding.
    connect: () => {
      throw new Error("connect() is not supported on the credential-injecting outbound fetcher");
    },
  };
}
