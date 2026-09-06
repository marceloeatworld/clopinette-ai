import { z } from "zod";
import type { ByokMediaConfig } from "../config/types.js";

/**
 * Image generation tool.
 *
 * - Managed path (trial/pro): Workers AI FLUX.1 [schnell], returns { image: base64 } JPEG.
 * - BYOK path: when the user configured a media image model, the request goes to
 *   their own provider's OpenAI-compatible `/images/generations` endpoint through
 *   AI Gateway — their key, their bill. Free BYOK without a media model is refused.
 *
 * Images are stored in R2 and delivered via gateway (Telegram sendPhoto, WebSocket URL).
 */

async function generateViaByok(
  byok: ByokMediaConfig, prompt: string,
): Promise<{ bytes: Uint8Array; model: string }> {
  const res = await fetch(`${byok.baseURL}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${byok.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: byok.imageModel, prompt, n: 1, size: "1024x1024" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Provider returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = data.data?.[0];
  if (first?.b64_json) {
    const bin = atob(first.b64_json);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, model: byok.imageModel! };
  }
  if (first?.url) {
    const img = await fetch(first.url);
    if (!img.ok) throw new Error(`Image download failed: ${img.status}`);
    return { bytes: new Uint8Array(await img.arrayBuffer()), model: byok.imageModel! };
  }
  throw new Error("Provider returned no image data");
}

export function createImageGenTool(
  ai: Ai, r2: R2Bucket, userId: string,
  onUsage?: (tokensIn: number, tokensOut: number, model: string) => void,
  plan?: string,
  byokMedia?: ByokMediaConfig,
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
      const useByok = !!byokMedia?.imageModel;
      // Managed image gen (Workers AI) is not included in the free BYOK plan —
      // BYOK users set their own media image model in Settings → AI Provider
      if (plan === "byok" && !useByok) {
        return { ok: false, error: "Image generation on managed infrastructure is not included in the free BYOK plan. Set an image model in Settings → AI Provider to generate with your own key, or upgrade to Pro." };
      }
      if (!prompt || prompt.length < 5) {
        return { ok: false, error: "Prompt is too short — describe the image in detail" };
      }

      try {
        let imageBytes: Uint8Array;
        let usedModel: string;
        if (useByok) {
          const gen = await generateViaByok(byokMedia!, prompt);
          imageBytes = gen.bytes;
          usedModel = gen.model;
        } else {
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
          imageBytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            imageBytes[i] = binaryString.charCodeAt(i);
          }
          usedModel = "@cf/black-forest-labs/flux-1-schnell";
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

        onUsage?.(250, 0, usedModel);

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
