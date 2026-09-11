import type { ExtractionMethod } from "@prisma/client";
import { ProcessingError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { extractDocumentText, isImageMime, PDF_MIME, countMeaningfulChars } from "@/services/text-extraction";
import { getOCRProvider, type OCRProvider } from "@/services/ocr";
import { extractWithLLM, type LLMProvider } from "@/services/llm";
import type { LLMExtraction } from "@/services/llm/types";
import { extractLocally } from "@/services/cv-engine";
import { env } from "@/lib/config";
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
  /** Original file name; its tokens corroborate the candidate name. */
  fileName?: string;
  /** Override the configured engine (tests, benchmark). */
  engine?: "local" | "shadow" | "legacy";
  /** Stage callback for live status updates. */
  onStage?: (stage: PipelineStage) => Promise<void> | void;
}

export type PipelineStage = "TEXT_EXTRACTION" | "OCR" | "NORMALIZATION" | "EXTRACTION" | "VALIDATION";

export interface PipelineResult extends ValidatedExtraction {
  extractionMethod: ExtractionMethod;
  llmModel: string;
  promptVersion: string;
  pageCount: number;
  textChars: number;
  ocrConfidence?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Which engine produced the fields. */
  engine: "local" | "llm";
  engineVersion: string;
  /** Per-field provenance, local engine only. */
  fieldMethods?: Record<string, string>;
  /** Milliseconds spent in step 4 alone. */
  extractionMs: number;
  shadow?: ShadowComparison;
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

  // 4. Field extraction — local engine by default, LLM only behind the flag.
  await stage("EXTRACTION");
  const engineMode = opts.engine ?? env().EXTRACTION_ENGINE;
  const extraction = await runExtraction(engineMode, normalized, {
    fileName: opts.fileName,
    ocrConfidence,
    llm: {
      model: opts.llmModel,
      temperature: opts.llmTemperature,
      timeoutMs: opts.llmTimeoutMs,
      promptVersion: opts.promptVersion,
      provider: opts.llmProvider,
    },
  });

  // 5. Validation + confidence scoring (unchanged; both engines feed the same shape)
  await stage("VALIDATION");
  const validated = validateExtraction(extraction.result, { threshold: opts.confidenceThreshold, cvText: normalized });
  if (ocrConfidence !== undefined && ocrConfidence < 0.6) {
    validated.reviewReasons.push(`Low OCR confidence (${ocrConfidence.toFixed(2)})`);
    validated.needsReview = true;
  }

  return {
    ...validated,
    extractionMethod: method,
    llmModel: extraction.modelLabel,
    promptVersion: extraction.versionLabel,
    pageCount: extracted.pageCount,
    textChars: normalized.length,
    ocrConfidence,
    usage: extraction.usage,
    engine: extraction.engine,
    engineVersion: extraction.engineVersion,
    fieldMethods: extraction.fieldMethods,
    extractionMs: extraction.durationMs,
    shadow: extraction.shadow,
  };
}

/** Result of step 4, normalised across both engines. */
interface ExtractionOutcome {
  result: LLMExtraction;
  engine: "local" | "llm";
  /** Stored in Candidate.llmModel — the model name; empty for the local engine. */
  modelLabel: string;
  /** Stored in Candidate.promptVersion — prompt version; empty for the local engine. */
  versionLabel: string;
  /** Stored in Candidate.extractionVersion — always set, for either engine. */
  engineVersion: string;
  fieldMethods?: Record<string, string>;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  shadow?: ShadowComparison;
}

async function runExtraction(
  mode: "local" | "shadow" | "legacy",
  text: string,
  ctx: {
    fileName?: string;
    ocrConfidence?: number;
    llm: { model: string; temperature: number; timeoutMs: number; promptVersion: string; provider?: LLMProvider };
  },
): Promise<ExtractionOutcome> {
  if (mode === "legacy") {
    const started = Date.now();
    const llm = await extractWithLLM({
      cvText: text,
      model: ctx.llm.model,
      temperature: ctx.llm.temperature,
      timeoutMs: ctx.llm.timeoutMs,
      promptVersion: ctx.llm.promptVersion,
      provider: ctx.llm.provider,
    });
    return {
      result: llm.extraction,
      engine: "llm",
      modelLabel: llm.model,
      versionLabel: llm.promptVersion,
      engineVersion: llm.promptVersion,
      durationMs: Date.now() - started,
      usage: llm.usage,
    };
  }

  const local = extractLocally(text, { fileName: ctx.fileName, ocrConfidence: ctx.ocrConfidence });
  const outcome: ExtractionOutcome = {
    result: {
      candidate_name: local.candidate_name,
      phone_number: local.phone_number,
      job_role_applied_for: local.job_role_applied_for,
      confidence: local.confidence,
    },
    engine: "local",
    // No model and no prompt were involved, so both legacy provenance columns
    // stay empty rather than carrying a stand-in value. A row's engine and
    // version live in `extractionEngine` / `extractionVersion`; writing
    // "local-engine" into a column named `llmModel` would quietly break anyone
    // filtering on it to find LLM-processed records.
    modelLabel: "",
    versionLabel: "",
    engineVersion: local.engineVersion,
    fieldMethods: local.methods as unknown as Record<string, string>,
    durationMs: local.durationMs,
  };

  // Shadow mode: run the LLM too, compare, log. Its output is never stored as
  // production data — `outcome.result` remains the local engine's.
  if (mode === "shadow") {
    try {
      const llm = await extractWithLLM({
        cvText: text,
        model: ctx.llm.model,
        temperature: ctx.llm.temperature,
        timeoutMs: ctx.llm.timeoutMs,
        promptVersion: ctx.llm.promptVersion,
        provider: ctx.llm.provider,
      });
      outcome.shadow = compareExtractions(local, llm.extraction);
      logger.info({ shadow: outcome.shadow, model: llm.model }, "shadow comparison");
    } catch (err) {
      // The shadow comparison must never fail a production extraction.
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "shadow LLM call failed; local result kept");
    }
  }

  return outcome;
}

export interface ShadowComparison {
  nameAgrees: boolean;
  phoneAgrees: boolean;
  roleAgrees: boolean;
  agreementCount: number;
}

/** Field-by-field agreement, normalised so casing and spacing do not count as disagreement. */
function compareExtractions(local: { candidate_name: string; phone_number: string; job_role_applied_for: string }, llm: LLMExtraction): ShadowComparison {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const nameAgrees = norm(local.candidate_name) === norm(llm.candidate_name);
  const phoneAgrees = local.phone_number.replace(/\D/g, "") === String(llm.phone_number).replace(/\D/g, "");
  const roleAgrees = norm(local.job_role_applied_for) === norm(llm.job_role_applied_for);
  return { nameAgrees, phoneAgrees, roleAgrees, agreementCount: [nameAgrees, phoneAgrees, roleAgrees].filter(Boolean).length };
}
