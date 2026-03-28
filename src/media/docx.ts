import mammoth from "mammoth";

/**
 * Extract text from a DOCX file stored in R2.
 * Uses mammoth.js which works in Cloudflare Workers (ArrayBuffer input).
 */
export async function extractDocxText(
  r2: R2Bucket,
  r2Key: string
): Promise<string | null> {
  try {
    const obj = await r2.get(r2Key);
    if (!obj) return null;

    const arrayBuffer = await obj.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });

    const text = result.value.trim();
    if (!text || text.length < 10) return null;

    return text;
  } catch {
    return null;
  }
}
