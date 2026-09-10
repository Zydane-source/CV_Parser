import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import type { ExtractionMethod } from "@prisma/client";

/**
 * Text extraction for text-based documents.
 *  - PDF  : pdf.js (via unpdf). Scanned PDFs are detected by low text density.
 *  - DOCX : mammoth (raw text; handles tables, headers/footers content in body).
 *  - DOC  : word-extractor (binary Word).
 *  - Images: no text layer → `needsOcr` is always true.
 *
 * Layout robustness: pdf.js returns text items in reading order for one- and
 * two-column documents; we do not rely on coordinates or a fixed template.
 */
export interface TextExtractionResult {
  text: string;
  method: ExtractionMethod;
  pageCount: number;
  /** True if the text layer is missing/too sparse and OCR should run. */
  needsOcr: boolean;
  /** Characters of meaningful text found (letters/digits). */
  meaningfulChars: number;
}

export const PDF_MIME = "application/pdf";
export const DOC_MIME = "application/msword";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.includes(mime);
}

export function countMeaningfulChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/**
 * Heuristic: text that is mostly garbage (e.g. font-encoding failures producing
 * symbols) or extremely short relative to page count is unusable.
 */
export function isTextUsable(text: string, pageCount: number, minChars: number): boolean {
  const meaningful = countMeaningfulChars(text);
  if (meaningful < minChars) return false;
  const total = text.replace(/\s+/g, "").length || 1;
  const ratio = meaningful / total;
  if (ratio < 0.5) return false; // mostly symbols → broken text layer
  const perPage = meaningful / Math.max(pageCount, 1);
  if (perPage < Math.min(minChars, 120)) return false;
  return true;
}

export async function extractPdfText(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const { extractText } = await import("unpdf");
  // pdf.js transfers (detaches) the byte buffer to its worker – pass a copy so the
  // caller's Buffer stays usable (e.g. for the OCR fallback).
  const data = new Uint8Array(buffer);
  const result = await extractText(data, { mergePages: false });
  const pages = result.text.map((t) => t.trim()).filter(Boolean);
  return { text: pages.join("\n\n"), pageCount: result.totalPages };
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}

export async function extractDocText(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  const parts = [doc.getHeaders?.() ?? "", doc.getBody(), doc.getFooters?.() ?? ""];
  return parts.filter(Boolean).join("\n");
}

export interface ExtractOptions {
  /** Minimum meaningful characters before OCR fallback triggers. */
  minTextChars: number;
}

export async function extractDocumentText(buffer: Buffer, mimeType: string, opts: ExtractOptions): Promise<TextExtractionResult> {
  if (isImageMime(mimeType)) {
    return { text: "", method: "NONE", pageCount: 1, needsOcr: true, meaningfulChars: 0 };
  }

  if (mimeType === PDF_MIME) {
    let text = "";
    let pageCount = 1;
    try {
      const r = await extractPdfText(buffer);
      text = r.text;
      pageCount = r.pageCount;
    } catch (err) {
      // Encrypted/corrupt text layer → try OCR rather than failing outright.
      const msg = err instanceof Error ? err.message : String(err);
      if (/password|encrypted/i.test(msg)) throw new Error("PDF is password protected");
      text = "";
    }
    const usable = isTextUsable(text, pageCount, opts.minTextChars);
    return { text, method: "PDF_TEXT", pageCount, needsOcr: !usable, meaningfulChars: countMeaningfulChars(text) };
  }

  if (mimeType === DOCX_MIME) {
    const text = await extractDocxText(buffer);
    const meaningful = countMeaningfulChars(text);
    // DOCX containing only an embedded image of a CV cannot be OCR'd by us; flag as needing OCR
    // so the pipeline reports it clearly instead of sending empty text to the LLM.
    return { text, method: "DOCX", pageCount: 1, needsOcr: meaningful < opts.minTextChars, meaningfulChars: meaningful };
  }

  if (mimeType === DOC_MIME) {
    const text = await extractDocText(buffer);
    const meaningful = countMeaningfulChars(text);
    return { text, method: "DOC", pageCount: 1, needsOcr: meaningful < opts.minTextChars, meaningfulChars: meaningful };
  }

  throw new Error(`Unsupported MIME type: ${mimeType}`);
}
