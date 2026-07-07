export const TELEGRAM_MAX_LENGTH = 4096;

const MDV2_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeTelegramMarkdownV2(text: string): string {
  return text.replace(MDV2_ESCAPE_RE, "\\$1");
}

export function stripTelegramMarkdown(text: string): string {
  return text
    .replace(/\\([_*\[\]()~`>#\+\-=|{}.!\\])/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
    .replace(/~([^~]+)~/g, "$1")
    .replace(/\|\|([^|]+)\|\|/g, "$1");
}

export function formatTelegramMessage(content: string): string {
  if (!content) return content;

  const placeholders = new Map<string, string>();
  let counter = 0;
  const stash = (value: string) => {
    const key = `\u0000PH${counter}\u0000`;
    counter += 1;
    placeholders.set(key, value);
    return key;
  };

  let text = content;

  text = text.replace(/(```(?:[^\n]*\n)?[\s\S]*?```)/g, (raw) => {
    const openEnd = raw.indexOf("\n", 3);
    const splitAt = openEnd === -1 ? 3 : openEnd + 1;
    const opening = raw.slice(0, splitAt);
    const body = raw.slice(splitAt, -3).replace(/\\/g, "\\\\").replace(/`/g, "\\`");
    return stash(opening + body + "```");
  });

  text = text.replace(/(`[^`]+`)/g, (raw) => stash(raw.replace(/\\/g, "\\\\")));

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const display = escapeTelegramMarkdownV2(label);
    const safeUrl = url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
    return stash(`[${display}](${safeUrl})`);
  });

  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_match, inner: string) => {
    const clean = inner.trim().replace(/\*\*(.+?)\*\*/g, "$1");
    return stash(`*${escapeTelegramMarkdownV2(clean)}*`);
  });

  text = text.replace(/\*\*(.+?)\*\*/g, (_match, inner: string) => {
    return stash(`*${escapeTelegramMarkdownV2(inner)}*`);
  });

  text = text.replace(/\*([^*\n]+)\*/g, (_match, inner: string) => {
    return stash(`_${escapeTelegramMarkdownV2(inner)}_`);
  });

  text = text.replace(/~~(.+?)~~/g, (_match, inner: string) => {
    return stash(`~${escapeTelegramMarkdownV2(inner)}~`);
  });

  text = text.replace(/\|\|(.+?)\|\|/g, (_match, inner: string) => {
    return stash(`||${escapeTelegramMarkdownV2(inner)}||`);
  });

  text = text.replace(/^((?:\*\*)?>{1,3}) (.+)$/gm, (_match, prefix: string, inner: string) => {
    if (prefix.startsWith("**") && inner.endsWith("||")) {
      return stash(`${prefix} ${escapeTelegramMarkdownV2(inner.slice(0, -2))}||`);
    }
    return stash(`${prefix} ${escapeTelegramMarkdownV2(inner)}`);
  });

  text = escapeTelegramMarkdownV2(text);

  for (const key of Array.from(placeholders.keys()).reverse()) {
    text = text.replaceAll(key, placeholders.get(key) ?? "");
  }

  const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  text = segments.map((segment, index) => {
    if (index % 2 === 1) return segment;
    return segment.replace(/[(){}]/g, (char, offset) => {
      if (offset > 0 && segment[offset - 1] === "\\") return char;
      if (char === "(" && offset > 0 && segment[offset - 1] === "]") return char;
      if (char === ")") {
        const before = segment.slice(0, offset);
        if (before.includes("](")) return char;
      }
      return `\\${char}`;
    });
  }).join("");

  return text;
}

export function splitTelegramMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openCodeLang: string | null = null;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      let finalChunk = remaining;
      if (openCodeLang !== null) {
        finalChunk = `\`\`\`${openCodeLang}\n${finalChunk}\n\`\`\``;
      }
      chunks.push(finalChunk);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen / 3) splitIdx = maxLen;

    let chunk = remaining.slice(0, splitIdx);
    remaining = remaining.slice(splitIdx);

    if (openCodeLang) {
      chunk = `\`\`\`${openCodeLang}\n${chunk}`;
      openCodeLang = null;
    }

    const fenceCount = chunk.match(/```/g);
    const isOpen = fenceCount ? fenceCount.length % 2 !== 0 : false;
    if (isOpen) {
      const langMatch = chunk.match(/```(\w*)\n/);
      openCodeLang = langMatch?.[1] ?? "";
      chunk += "\n```";
    }

    chunks.push(chunk);
  }

  return chunks;
}
