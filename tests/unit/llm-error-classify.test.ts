import { describe, it, expect } from "vitest";
import { classifyLLMHttpError } from "@/services/llm/error-classify";

/**
 * HTTP 429 means two different things at OpenAI. Getting this wrong makes the
 * queue retry a billing problem three times and then report it as a rate limit.
 */
describe("classifyLLMHttpError", () => {
  it("treats an exhausted credit balance as permanent, not a rate limit", () => {
    const body = JSON.stringify({
      error: {
        message: "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
        type: "insufficient_quota",
        param: null,
        code: "credit_balance_exhausted",
      },
    });
    const c = classifyLLMHttpError(429, body);
    expect(c.code).toBe("LLM_QUOTA");
    expect(c.transient).toBe(false);
    expect(c.message).toMatch(/no credits remaining/);
  });

  it("treats a genuine rate limit as transient", () => {
    const body = JSON.stringify({ error: { message: "Rate limit reached for gpt-4o-mini", type: "requests", code: "rate_limit_exceeded" } });
    const c = classifyLLMHttpError(429, body);
    expect(c.code).toBe("LLM_RATE_LIMITED");
    expect(c.transient).toBe(true);
  });

  it("treats OpenAI's classic quota message as permanent", () => {
    const body = JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota" } });
    expect(classifyLLMHttpError(429, body)).toMatchObject({ code: "LLM_QUOTA", transient: false });
  });

  it("treats Anthropic's low credit balance (HTTP 400) as permanent", () => {
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
    expect(classifyLLMHttpError(400, body)).toMatchObject({ code: "LLM_QUOTA", transient: false });
  });

  it("classifies auth, model and server errors", () => {
    expect(classifyLLMHttpError(401, JSON.stringify({ error: { message: "Incorrect API key provided" } }))).toMatchObject({ code: "LLM_AUTH", transient: false });
    expect(classifyLLMHttpError(403, "forbidden")).toMatchObject({ code: "LLM_AUTH", transient: false });
    expect(classifyLLMHttpError(404, JSON.stringify({ error: { message: "The model does not exist" } }))).toMatchObject({ code: "LLM_MODEL_NOT_FOUND", transient: false });
    expect(classifyLLMHttpError(500, "boom")).toMatchObject({ code: "LLM_TRANSIENT", transient: true });
    expect(classifyLLMHttpError(503, "unavailable")).toMatchObject({ code: "LLM_TRANSIENT", transient: true });
  });

  it("surfaces the provider prose instead of raw JSON", () => {
    const c = classifyLLMHttpError(401, JSON.stringify({ error: { message: "Incorrect API key provided: sk-abc***xyz" } }));
    expect(c.message).toContain("Incorrect API key provided");
    expect(c.message).not.toContain("{");
  });

  it("survives a non-JSON body", () => {
    const c = classifyLLMHttpError(502, "<html>Bad Gateway</html>");
    expect(c.transient).toBe(true);
    expect(c.message).toContain("Bad Gateway");
  });
});
