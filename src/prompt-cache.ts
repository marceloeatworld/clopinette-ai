export function getPromptCacheDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function canReuseCachedSystemPrompt(
  prompt: string | null | undefined,
  cachedDay: string | null | undefined,
  cachedVersion: number,
  expectedVersion: number,
  now: Date = new Date(),
): prompt is string {
  return typeof prompt === "string"
    && prompt.length > 0
    && cachedVersion === expectedVersion
    && cachedDay === getPromptCacheDay(now);
}
