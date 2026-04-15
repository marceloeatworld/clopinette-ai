function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function buildToolSummaryContext(steps: unknown, maxCharsPerResult = 2000): string {
  if (!Array.isArray(steps)) return "";

  const snippets: string[] = [];
  for (const step of steps) {
    const toolResults = (step as { toolResults?: Array<{ toolName?: string; output?: unknown }> }).toolResults;
    if (!Array.isArray(toolResults)) continue;

    for (const result of toolResults) {
      const raw = stringifyToolOutput(result.output).trim();
      if (!raw) continue;
      const capped = raw.length > maxCharsPerResult ? `${raw.slice(0, maxCharsPerResult)}...` : raw;
      snippets.push(`[${result.toolName ?? "tool"}] ${capped}`);
    }
  }

  return snippets.join("\n\n");
}
