/**
 * Local CV extraction engine.
 *
 * Replaces the external LLM call in `services/cv-parser/pipeline.ts` with
 * deterministic extraction that runs entirely in-process. No network, no API
 * key, no candidate data leaving the server.
 *
 *   normalised text -> structural model -> per-field extractors -> scored result
 *
 * Output is a superset of the LLM's `LLMExtraction` shape, so the existing
 * validation, confidence weighting and persistence layers are untouched.
 */
import { buildDocument } from "./document";
import { extractName } from "./name";
import { extractPhone } from "./phone";
import { extractRole } from "./role";
import { getTaxonomy, type RoleTaxonomy } from "./taxonomy";
import { ENGINE_VERSION, type LocalExtraction, type FieldResult } from "./types";

export { ENGINE_VERSION } from "./types";
export type { LocalExtraction, FieldResult, ExtractionSignal } from "./types";
export { getTaxonomy, setTaxonomy, RoleTaxonomy } from "./taxonomy";
export { buildDocument } from "./document";

export interface LocalExtractOptions {
  /** Original file name; its tokens corroborate the candidate's name. */
  fileName?: string;
  /** OCR confidence 0..1 when the text came from OCR. Scales down all fields. */
  ocrConfidence?: number;
  taxonomy?: RoleTaxonomy;
}

export interface LocalExtractionDetail extends LocalExtraction {
  fields: {
    candidate_name: FieldResult;
    phone_number: FieldResult;
    job_role_applied_for: FieldResult;
  };
  /** Wall-clock milliseconds spent inside the engine. */
  durationMs: number;
}

/**
 * OCR text is noisier than a text layer, so confidence earned from it is worth
 * less. A clean OCR run (0.9+) barely discounts; a poor one (0.5) halves.
 */
function ocrPenalty(ocrConfidence: number | undefined): number {
  if (ocrConfidence === undefined) return 1;
  if (ocrConfidence >= 0.9) return 1;
  if (ocrConfidence >= 0.75) return 0.94;
  if (ocrConfidence >= 0.6) return 0.85;
  return 0.7;
}

export function extractLocally(normalizedText: string, opts: LocalExtractOptions = {}): LocalExtractionDetail {
  const started = Date.now();
  const doc = buildDocument(normalizedText);
  const taxonomy = opts.taxonomy ?? getTaxonomy();

  const name = extractName(doc, { fileName: opts.fileName, ocrUsed: opts.ocrConfidence !== undefined });
  const phone = extractPhone(doc);
  const role = extractRole(doc, { taxonomy });

  const penalty = ocrPenalty(opts.ocrConfidence);
  const scale = (f: FieldResult): FieldResult =>
    f.confidence === 0 ? f : { ...f, confidence: Number((f.confidence * penalty).toFixed(3)) };

  const scaled = {
    candidate_name: scale(name),
    phone_number: scale(phone),
    job_role_applied_for: scale(role),
  };

  return {
    candidate_name: scaled.candidate_name.value,
    phone_number: scaled.phone_number.value,
    job_role_applied_for: scaled.job_role_applied_for.value,
    confidence: {
      candidate_name: scaled.candidate_name.confidence,
      phone_number: scaled.phone_number.confidence,
      job_role_applied_for: scaled.job_role_applied_for.confidence,
    },
    methods: {
      candidate_name: scaled.candidate_name.method,
      phone_number: scaled.phone_number.method,
      job_role_applied_for: scaled.job_role_applied_for.method,
    },
    evidence: {
      candidate_name: scaled.candidate_name.why,
      phone_number: scaled.phone_number.why,
      job_role_applied_for: scaled.job_role_applied_for.why,
    },
    engine: "local",
    engineVersion: ENGINE_VERSION,
    fields: scaled,
    durationMs: Date.now() - started,
  };
}
