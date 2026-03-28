/**
 * Memory security scanning.
 * Heuristic defense-in-depth — not a guarantee against all attacks.
 * Checks for prompt injection patterns and invisible Unicode characters.
 */

const THREAT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Prompt injection
  { pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i, label: "prompt injection (ignore instructions)" },
  { pattern: /system\s*prompt/i, label: "prompt injection (system prompt access)" },
  { pattern: /you\s+are\s+now/i, label: "prompt injection (role override)" },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, label: "prompt injection (bypass restrictions)" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, label: "prompt injection (disregard rules)" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, label: "prompt injection (deception)" },
  // Credential exfiltration
  { pattern: /reveal\s+(your|the)\s+(secret|password|key|token)/i, label: "credential exfiltration" },
  { pattern: /curl\s+.{0,200}\$\{?\w{0,30}(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, label: "exfiltration via curl" },
  { pattern: /wget\s+.{0,200}\$\{?\w{0,30}(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, label: "exfiltration via wget" },
  { pattern: /cat\s+.{0,100}(\.env|credentials|\.netrc|\.pgpass)/i, label: "secret file read" },
  // Shell injection
  { pattern: /\b(rm\s+-rf|sudo|chmod|curl\s+.*\|\s*sh)\b/i, label: "shell command injection" },
  { pattern: /add\s+to\s+.*\.(bashrc|zshrc|profile)/i, label: "shell config injection" },
  { pattern: /authorized_keys/i, label: "SSH backdoor attempt" },
];

const INVISIBLE_CHARS = new Set([
  "\u200B", // zero-width space
  "\u200C", // zero-width non-joiner
  "\u200D", // zero-width joiner
  "\uFEFF", // byte order mark
  "\u00AD", // soft hyphen
  "\u2060", // word joiner
  "\u2061", // function application
  "\u2062", // invisible times
  "\u2063", // invisible separator
  "\u2064", // invisible plus
  "\u202A", // left-to-right embedding (bidi)
  "\u202B", // right-to-left embedding (bidi)
  "\u202C", // pop directional formatting (bidi)
  "\u202D", // left-to-right override (bidi)
  "\u202E", // right-to-left override (bidi)
]);

/**
 * Scans text for threat patterns and invisible characters.
 * Returns a description of the threat if found, or null if clean.
 */
export function scanForThreats(text: string): string | null {
  // Check for invisible characters
  for (const char of text) {
    if (INVISIBLE_CHARS.has(char)) {
      return `invisible Unicode character detected (U+${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()})`;
    }
  }

  // Normalize to NFKD to defeat homoglyph attacks (Cyrillic і→i, а→a, etc.)
  const normalized = text.normalize("NFKD");

  // Check for threat patterns against both original and normalized text
  for (const { pattern, label } of THREAT_PATTERNS) {
    if (pattern.test(text) || pattern.test(normalized)) {
      return label;
    }
  }

  return null;
}
