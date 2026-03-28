import type { MediaAsset } from "../config/types.js";

/**
 * Vision module — convert images to base64 data URIs for LLM vision.
 * Works with Kimi K2.5, Llama 3.2 Vision, Llama 4 Scout, Mistral Small 3.1.
 */

/**
 * Load image from R2 and convert to base64 data URI.
 * Populates asset.dataUri for use in AI SDK ImagePart.
 */
export async function prepareImageForVision(
  asset: MediaAsset,
  r2: R2Bucket
): Promise<MediaAsset> {
  if (asset.type !== "image") return asset;

  const obj = await r2.get(asset.r2Key);
  if (!obj) throw new Error(`Image not found in R2: ${asset.r2Key}`);

  const buffer = await obj.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);

  // Pass raw base64 (not data: URI). The AI SDK handles the conversion:
  // base64 string -> Uint8Array -> workers-ai-provider -> data: URI for Workers AI.
  // This works with all vision models (Kimi K2.5, Llama, Mistral, etc.)
  return { ...asset, dataUri: base64 };
}

/**
 * Build AI SDK content parts from media assets.
 * Images become ImagePart, voice transcriptions become text, docs become info text.
 */
export function mediaToContentParts(
  assets: MediaAsset[]
): Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> {
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> = [];

  for (const asset of assets) {
    if (asset.type === "image" && asset.dataUri) {
      parts.push({ type: "image", image: asset.dataUri, mediaType: asset.mimeType });
    } else if (asset.type === "image" && !asset.dataUri) {
      parts.push({ type: "text", text: `[Image received but could not be processed for vision. File: ${asset.originalName ?? asset.r2Key}]` });
    } else if (asset.type === "voice") {
      if (asset.transcription) {
        parts.push({ type: "text", text: `[Voice message transcription]: ${asset.transcription}` });
      } else {
        parts.push({ type: "text", text: `[Voice message received but transcription failed. Duration unknown. File: ${asset.originalName ?? asset.r2Key}]` });
      }
    // Documents handled by ingest.ts (ingestSummary) — skip here
    }
  }

  return parts;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
