/**
 * Classifies LLM provider error bodies.
 *
 * HTTP status alone is not enough: OpenAI returns 429 both for genuine rate
 * limiting (retrying helps) and for an exhausted credit balance (retrying never
 * helps and just delays a clear message to the operator). Anthropic reports low
 * credit as a 400 invalid_request_error. We read the body to tell them apart.
 */
export interface ClassifiedLLMError {
  code: string;
  /** Whether the queue should retry with backoff. */
  transient: boolean;
  /** Clean, operator-facing message (provider prose, not raw JSON). */
  message: string;
}

interface ProviderErrorBody {
  error?: { message?: string; type?: string; code?: string };
}

function parseBody(raw: string): { detail: string; type: string; code: string } {
  try {
    const j = JSON.parse(raw) as ProviderErrorBody;
    return {
      detail: j.error?.message ?? raw,
      type: String(j.error?.type ?? ""),
      code: String(j.error?.code ?? ""),
    };
  } catch {
    return { detail: raw, type: "", code: "" };
  }
}

const QUOTA_MARKERS = /insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|quota|no credits remaining|credit balance is too low|exceeded your current quota/i;

export function classifyLLMHttpError(status: number, raw: string): ClassifiedLLMError {
  const { detail, type, code } = parseBody(raw);
  const haystack = `${type} ${code} ${detail}`;

  // Billing / quota – permanent until the account is topped up.
  if (QUOTA_MARKERS.test(haystack)) {
    return {
      code: "LLM_QUOTA",
      transient: false,
      message: `LLM account has no available credit/quota: ${detail.trim()}`,
    };
  }

  if (status === 401 || status === 403) {
    return { code: "LLM_AUTH", transient: false, message: `LLM API key rejected (HTTP ${status}): ${detail.trim()}` };
  }
  if (status === 404) {
    return { code: "LLM_MODEL_NOT_FOUND", transient: false, message: `Model not found (HTTP 404): ${detail.trim()}` };
  }
  if (status === 400 || status === 422) {
    return { code: "LLM_BAD_REQUEST", transient: false, message: `LLM rejected the request (HTTP ${status}): ${detail.trim()}` };
  }
  if (status === 429) {
    return { code: "LLM_RATE_LIMITED", transient: true, message: `LLM rate limit hit (HTTP 429): ${detail.trim()}` };
  }
  if (status >= 500) {
    return { code: "LLM_TRANSIENT", transient: true, message: `LLM service error (HTTP ${status}): ${detail.trim()}` };
  }
  return { code: "LLM_ERROR", transient: false, message: `LLM API error (HTTP ${status}): ${detail.trim()}` };
}
