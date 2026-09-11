/**
 * Contract for the local extraction engine.
 *
 * `LocalExtraction` is deliberately a superset of the LLM's `LLMExtraction`
 * shape, so the existing validation, confidence scoring and persistence layers
 * consume it unchanged. The extra `methods` and `evidence` fields carry the
 * provenance that a deterministic engine can honestly report and an LLM cannot.
 */

/** How a field's value was arrived at. Drives both confidence and auditability. */
export type ExtractionSignal =
  | "explicit_label"
  | "contact_section"
  | "header_detection"
  | "regex"
  | "keyword_match"
  | "taxonomy_match"
  | "classifier"
  | "filename"
  | "email_local_part"
  | "heuristic"
  | "none";

/** One scored candidate for a field, before the best is chosen. */
export interface FieldCandidate {
  value: string;
  /** Sum of signal weights, before normalisation to 0..1. */
  score: number;
  signals: ExtractionSignal[];
  /** 0-based line index in the normalised text, when known. */
  line?: number;
  /** Short human-readable justification, safe to log (contains no CV prose). */
  why: string;
}

export interface FieldResult {
  value: string;
  confidence: number;
  method: ExtractionSignal;
  /** Runner-up candidates, highest first. Used by the benchmark and for debugging. */
  alternatives?: Array<{ value: string; confidence: number }>;
  why: string;
}

export const NOT_FOUND = "Not Found";

export function emptyField(why: string): FieldResult {
  return { value: NOT_FOUND, confidence: 0, method: "none", why };
}

/**
 * Engine output. The first four keys match `LLMExtraction` exactly so it is a
 * drop-in replacement for the LLM's return value.
 */
export interface LocalExtraction {
  candidate_name: string;
  phone_number: string;
  job_role_applied_for: string;
  confidence: {
    candidate_name: number;
    phone_number: number;
    job_role_applied_for: number;
  };
  /** Per-field provenance — the part an LLM cannot give you. */
  methods: {
    candidate_name: ExtractionSignal;
    phone_number: ExtractionSignal;
    job_role_applied_for: ExtractionSignal;
  };
  /** Short reasons, safe for logs: no candidate PII, no CV prose. */
  evidence: {
    candidate_name: string;
    phone_number: string;
    job_role_applied_for: string;
  };
  engine: "local";
  engineVersion: string;
}

/** Version of the extraction algorithms. Recorded per CV for traceability. */
export const ENGINE_VERSION = "1.0.0";
