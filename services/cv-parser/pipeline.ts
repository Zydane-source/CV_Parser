import type { ExtractionMethod } from "@prisma/client";
import { ProcessingError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { extractDocumentText, isImageMime, PDF_MIME, countMeaningfulChars } from "@/services/text-extraction";
import { getOCRProvider, type OCRProvider } from "@/services/ocr";
import { extractWithLLM, type LLMProvider } from "@/services/llm";
import { normalizeText } from "./normalize";
import { validateExtraction, type ValidatedExtraction } from "./validate";

/**
 * Unified CV parsing pipeline – used by BOTH manual uploads and Google Drive files.
 *
 *   File bytes → Text extraction → (OCR if needed) → Normalisation → LLM extraction
 *              → Validation → Confidence scoring → result
 *
 * This function is pure with respect to the database: persistence happens in
 * services/processing/processor.ts. Extracted text lives only in memory here
 * and is discarded when the function returns.
 */
export interface PipelineOptions {
  ocrMinTextChars: number;
  ocrMaxPages: number;
  ocrLanguages: string;
  maxCvTextChars: number;
  confidenceThreshold: number;
  llmModel: string;
  llmTemperature: number;
  llmTimeoutMs: number;
  promptVersion: string;
  /** Dependency injection for tests. Production uses configured providers. */
  llmProvider?: LLMProvider;
  ocrProvider?: OCRProvider;
  /** Stage callback for live status updates. */
  onStage?: (stage: PipelineStage) => Promise<void> | void;
}

export type PipelineStage = "TEXT_EXTRACTION" | "OCR" | "NORMALIZATION" | "LLM_EXTRACTION" | "VALIDATION";

export interface PipelineResult extends ValidatedExtraction {
  extractionMethod: ExtractionMethod;
  llmModel: string;
  promptVersion: string;
  pageCount: number;
  textChars: number;
  ocrConfidence?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export async function parseCV(buffer: Buffer, mimeType: string, opts: PipelineOptions): Promise<PipelineResult> {
  const stage = async (s: PipelineStage) => {
    if (opts.onStage) await opts.onStage(s);
  };

  // 1. Text extraction
  await stage("TEXT_EXTRACTION");
  const extracted = await extractDocumentText(buffer, mimeType, { minTextChars: opts.ocrMinTextChars });
  let text = extracted.text;
  let method: ExtractionMethod = extracted.method;
  let ocrConfidence: number | undefined;

  // 2. OCR fallback
  if (extracted.needsOcr) {
    if (isImageMime(mimeType) || mimeType === PDF_MIME) {
      await stage("OCR");
      const ocr = opts.ocrProvider ?? getOCRProvider();
      const ocrOpts = { languages: opts.ocrLanguages, maxPages: opts.ocrMaxPages };
      const r = isImageMime(mimeType) ? await ocr.extractFromImage(buffer, mimeType, ocrOpts) : await ocr.extractFromScannedPDF(buffer, ocrOpts);
      ocrConfidence = r.confidence;
      // Prefer OCR text only when it finds meaningfully more content than the
      // (sparse) text layer – OCR noise must not displace a valid text layer.
      if (countMeaningfulChars(r.text) > countMeaningfulChars(text) * 1.2) {
        text = r.text;
        method = isImageMime(mimeType) ? "OCR_IMAGE" : "OCR_PDF";
      }
      logger.info({ method, pages: r.pagesProcessed, ocrConfidence: Number(r.confidence.toFixed(2)) }, "OCR completed");
    }
  }

  // 3. Normalisation
  await stage("NORMALIZATION");
  const normalized = normalizeText(text, opts.maxCvTextChars);
  const meaningful = countMeaningfulChars(normalized);
  if (meaningful < 20) {
    throw new ProcessingError(
      `No readable text could be extracted from this ${mimeType} file (${meaningful} characters). The document may be blank, corrupted or an unreadable scan.`,
      "NO_TEXT",
      false,
    );
  }

  // 4. LLM extraction
  await stage("LLM_EXTRACTION");
  const llm = await extractWithLLM({
    cvText: normalized,
    model: opts.llmModel,
    temperature: opts.llmTemperature,
    timeoutMs: opts.llmTimeoutMs,
    promptVersion: opts.promptVersion,
    provider: opts.llmProvider,
  });

  // 5. Validation + confidence scoring
  await stage("VALIDATION");
  const validated = validateExtraction(llm.extraction, { threshold: opts.confidenceThreshold, cvText: normalized });
  if (ocrConfidence !== undefined && ocrConfidence < 0.6) {
    validated.reviewReasons.push(`Low OCR confidence (${ocrConfidence.toFixed(2)})`);
    validated.needsReview = true;
  }

  return {
    ...validated,
    extractionMethod: method,
    llmModel: llm.model,
    promptVersion: llm.promptVersion,
    pageCount: extracted.pageCount,
    textChars: normalized.length,
    ocrConfidence,
    usage: llm.usage,
  };
}
