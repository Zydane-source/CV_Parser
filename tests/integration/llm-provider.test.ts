import { describe, it, expect, beforeAll } from "vitest";
import { getLLMProvider, extractWithLLM } from "@/services/llm";
import { OpenAICompatibleProvider } from "@/services/llm/openai-provider";
import { AnthropicProvider } from "@/services/llm/anthropic-provider";
import { validateExtraction } from "@/services/cv-parser/validate";
import { extractDocumentText } from "@/services/text-extraction";
import { normalizeText } from "@/services/cv-parser/normalize";
import { ensureFixtures, fixture } from "../helpers/fixtures";

/**
 * Real LLM provider tests. They run only when LLM_API_KEY is configured;
 * otherwise they are skipped (reported as skipped, never faked).
 */
const hasKey = Boolean(process.env.LLM_API_KEY);
const describeLive = hasKey ? describe : describe.skip;

describe("LLM provider wiring", () => {
  it("throws a clear error when LLM_API_KEY is missing", async () => {
    if (hasKey) return;
    const { resetEnvCache } = await import("@/lib/config");
    const { setLLMProvider } = await import("@/services/llm");
    setLLMProvider(null);
    resetEnvCache();
    expect(() => getLLMProvider()).toThrow(/LLM_API_KEY is not configured/);
  });

  it("classifies HTTP errors as transient/permanent (mocked fetch, provider logic is real)", async () => {
    const provider = new OpenAICompatibleProvider("k", "https://llm.invalid/v1");
    const realFetch = globalThis.fetch;
    const answers = [429, 401, 500, 400];
    globalThis.fetch = (async () => {
      const status = answers.shift() ?? 200;
      return new Response(status === 400 ? "unsupported response_format" : "err", { status });
    }) as typeof fetch;
    try {
      const opts = { model: "m", temperature: 0, timeoutMs: 5000, prompt: "p" };
      await expect(provider.extract(opts)).rejects.toMatchObject({ code: "LLM_TRANSIENT", transient: true });
      await expect(provider.extract(opts)).rejects.toMatchObject({ code: "LLM_AUTH", transient: false });
      await expect(provider.extract(opts)).rejects.toMatchObject({ code: "LLM_TRANSIENT", transient: true });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("falls back from json_schema to json_object when the endpoint rejects strict schema", async () => {
    const provider = new OpenAICompatibleProvider("k", "https://llm.invalid/v1");
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push(body.response_format?.type ?? "none");
      if (body.response_format?.type === "json_schema") return new Response("response_format not supported", { status: 400 });
      const content = JSON.stringify({ candidate_name: "Rahul Sharma", phone_number: "9876543210", job_role_applied_for: "Java Developer", confidence: { candidate_name: 0.9, phone_number: 0.9, job_role_applied_for: 0.9 } });
      return new Response(JSON.stringify({ model: "m", choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const r = await provider.extract({ model: "m", temperature: 0, timeoutMs: 5000, prompt: "p" });
      expect(seen).toEqual(["json_schema", "json_object"]);
      expect(r.extraction.candidate_name).toBe("Rahul Sharma");
      expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("Anthropic provider reads tool_use output", async () => {
    const provider = new AnthropicProvider("k", "https://llm.invalid");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tool_choice).toEqual({ type: "tool", name: "record_cv_extraction" });
      return new Response(
        JSON.stringify({
          model: "claude",
          content: [{ type: "tool_use", name: "record_cv_extraction", input: { candidate_name: "Priya Verma", phone_number: "9123456780", job_role_applied_for: "Data Analyst", confidence: { candidate_name: 0.95, phone_number: 0.9, job_role_applied_for: 0.8 } } }],
          usage: { input_tokens: 20, output_tokens: 8 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const r = await provider.extract({ model: "claude", temperature: 0, timeoutMs: 5000, prompt: "p" });
      expect(r.extraction.job_role_applied_for).toBe("Data Analyst");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describeLive("live LLM extraction (LLM_API_KEY set)", () => {
  beforeAll(ensureFixtures);

  const run = async (file: string) => {
    const ext = await extractDocumentText(await fixture(file), "application/pdf", { minTextChars: 200 });
    const text = normalizeText(ext.text, 20000);
    const res = await extractWithLLM({
      cvText: text,
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      temperature: 0,
      timeoutMs: 60000,
      promptVersion: "v1",
    });
    return validateExtraction(res.extraction, { threshold: 0.75, cvText: text });
  };

  it("extracts name, phone and applied role from a traditional CV", async () => {
    const v = await run("traditional.pdf");
    expect(v.candidateName).toBe("Rahul Sharma");
    expect(v.phoneNumber).toBe("+919876543210");
    expect(v.jobRoleAppliedFor.toLowerCase()).toContain("java developer");
  });

  it("returns Not Found for a missing phone and does not invent one", async () => {
    const v = await run("no-phone.pdf");
    expect(v.phoneNumber).toBe("Not Found");
    expect(v.candidateName).toBe("Neha Gupta");
  });

  it("selects the candidate's own number among several", async () => {
    const v = await run("multi-phone.pdf");
    expect(v.phoneNumber).toBe("+919811122233");
  });
});
