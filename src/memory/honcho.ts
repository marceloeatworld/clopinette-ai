/**
 * Layer 5: Honcho — optional external context API.
 *
 * Honcho provides user modeling and context from an external service.
 * If configured, it's called on turn 1 (injected in system prompt)
 * and on subsequent turns (injected in user message).
 *
 * API: https://docs.honcho.dev
 */

export interface HonchoConfig {
  baseUrl: string;
  apiKey: string;
  appId: string;
}

export interface HonchoContext {
  content: string;
}

export async function getHonchoContext(
  config: HonchoConfig,
  userId: string,
  sessionId: string,
  message: string
): Promise<HonchoContext | null> {
  try {
    // SSRF protection: validate base URL
    const parsed = new URL(config.baseUrl);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host.startsWith("127.") || host.startsWith("10.")
        || host.startsWith("192.168.") || host.startsWith("169.254.")
        || host.endsWith(".internal") || host.endsWith(".local")) return null;

    const response = await fetch(
      `${config.baseUrl}/v1/apps/${config.appId}/users/${userId}/sessions/${sessionId}/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ query: message }),
      }
    );

    if (!response.ok) return null;

    const data = await response.json<{ content: string }>();
    return { content: data.content };
  } catch {
    return null;
  }
}
