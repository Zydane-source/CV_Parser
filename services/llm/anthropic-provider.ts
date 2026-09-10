import { ProcessingError } from "@/lib/errors";
import { classifyLLMHttpError } from "./error-classify";
import { LLM_EXTRACTION_JSON_SCHEMA, llmExtractionSchema, parseExtractionJson, type LLMProvider, type LLMRequestOptions, type LLMResponse } from "./types";

/**
 * Anthropic Messages API provider. Schema enforcement is achieved by forcing a
 * tool call whose input_schema is our extraction schema, so the model can only
 * answer with a valid JSON object.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  }

  async extract(opts: LLMRequestOptions): Promise<LLMResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 512,
          temperature: opts.temperature,
          system: opts.systemPrompt,
          tools: [
            {
              name: "record_cv_extraction",
              description: "Record the extracted CV fields.",
              input_schema: LLM_EXTRACTION_JSON_SCHEMA,
            },
          ],
          tool_choice: { type: "tool", name: "record_cv_extraction" },
          messages: [{ role: "user", content: opts.prompt }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      throw new ProcessingError(
        name === "AbortError" ? `LLM request timed out after ${opts.timeoutMs}ms` : `LLM request failed: ${err instanceof Error ? err.message : String(err)}`,
        "LLM_NETWORK",
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // 529 = Anthropic "overloaded"; low credit balance arrives as a 400 with an
      // invalid_request_error, so classification reads the body, not just status.
      const raw = (await res.text()).slice(0, 500);
      if (res.status === 529) throw new ProcessingError(`LLM service overloaded (HTTP 529): ${raw}`, "LLM_TRANSIENT", true);
      const c = classifyLLMHttpError(res.status, raw);
      throw new ProcessingError(c.message, c.code, c.transient);
    }

    const json = (await res.json()) as {
      model?: string;
      content?: Array<{ type: string; text?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const tool = json.content?.find((c) => c.type === "tool_use");
    let extraction;
    let raw: string;
    if (tool?.input) {
      raw = JSON.stringify(tool.input);
      try {
        extraction = llmExtractionSchema.parse(tool.input);
      } catch (err) {
        throw new ProcessingError(`LLM returned invalid schema: ${err instanceof Error ? err.message : String(err)}`, "LLM_INVALID_JSON", true);
      }
    } else {
      raw = json.content?.map((c) => c.text ?? "").join("") ?? "";
      if (!raw) throw new ProcessingError("LLM returned an empty response", "LLM_EMPTY", true);
      try {
        extraction = parseExtractionJson(raw);
      } catch (err) {
        throw new ProcessingError(`LLM returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`, "LLM_INVALID_JSON", true);
      }
    }
    return {
      extraction,
      model: json.model ?? opts.model,
      raw,
      usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens },
    };
  }
}
