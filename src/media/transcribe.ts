import type { MediaAsset } from "../config/types.js";

/**
 * Transcription module — voice/audio to text via Workers AI Whisper.
 * Uses @cf/openai/whisper-large-v3-turbo for best quality.
 */

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

interface WhisperResponse {
  text: string;
  word_count?: number;
  words?: Array<{ word: string; start: number; end: number }>;
}

/**
 * Transcribe an audio file from R2 using Whisper.
 * Populates asset.transcription with the transcribed text.
 */
export async function transcribeAudio(
  asset: MediaAsset,
  r2: R2Bucket,
  ai: Ai
): Promise<MediaAsset> {
  if (asset.type !== "voice") return asset;

  const obj = await r2.get(asset.r2Key);
  if (!obj) throw new Error(`Audio not found in R2: ${asset.r2Key}`);

  const buffer = await obj.arrayBuffer();

  // whisper-large-v3-turbo expects base64 string (not number[] like the older whisper)
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64Audio = btoa(binary);

  const result = await ai.run(WHISPER_MODEL as Parameters<Ai["run"]>[0], {
    audio: base64Audio,
  }) as WhisperResponse;

  return { ...asset, transcription: result.text || "(inaudible)", audioBytes: buffer.byteLength };
}
