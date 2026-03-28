import { z } from "zod";

/**
 * Text-to-Speech tool via Workers AI Deepgram Aura-1.
 *
 * API: env.AI.run("@cf/deepgram/aura-1", { text, voice }) -> ReadableStream (MPEG)
 * No returnRawResponse needed — binding returns ReadableStream directly.
 * Voice format: "aura-{name}-en" (e.g. "aura-luna-en", "aura-asteria-en")
 */

const VOICE_NAMES = [
  "angus", "asteria", "arcas", "orion", "orpheus", "athena",
  "luna", "zeus", "perseus", "helios", "hera", "stella",
] as const;

export function createTtsTool(
  ai: Ai, r2: R2Bucket, userId: string,
  onUsage?: (tokensIn: number, tokensOut: number, model: string) => void,
) {
  return {
    description:
      "Convert text to speech audio (English).\n" +
      "USE when:\n" +
      "- User asks to 'read this aloud', 'say this', 'generate audio', 'voice'\n" +
      "- User wants a voice version of text content\n" +
      "Available voices: luna (default), asteria, athena, zeus, orpheus, orion, helios, hera, stella.\n" +
      "IMPORTANT: Do NOT include audio URLs or file links in your response. " +
      "The audio is delivered automatically by the system. Just confirm what was generated.",
    inputSchema: z.object({
      text: z.string().describe("The text to convert to speech (English)"),
      voice: z
        .enum(VOICE_NAMES)
        .optional()
        .default("luna")
        .describe("Voice name (default: luna)"),
    }),
    execute: async ({ text, voice }: { text: string; voice?: string }) => {
      if (!text || text.length < 2) {
        return { ok: false, error: "Text is too short" };
      }

      const capped = text.length > 5000 ? text.slice(0, 5000) : text;
      const voiceName = voice ?? "luna";

      try {
        // Call Deepgram Aura-1 — returns ReadableStream directly (no returnRawResponse needed)
        const stream = await (ai as unknown as { run: (model: string, input: Record<string, unknown>) => Promise<unknown> }).run(
          "@cf/deepgram/aura-1",
          { text: capped, voice: `aura-${voiceName}-en` }
        );

        // Convert ReadableStream to ArrayBuffer
        let audioBytes: ArrayBuffer;
        if (stream instanceof ReadableStream) {
          audioBytes = await new Response(stream).arrayBuffer();
        } else if (stream instanceof ArrayBuffer) {
          audioBytes = stream;
        } else if (stream && typeof stream === "object" && "audio" in (stream as Record<string, unknown>)) {
          // Fallback: base64 encoded audio
          const b64 = (stream as { audio: string }).audio;
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          audioBytes = bytes.buffer;
        } else {
          console.error("TTS unexpected return type:", typeof stream, stream);
          return { ok: false, error: "TTS returned unexpected format" };
        }

        if (audioBytes.byteLength < 100) {
          return { ok: false, error: "TTS returned empty audio" };
        }

        // Store in R2
        const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, "");
        const id = crypto.randomUUID();
        const r2Key = `${safeId}/audio/tts_${id}.mp3`;

        await r2.put(r2Key, audioBytes, {
          httpMetadata: { contentType: "audio/mpeg" },
          customMetadata: { type: "tts", voice: voiceName },
        });

        onUsage?.(capped.length * 8, 0, "@cf/deepgram/aura-1");

        return {
          ok: true,
          audio_key: r2Key,
          format: "mp3",
          voice: voiceName,
          chars: capped.length,
          _audio_delivery: true,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`TTS error: ${errMsg}`);
        return { ok: false, error: `TTS failed: ${errMsg}` };
      }
    },
  };
}
