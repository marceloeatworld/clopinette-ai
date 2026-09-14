/**
 * Smart model routing — use cheap model for simple turns, primary for complex.
 *
 * Heuristics:
 * - Short conversational messages (greetings, acknowledgments, check-ins,
 *   goodbyes) with no tool history → auxiliary
 * - Everything else → primary (user-configured or default)
 */

// Conversational phrases that never need tools or the full prompt. Matched
// against the normalized message (lowercase, accents stripped, apostrophes
// turned into spaces, punctuation and emoji removed), so "T'es là ?!" becomes
// "t es la". Up to three phrases may be chained ("ok merci", "salut ca va").
const SIMPLE_PHRASES = [
  // greetings
  "hi", "hello", "hey", "yo", "coucou", "bonjour", "bonsoir", "salut", "wesh", "sup",
  // thanks
  "merci", "merci beaucoup", "thanks", "thank you", "thx", "ty",
  // acknowledgments
  "ok", "okay", "oui", "non", "yes", "no", "yep", "nope", "yeah", "ouais",
  "cool", "super", "top", "parfait", "nickel", "genial", "d accord", "dac",
  "bien", "good", "nice", "great", "lol", "haha", "mdr",
  // check-ins
  "ca va", "tu es la", "t es la", "tes la", "te la", "t la",
  "you there", "are you there", "u there", "how are you", "ping", "test",
  // goodbyes
  "bye", "ciao", "a plus", "a bientot", "bonne nuit", "good night", "bonne journee",
];

const SIMPLE_PATTERNS = [
  new RegExp(`^(?:(?:${SIMPLE_PHRASES.join("|")})\\s*){1,3}$`),
  /^(what time|what day|what date)$/,
];

const MAX_SIMPLE_LENGTH = 30; // Shorter threshold — anything longer is likely a real question

function normalize(message: string): string {
  return message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RoutingDecision {
  model: string;
  reason: "simple" | "complex" | "forced";
}

export function routeModel(
  userMessage: string,
  configuredModel: string,
  auxiliaryModel: string,
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
    const normalized = normalize(userMessage);
    for (const pattern of SIMPLE_PATTERNS) {
      if (pattern.test(normalized)) {
        return { model: auxiliaryModel, reason: "simple" };
      }
    }
  }

  return { model: configuredModel, reason: "complex" };
}
