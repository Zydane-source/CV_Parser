import { env } from "@/lib/config";
import { ProcessingError } from "@/lib/errors";
import { OpenAICompatibleProvider } from "./openai-provider";
import { AnthropicProvider } from "./anthropic-provider";
import { getPrompt, renderPrompt } from "./prompts";
import { classifyLLMHttpError } from "./error-classify";
import type { LLMProvider, LLMResponse } from "./types";

export type { LLMProvider, LLMExtraction, LLMResponse } from "./types";

let instance: LLMProvider | null = null;

/** Resolve the configured LLM provider (LLM_PROVIDER, LLM_API_KEY, LLM_BASE_URL). */
export function getLLMProvider(): LLMProvider {
  if (instance) return instance;
  const e = env();
  if (!e.LLM_API_KEY) {
    throw new ProcessingError("LLM_API_KEY is not configured. Set LLM_PROVIDER, LLM_API_KEY and LLM_MODEL in .env.", "LLM_NOT_CONFIGURED", false);
  }
  instance =
    e.LLM_PROVIDER === "anthropic"
      ? new AnthropicProvider(e.LLM_API_KEY, e.LLM_BASE_URL)
      : new OpenAICompatibleProvider(e.LLM_API_KEY, e.LLM_BASE_URL, e.APP_URL);
  return instance;
}

/** For tests: inject a provider. */
export function setLLMProvider(p: LLMProvider | null) {
  instance = p;
}

export interface CredentialCheck {
  ok: boolean;
  provider: string;
  model: string;
  /** Human-readable, actionable reason when ok === false. */
  error: string | null;
}

/**
 * Preflight the LLM credentials with one tiny request.
 *
 * Called at worker startup so a missing/invalid key is reported immediately and
 * loudly, instead of every CV failing one by one after the file has already
 * been downloaded and OCR'd.
 */
export async function verifyLLMCredentials(timeoutMs = 20_000): Promise<CredentialCheck> {
  const e = env();
  const base = { provider: e.LLM_PROVIDER, model: e.LLM_MODEL };
  if (!e.LLM_API_KEY) {
    return { ...base, ok: false, error: "LLM_API_KEY is empty. Set LLM_PROVIDER, LLM_API_KEY and LLM_MODEL in .env, then restart the worker." };
  }

  const isAnthropic = e.LLM_PROVIDER === "anthropic";
  const url = isAnthropic
    ? `${(e.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`
    : `${(e.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = e.LLM_API_KEY;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${e.LLM_API_KEY}`;
  }
  const body = isAnthropic
    ? { model: e.LLM_MODEL, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
    : { model: e.LLM_MODEL, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };

  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { ...base, ok: true, error: null };

    const raw = (await res.text()).slice(0, 500);
    const c = classifyLLMHttpError(res.status, raw);
    // Only block on problems that will definitely break every job. A throttle,
    // a transient 5xx, or the probe payload being rejected by an unusual model
    // all mean the credentials themselves are fine, so don't raise a false alarm.
    const BLOCKING = ["LLM_AUTH", "LLM_QUOTA", "LLM_MODEL_NOT_FOUND"];
    if (BLOCKING.includes(c.code)) return { ...base, ok: false, error: c.message };
    return { ...base, ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, ok: false, error: `Could not reach the LLM endpoint ${url}: ${msg}` };
  }
}

export interface ExtractParams {
  cvText: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  promptVersion: string;
  provider?: LLMProvider;
}

/** Render the versioned prompt and call the provider. */
export async function extractWithLLM(params: ExtractParams): Promise<LLMResponse & { promptVersion: string }> {
  const provider = params.provider ?? getLLMProvider();
  const def = getPrompt(params.promptVersion);
  const prompt = renderPrompt(def, params.cvText);
  const res = await provider.extract({
    model: params.model,
    temperature: params.temperature,
    timeoutMs: params.timeoutMs,
    prompt,
    systemPrompt: def.system,
  });
  return { ...res, promptVersion: def.version };
}
