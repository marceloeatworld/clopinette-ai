export const INTERNAL_NO_RESPONSE_TEXT = "(no response)";
export const DEFAULT_GATEWAY_RESPONSE_FALLBACK = "I found relevant information but couldn't finish the final reply. Please try again.";

export function resolveGatewayResponseText(
  text: string | null | undefined,
  fallback = DEFAULT_GATEWAY_RESPONSE_FALLBACK,
): string {
  const normalized = text?.trim() ?? "";
  if (!normalized || normalized === INTERNAL_NO_RESPONSE_TEXT) {
    return fallback;
  }
  return normalized;
}
