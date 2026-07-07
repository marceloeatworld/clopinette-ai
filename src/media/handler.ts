import type { MediaAsset } from "../config/types.js";

/**
 * Platform-agnostic media handler.
 * All files go to R2 under {userId}/docs/ so AutoRAG indexes everything.
 *
 * Key R2 metadata fields used by AI Search:
 * - `context`: passed to the LLM during generation (guides answers about this file)
 * - `type`: image/voice/document (for filtering)
 * - Custom fields defined in AI Search schema (up to 5)
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB (Telegram getFile limit)

/**
 * Download a file from a URL and store it in R2 under {userId}/docs/.
 */
export async function downloadAndStore(
  url: string,
  r2: R2Bucket,
  userId: string,
  opts: { mimeType: string; originalName?: string; type: MediaAsset["type"] }
): Promise<MediaAsset> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

  const bytes = await resp.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB (max 20MB)`);
  }

  const ext = extensionFromMime(opts.mimeType) || "bin";
  const id = crypto.randomUUID().slice(0, 12);
  const filename = opts.originalName
    ? sanitizeName(opts.originalName)
    : `${opts.type}_${id}.${ext}`;
  const r2Key = `${sanitizeUserId(userId)}/docs/${filename}`;

  await r2.put(r2Key, bytes, {
    httpMetadata: { contentType: opts.mimeType },
    customMetadata: {
      context: `${opts.type} file: ${filename}`,
      originalName: opts.originalName ?? filename,
      uploadedAt: new Date().toISOString(),
      type: opts.type,
    },
  });

  return {
    type: opts.type,
    r2Key,
    mimeType: opts.mimeType,
    originalName: opts.originalName,
    sizeBytes: bytes.byteLength,
  };
}

/**
 * Save a transcript sidecar .md alongside the original audio file in R2.
 * AI Search cannot process audio, so the transcript is the only way it gets indexed.
 * Also updates the original file's `context` metadata with a short summary.
 */
export async function saveTranscript(
  r2: R2Bucket,
  asset: MediaAsset,
  transcript: string
): Promise<string> {
  const baseName = asset.r2Key.replace(/\.[^.]+$/, "");
  const mdKey = `${baseName}.transcript.md`;
  const name = asset.originalName ?? asset.r2Key.split("/").pop() ?? "file";

  const md = [
    `# Audio Transcript`,
    ``,
    `**Source**: ${name}`,
    `**Type**: ${asset.mimeType}`,
    `**Size**: ${(asset.sizeBytes / 1024).toFixed(0)} KB`,
    `**Date**: ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
    transcript,
  ].join("\n");

  // Save the transcript .md (AI Search indexes this)
  await r2.put(mdKey, md, {
    httpMetadata: { contentType: "text/markdown" },
    customMetadata: {
      context: `Transcript of ${name}: ${transcript.slice(0, 500)}`,
      sourceFile: asset.r2Key,
      type: "transcript",
    },
  });

  // Update the original audio file's context metadata so AI Search
  // can provide it to the LLM even when the audio itself isn't indexed
  const shortSummary = transcript.slice(0, 1500);
  await updateContext(r2, asset.r2Key, `Voice message transcript: ${shortSummary}`);

  return mdKey;
}

/**
 * Update the `context` metadata on an existing R2 object.
 * Used after LLM analyzes an image or after Whisper transcribes audio.
 *
 * Two-tier write:
 * 1. SQLite doc_context table (fast, used by docs tool)
 * 2. R2 metadata re-upload (slow but needed for AutoRAG AI Search)
 *
 * The R2 re-upload downloads + re-uploads the entire file just to change
 * one metadata field. For a 4MB PDF, that's 8MB of bandwidth. So we do it
 * in the background and use SQLite for immediate reads.
 */
export async function updateContext(
  r2: R2Bucket,
  r2Key: string,
  context: string,
  sql?: import("../config/sql.js").SqlFn
): Promise<void> {
  const trimmedContext = context.slice(0, 2000);

  // Fast path: SQLite (immediate, used by docs tool)
  if (sql) {
    sql`INSERT OR REPLACE INTO doc_context (r2_key, context, updated_at)
      VALUES (${r2Key}, ${trimmedContext}, datetime('now'))`;
  }

  // Slow path: R2 metadata re-upload (for AutoRAG — background, non-blocking)
  try {
    const obj = await r2.get(r2Key);
    if (!obj) return;

    const body = await obj.arrayBuffer();
    const existing = obj.customMetadata ?? {};

    await r2.put(r2Key, body, {
      httpMetadata: obj.httpMetadata,
      customMetadata: { ...existing, context: trimmedContext },
    });
  } catch {
    // R2 re-upload failure is non-fatal — SQLite has the data
  }
}

/**
 * Download a Telegram file by file_id -> store in R2.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  r2: R2Bucket,
  userId: string,
  opts: { mimeType: string; originalName?: string; type: MediaAsset["type"] }
): Promise<MediaAsset> {
  const fileResp = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    }
  );
  const fileData = await fileResp.json<{
    ok: boolean;
    result?: { file_path: string; file_size?: number };
  }>();

  if (!fileData.ok || !fileData.result?.file_path) {
    throw new Error("Failed to get file from Telegram");
  }

  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
  return downloadAndStore(downloadUrl, r2, userId, opts);
}

/**
 * Save a PDF transcript sidecar alongside the original PDF in R2.
 * Same pattern as audio transcripts — makes PDFs immediately searchable by docs tool.
 */
export async function savePdfTranscript(
  r2: R2Bucket,
  asset: MediaAsset,
  extractedText: string
): Promise<string> {
  const baseName = asset.r2Key.replace(/\.[^.]+$/, "");
  const mdKey = `${baseName}.transcript.md`;
  const name = asset.originalName ?? asset.r2Key.split("/").pop() ?? "file";

  const md = [
    `# PDF Content`,
    ``,
    `**Source**: ${name}`,
    `**Size**: ${(asset.sizeBytes / 1024).toFixed(0)} KB`,
    `**Date**: ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
    extractedText,
  ].join("\n");

  await r2.put(mdKey, md, {
    httpMetadata: { contentType: "text/markdown" },
    customMetadata: {
      context: `PDF content of ${name}: ${extractedText.slice(0, 500)}`,
      sourceFile: asset.r2Key,
      type: "transcript",
    },
  });

  // Update original PDF's context metadata
  await updateContext(r2, asset.r2Key, `PDF document: ${name}. Content: ${extractedText.slice(0, 1500)}`);

  return mdKey;
}

// ───────────────────────── Helpers ─────────────────────────

function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "");
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function extensionFromMime(mime: string): string | null {
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/wav": "wav",
    "video/mp4": "mp4", "video/webm": "webm",
    "application/pdf": "pdf",
    "text/plain": "txt", "text/markdown": "md", "text/csv": "csv",
    "text/html": "html",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  return map[mime] ?? null;
}
