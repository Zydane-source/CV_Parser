import { z } from "zod";

/** JSON schema the model must return (also used as JSON-schema for providers that enforce it). */
export const llmExtractionSchema = z.object({
  candidate_name: z.string().default("Not Found"),
  phone_number: z.string().default("Not Found"),
  job_role_applied_for: z.string().default("Not Found"),
  confidence: z
    .object({
      candidate_name: z.number().min(0).max(1).default(0),
      phone_number: z.number().min(0).max(1).default(0),
      job_role_applied_for: z.number().min(0).max(1).default(0),
    })
    .default({ candidate_name: 0, phone_number: 0, job_role_applied_for: 0 }),
});

export type LLMExtraction = z.infer<typeof llmExtractionSchema>;

/** JSON Schema (draft-07 style) equivalent, used for provider-side schema enforcement. */
export const LLM_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidate_name: { type: "string", description: 'Candidate full name or "Not Found"' },
    phone_number: { type: "string", description: 'Candidate primary phone number or "Not Found"' },
    job_role_applied_for: { type: "string", description: 'Job role applied for or "Not Found"' },
    confidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        candidate_name: { type: "number", minimum: 0, maximum: 1 },
        phone_number: { type: "number", minimum: 0, maximum: 1 },
        job_role_applied_for: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["candidate_name", "phone_number", "job_role_applied_for"],
    },
  },
  required: ["candidate_name", "phone_number", "job_role_applied_for", "confidence"],
} as const;

export interface LLMRequestOptions {
  model: string;
  temperature: number;
  timeoutMs: number;
  /** Rendered prompt (with CV text inserted). */
  prompt: string;
  systemPrompt?: string;
}

export interface LLMResponse {
  extraction: LLMExtraction;
  model: string;
  /** Raw JSON text returned by the model (for debugging – never logged with CV text). */
  raw: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LLMProvider {
  readonly name: "openai" | "anthropic";
  extract(opts: LLMRequestOptions): Promise<LLMResponse>;
}

/**
 * Tolerant JSON extraction: strips code fences and finds the outermost object
 * even if the model added prose despite instructions.
 */
export function parseExtractionJson(raw: string): LLMExtraction {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) throw new Error("LLM response did not contain a JSON object");
  const candidate = text.slice(first, last + 1);
  const parsed = JSON.parse(candidate);
  return llmExtractionSchema.parse(parsed);
}
