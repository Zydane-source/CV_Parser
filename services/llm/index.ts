import { env } from "@/lib/config";
import { ProcessingError } from "@/lib/errors";
import { OpenAICompatibleProvider } from "./openai-provider";
import { AnthropicProvider } from "./anthropic-provider";
import { getPrompt, renderPrompt } from "./prompts";
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
  instance = e.LLM_PROVIDER === "anthropic" ? new AnthropicProvider(e.LLM_API_KEY, e.LLM_BASE_URL) : new OpenAICompatibleProvider(e.LLM_API_KEY, e.LLM_BASE_URL);
  return instance;
}

/** For tests: inject a provider. */
export function setLLMProvider(p: LLMProvider | null) {
  instance = p;
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
