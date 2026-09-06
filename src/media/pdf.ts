import { extractText } from "unpdf";

/**
 * Extract text from a PDF stored in R2.
 * Uses unpdf (pdf.js wrapper) which works in Cloudflare Workers.
 *
 * Returns extracted text or null if extraction fails (scanned PDF, corrupted, etc.)
 */
export async function extractPdfText(
  r2: R2Bucket,
  r2Key: string
): Promise<string | null> {
  try {
    const obj = await r2.get(r2Key);
    if (!obj) return null;

    const buffer = await obj.arrayBuffer();
    const { text, totalPages } = await extractText(new Uint8Array(buffer));

    // text is string[] (one per page) — join them
    const joined = (Array.isArray(text) ? text.join("\n\n") : String(text)).trim();
    if (!joined || joined.length < 20) return null;

    return `[PDF: ${totalPages} page(s)]\n\n${joined}`;
  } catch {
    return null;
  }
}
