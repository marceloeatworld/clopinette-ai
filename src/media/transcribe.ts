import type { MediaAsset } from "../config/types.js";

/**
 * Transcription module — voice/audio to text.
 *
 * - Managed path (trial/pro): Workers AI @cf/openai/whisper-large-v3-turbo.
 * - BYOK path: when the user configured a media STT model, audio goes to their
 *   provider's OpenAI-compatible `/audio/transcriptions` endpoint through
 *   AI Gateway. Free BYOK without an STT model gets a placeholder instead of
 *   silently billing Workers AI.
 */

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

interface WhisperResponse {
  text: string;
  word_count?: number;
  words?: Array<{ word: string; start: number; end: number }>;
}

export interface ByokSttConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

/**
 * Transcribe an audio file from R2.
 * Populates asset.transcription with the transcribed text.
 */
export async function transcribeAudio(
  asset: MediaAsset,
  r2: R2Bucket,
  ai: Ai,
  byokStt?: ByokSttConfig,
  plan?: string,
): Promise<MediaAsset> {
  if (asset.type !== "voice") return asset;

  if (plan === "byok" && !byokStt) {
    return {
      ...asset,
      transcription: "(voice message received — on the free BYOK plan, set a transcription model in Settings > AI Provider to enable transcription)",
    };
  }

  const obj = await r2.get(asset.r2Key);
  if (!obj) throw new Error(`Audio not found in R2: ${asset.r2Key}`);

  const buffer = await obj.arrayBuffer();

  if (byokStt) {
    // User's own provider — OpenAI-compatible /audio/transcriptions (multipart)
    const filename = asset.r2Key.split("/").pop() ?? "audio.ogg";
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: asset.mimeType ?? "audio/ogg" }), filename);
    form.append("model", byokStt.model);
    const res = await fetch(`${byokStt.baseURL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${byokStt.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`STT provider returned ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { text?: string };
    return { ...asset, transcription: data.text || "(inaudible)", audioBytes: buffer.byteLength };
  }

  // whisper-large-v3-turbo expects base64 string (not number[] like the older whisper)
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64Audio = btoa(binary);

  const result = await ai.run(WHISPER_MODEL as Parameters<Ai["run"]>[0], {
    audio: base64Audio,
  }) as unknown as WhisperResponse;

  return { ...asset, transcription: result.text || "(inaudible)", audioBytes: buffer.byteLength };
}
