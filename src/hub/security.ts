import { scanForThreats } from "../memory/security.js";
import type { HubSkillBundle } from "./types.js";

const MAX_SKILL_CHARS = 200_000;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const HUB_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:javascript|data|file|vbscript):/i, label: "dangerous URI scheme" },
  { pattern: /https?:\/\/[^\s]*\.(exe|bat|cmd|ps1|sh)\b/i, label: "links to executable files" },
  { pattern: /<\s*(script|iframe|object|embed|meta|base)\b/i, label: "embedded executable HTML" },
  { pattern: /<!--[\s\S]{0,500}(ignore|system prompt|developer instructions|secret|token)[\s\S]{0,500}-->/i, label: "hidden prompt injection in HTML comment" },
  { pattern: /(take|takes)\s+precedence\s+over\s+(system|developer|tool|safety)/i, label: "attempts to override higher-priority instructions" },
  { pattern: /(ignore|bypass|override).{0,120}(developer|system|tool|safety|guardrail)/i, label: "attempts to bypass safeguards" },
  { pattern: /(send|upload|post|exfiltrat|leak|transmit).{0,120}(secret|token|password|credential|api key|environment variable)/i, label: "secret exfiltration instructions" },
  { pattern: /\b(print|dump|list|show)\b.{0,80}\b(all\s+)?(secrets|tokens|keys|environment variables|env vars)\b/i, label: "bulk secret disclosure instructions" },
];

export function scanHubBundle(bundle: HubSkillBundle): string | null {
  if (!bundle.meta.name?.trim()) return "missing skill name";
  if (!bundle.content.trim()) return "empty skill body";
  if (bundle.content.length > MAX_SKILL_CHARS) {
    return `skill too large (${bundle.content.length} chars)`;
  }

  const surfaces: Array<{ label: string; text: string }> = [
    { label: "skill body", text: bundle.content },
    { label: "skill frontmatter", text: JSON.stringify(bundle.frontmatter ?? {}) },
    {
      label: "skill metadata",
      text: [
        bundle.meta.name,
        bundle.meta.description,
        bundle.meta.author,
        bundle.meta.license,
        ...(bundle.meta.tags ?? []),
      ].filter(Boolean).join("\n"),
    },
  ];

  for (const surface of surfaces) {
    if (!surface.text) continue;
    if (CONTROL_CHARS.test(surface.text)) {
      return `${surface.label} contains disallowed control characters`;
    }

    const threat = scanForThreats(surface.text);
    if (threat) return `${surface.label}: ${threat}`;

    for (const { pattern, label } of HUB_PATTERNS) {
      if (pattern.test(surface.text)) return `${surface.label}: ${label}`;
    }
  }

  return null;
}
