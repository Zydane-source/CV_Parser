import { ProcessingError } from "@/lib/errors";
import { LLM_EXTRACTION_JSON_SCHEMA, parseExtractionJson, type LLMProvider, type LLMRequestOptions, type LLMResponse } from "./types";

/**
 * OpenAI-compatible Chat Completions provider.
 * Works with OpenAI, Azure OpenAI (via base URL), Groq, OpenRouter, Together,
 * Ollama, vLLM, LM Studio – anything exposing POST {base}/chat/completions.
 *
 * Structured output: tries `response_format: json_schema` (strict) first; if the
 * endpoint rejects it (400), falls back to `json_object`, then to plain parsing.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai" as const;
  private apiKey: string;
  private baseUrl: string;
  private supportsJsonSchema: boolean | null = null;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  private async call(opts: LLMRequestOptions, mode: "json_schema" | "json_object" | "none"): Promise<Response> {
    const body: Record<string, unknown> = {
      model: opts.model,
      temperature: opts.temperature,
      messages: [
        ...(opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []),
        { role: "user", content: opts.prompt },
      ],
    };
    if (mode === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "cv_extraction", strict: true, schema: LLM_EXTRACTION_JSON_SCHEMA },
      };
    } else if (mode === "json_object") {
      body.response_format = { type: "json_object" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async extract(opts: LLMRequestOptions): Promise<LLMResponse> {
    const modes: Array<"json_schema" | "json_object" | "none"> =
      this.supportsJsonSchema === false ? ["json_object", "none"] : ["json_schema", "json_object", "none"];

    let lastErr: unknown;
    for (const mode of modes) {
      let res: Response;
      try {
        res = await this.call(opts, mode);
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        throw new ProcessingError(
          name === "AbortError" ? `LLM request timed out after ${opts.timeoutMs}ms` : `LLM request failed: ${err instanceof Error ? err.message : String(err)}`,
          "LLM_NETWORK",
          true,
        );
      }

      if (res.status === 400 && mode !== "none") {
        // Endpoint doesn't support this response_format – downgrade and retry.
        if (mode === "json_schema") this.supportsJsonSchema = false;
        lastErr = new Error(`response_format ${mode} rejected: ${await safeText(res)}`);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        throw new ProcessingError(`LLM API error ${res.status}: ${await safeText(res)}`, "LLM_TRANSIENT", true);
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProcessingError("LLM API key rejected (401/403). Check LLM_API_KEY.", "LLM_AUTH", false);
      }
      if (!res.ok) {
        throw new ProcessingError(`LLM API error ${res.status}: ${await safeText(res)}`, "LLM_ERROR", false);
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }>; refusal?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const msg = json.choices?.[0]?.message;
      if (msg?.refusal) throw new ProcessingError(`LLM refused: ${msg.refusal}`, "LLM_REFUSAL", false);
      const content = Array.isArray(msg?.content) ? msg.content.map((c) => c.text ?? "").join("") : (msg?.content ?? "");
      if (!content) throw new ProcessingError("LLM returned an empty response", "LLM_EMPTY", true);

      try {
        const extraction = parseExtractionJson(content);
        return {
          extraction,
          model: json.model ?? opts.model,
          raw: content,
          usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
        };
      } catch (err) {
        lastErr = err;
        if (mode === "none") break;
      }
    }
    throw new ProcessingError(`LLM returned invalid JSON: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`, "LLM_INVALID_JSON", true);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
