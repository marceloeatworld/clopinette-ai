import type { SkillSource, HubSkillMeta, HubSkillBundle } from "./types.js";
import { parseFrontmatter } from "./install.js";

/**
 * URL source — install a skill from any direct URL to a .md file.
 */

export class URLSource implements SkillSource {
  id = "url";

  async search(_query: string): Promise<HubSkillMeta[]> {
    // URL source doesn't support search — use hubInstallFromUrl directly
    return [];
  }

  async fetch(url: string): Promise<HubSkillBundle | null> {
    // SSRF protection: only allow HTTPS, reject private/internal addresses
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
    if (host === "localhost" || host === "0.0.0.0"
        || host.startsWith("127.") || host.startsWith("10.")
        || host.startsWith("192.168.") || host.startsWith("172.16.") || host.startsWith("172.17.")
        || host.startsWith("172.18.") || host.startsWith("172.19.")
        || host.startsWith("172.20.") || host.startsWith("172.21.") || host.startsWith("172.22.")
        || host.startsWith("172.23.") || host.startsWith("172.24.") || host.startsWith("172.25.")
        || host.startsWith("172.26.") || host.startsWith("172.27.") || host.startsWith("172.28.")
        || host.startsWith("172.29.") || host.startsWith("172.30.") || host.startsWith("172.31.")
        || host.startsWith("169.254.")
        || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")
        || host.endsWith(".internal") || host.endsWith(".local")) return null;

    const resp = await fetch(url, {
      headers: { "User-Agent": "Clopinette" },
    });
    if (!resp.ok) return null;

    const content = await resp.text();
    const { frontmatter, body } = parseFrontmatter(content);

    // Derive name from URL or frontmatter
    const urlName = url.split("/").pop()?.replace(/\.md$/i, "") ?? "imported-skill";
    const name = (frontmatter.name as string) || urlName;

    return {
      meta: {
        name,
        description: (frontmatter.description as string) || `Imported from ${new URL(url).hostname}`,
        source: "url",
        identifier: url,
        trustLevel: "community",
        author: frontmatter.author as string,
        license: frontmatter.license as string,
        tags: frontmatter.tags as string[],
      },
      content: body,
      frontmatter,
    };
  }
}
