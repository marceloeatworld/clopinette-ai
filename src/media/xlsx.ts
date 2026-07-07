import { unzipSync, strFromU8 } from "fflate";

/**
 * Extract text from an XLSX file stored in R2.
 * Zero-dependency approach: unzip + parse shared strings + sheet XML.
 * Works in Cloudflare Workers (no Node.js fs).
 */
export async function extractXlsxText(
  r2: R2Bucket,
  r2Key: string
): Promise<string | null> {
  try {
    const obj = await r2.get(r2Key);
    if (!obj) return null;

    const arrayBuffer = await obj.arrayBuffer();
    const files = unzipSync(new Uint8Array(arrayBuffer));

    // Build shared strings table
    const sharedStrings: string[] = [];
    const ssBytes = files["xl/sharedStrings.xml"];
    if (ssBytes) {
      const ssXml = strFromU8(ssBytes);
      const matches = ssXml.match(/<t[^>]*>([^<]*)<\/t>/g);
      if (matches) {
        for (const m of matches) {
          sharedStrings.push(m.replace(/<[^>]+>/g, ""));
        }
      }
    }

    // Parse sheets
    const rows: string[] = [];
    const sheetNames = Object.keys(files)
      .filter((k) => k.startsWith("xl/worksheets/sheet") && k.endsWith(".xml"))
      .sort();

    for (const sheetKey of sheetNames) {
      const xml = strFromU8(files[sheetKey]);
      const sheetLabel = sheetKey.match(/sheet(\d+)/)?.[1] ?? "?";
      rows.push(`--- Sheet ${sheetLabel} ---`);

      // Extract rows
      const rowMatches = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g);
      if (!rowMatches) continue;

      for (const rowXml of rowMatches) {
        const cells: string[] = [];
        const cellMatches = rowXml.match(/<c[^>]*>[\s\S]*?<\/c>/g);
        if (!cellMatches) continue;

        for (const cellXml of cellMatches) {
          const isShared = /\bt="s"/.test(cellXml);
          const valueMatch = cellXml.match(/<v>([^<]*)<\/v>/);
          if (!valueMatch) {
            // Inline string
            const inlineMatch = cellXml.match(/<t[^>]*>([^<]*)<\/t>/);
            cells.push(inlineMatch?.[1] ?? "");
            continue;
          }

          if (isShared) {
            const idx = parseInt(valueMatch[1], 10);
            cells.push(sharedStrings[idx] ?? valueMatch[1]);
          } else {
            cells.push(valueMatch[1]);
          }
        }

        if (cells.some((c) => c.length > 0)) {
          rows.push(cells.join("\t"));
        }
      }
    }

    const text = rows.join("\n").trim();
    if (!text || text.length < 5) return null;

    return text;
  } catch {
    return null;
  }
}
