import { z } from "zod";

/**
 * Image generation tool via Workers AI FLUX.1 [schnell].
 *
 * Generates JPEG images from text prompts. Free, fast, no external API key needed.
 * Images are stored in R2 and delivered via gateway (Telegram sendPhoto, WebSocket URL).
 *
 * API returns { image: base64string } (JPEG).
 */

export function createImageGenTool(
  ai: Ai, r2: R2Bucket, userId: string,
  onUsage?: (tokensIn: number, tokensOut: number, model: string) => void,
) {
  return {
    description:
      "Generate an image from a text description.\n" +
      "USE when:\n" +
      "- User asks to 'create an image', 'draw', 'generate a picture'\n" +
      "- User wants a visual representation of something\n" +
      "Write a detailed English prompt for best results. Be specific about style, colors, composition.\n" +
      "IMPORTANT: Do NOT include image URLs or markdown image links in your response. " +
      "The image is delivered automatically by the system. Just describe what was generated.",
    inputSchema: z.object({
      prompt: z.string().describe("Detailed description of the image to generate (English)"),
      steps: z
        .number()
        .optional()
        .default(4)
        .describe("Diffusion steps (1-8, higher = better quality but slower, default 4)"),
    }),
    execute: async ({ prompt, steps }: { prompt: string; steps?: number }) => {
      if (!prompt || prompt.length < 5) {
        return { ok: false, error: "Prompt is too short — describe the image in detail" };
      }

      try {
        // Call Workers AI Flux — returns { image: base64string } (JPEG)
        const result = await (ai as unknown as { run: (model: string, input: Record<string, unknown>) => Promise<{ image: string }> }).run(
          "@cf/black-forest-labs/flux-1-schnell",
          { prompt, steps: Math.max(1, Math.min(steps ?? 4, 8)) }
        );

        if (!result?.image) {
          return { ok: false, error: "Image generation returned empty result" };
        }

        // Decode base64 to binary
        const binaryString = atob(result.image);
        const imageBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          imageBytes[i] = binaryString.charCodeAt(i);
        }

        if (imageBytes.byteLength < 100) {
          return { ok: false, error: "Image generation returned empty image" };
        }

        // Store in R2
        const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, "");
        const id = crypto.randomUUID();
        const r2Key = `${safeId}/images/gen_${id}.jpg`;

        await r2.put(r2Key, imageBytes, {
          httpMetadata: { contentType: "image/jpeg" },
          customMetadata: {
            type: "generated",
            prompt: prompt.slice(0, 500),
          },
        });

        onUsage?.(250, 0, "@cf/black-forest-labs/flux-1-schnell");

        return {
          ok: true,
          image_key: r2Key,
          format: "jpg",
          prompt: prompt.slice(0, 100),
          _image_delivery: true,
        };
      } catch (err) {
        return {
          ok: false,
          error: `Image generation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
