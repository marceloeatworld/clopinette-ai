import { AUXILIARY_MODEL } from "../config/constants.js";

/**
 * Smart model routing — use cheap model for simple turns, primary for complex.
 *
 * Heuristics:
 * - Short messages (< 100 chars) with no tool history → auxiliary
 * - Greetings/acknowledgments → auxiliary
 * - Everything else → primary (user-configured or default)
 */

// Only match if the ENTIRE message is a greeting (not "hey what is your name")
const SIMPLE_PATTERNS = [
  /^(hi|hello|hey|bonjour|salut|merci|thanks|ok|oui|non|yes|no)[!?.,:;\s]*$/i,
  /^(what time|what day|what date)\??$/i,
];

const MAX_SIMPLE_LENGTH = 30; // Shorter threshold — anything longer is likely a real question

export interface RoutingDecision {
  model: string;
  reason: "simple" | "complex" | "forced";
}

export function routeModel(
  userMessage: string,
  configuredModel: string,
  toolCallCount: number,
  forceModel?: string
): RoutingDecision {
  if (forceModel) {
    return { model: forceModel, reason: "forced" };
  }

  // If tools were used recently, stay on primary model
  if (toolCallCount > 0) {
    return { model: configuredModel, reason: "complex" };
  }

  // Short + simple pattern → auxiliary (cheap model for greetings etc.)
  if (userMessage.length < MAX_SIMPLE_LENGTH) {
    for (const pattern of SIMPLE_PATTERNS) {
      if (pattern.test(userMessage.trim())) {
        return { model: AUXILIARY_MODEL, reason: "simple" };
      }
    }
  }

  return { model: configuredModel, reason: "complex" };
}
