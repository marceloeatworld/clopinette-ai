import type { MediaAsset } from "../config/types.js";

/**
 * Document ingest module — store documents in R2 for AutoRAG indexing.
 *
 * AutoRAG auto-indexes R2 objects every 6 hours.
 * Supported formats: PDF, DOCX, XLSX, MD, TXT, CSV, HTML, JSON, YAML, images.
 * Max file size for AutoRAG: 4 MB.
 *
 * Documents are stored under {userId}/docs/ which is the path AutoRAG watches.
 * The media/handler.ts already stores documents there via downloadAndStore().
 * This module provides additional utilities for ingest status and metadata.
 */

const AUTORAG_MAX_SIZE = 4 * 1024 * 1024; // 4 MB

const SUPPORTED_MIMES = new Set([
  "application/pdf",
  "text/plain", "text/markdown", "text/csv", "text/html",
  "application/json", "text/yaml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",      // xlsx
  "image/jpeg", "image/png", "image/webp", "image/svg+xml",
]);

/**
 * Check if a document is eligible for AutoRAG indexing.
 */
export function isAutoRAGEligible(asset: MediaAsset): { eligible: boolean; reason?: string } {
  if (asset.type !== "document") {
    return { eligible: false, reason: "Not a document" };
  }
  if (!SUPPORTED_MIMES.has(asset.mimeType)) {
    return { eligible: false, reason: `Unsupported format: ${asset.mimeType}` };
  }
  if (asset.sizeBytes > AUTORAG_MAX_SIZE) {
    return {
      eligible: false,
      reason: `Too large for AutoRAG: ${(asset.sizeBytes / 1024 / 1024).toFixed(1)}MB (max 4MB)`,
    };
  }
  return { eligible: true };
}

/**
 * Build a user-facing summary of what happened with the uploaded document.
 * If a transcript is available (PDF text extraction), include it directly.
 */
export function ingestSummary(asset: MediaAsset & { extractedText?: string }): string {
  const name = asset.originalName ?? asset.r2Key.split("/").pop();
  const size = `${(asset.sizeBytes / 1024).toFixed(0)}KB`;

  // If we extracted text, give it to the model directly
  if (asset.extractedText) {
    return `Document "${name}" (${size}) — content:\n\n${asset.extractedText}`;
  }

  // No text extracted — tell the model to use tools to find it
  return `Document "${name}" (${size}) stored. Use the docs tool to search its content.`;
}
