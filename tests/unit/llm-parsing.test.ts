import { describe, it, expect } from "vitest";
import { parseExtractionJson } from "@/services/llm/types";
import { getPrompt, renderPrompt, availablePromptVersions } from "@/services/llm/prompts";
import { isTransientError, ProcessingError, AppError } from "@/lib/errors";

describe("parseExtractionJson", () => {
  const obj = { candidate_name: "A B", phone_number: "9876543210", job_role_applied_for: "Tester", confidence: { candidate_name: 0.9, phone_number: 0.9, job_role_applied_for: 0.8 } };
  it("parses clean JSON", () => {
    expect(parseExtractionJson(JSON.stringify(obj))).toEqual(obj);
  });
  it("tolerates code fences and prose around the object", () => {
    expect(parseExtractionJson("Sure! ```json\n" + JSON.stringify(obj) + "\n```")).toEqual(obj);
    expect(parseExtractionJson("Here is the result: " + JSON.stringify(obj) + " Hope this helps.")).toEqual(obj);
  });
  it("applies defaults for missing keys", () => {
    const r = parseExtractionJson('{"candidate_name":"X Y"}');
    expect(r.phone_number).toBe("Not Found");
    expect(r.confidence.candidate_name).toBe(0);
  });
  it("throws on non-JSON", () => {
    expect(() => parseExtractionJson("no json here")).toThrow();
    expect(() => parseExtractionJson('{"confidence":{"candidate_name":5}}')).toThrow();
  });
});

describe("prompts", () => {
  it("renders the versioned prompt with CV text and no leftover placeholder", () => {
    const def = getPrompt("v1");
    const rendered = renderPrompt(def, "RAHUL SHARMA\nMobile 9876543210");
    expect(rendered).toContain("RAHUL SHARMA");
    expect(rendered).not.toContain("{{CV_TEXT}}");
    expect(rendered).toContain("Never hallucinate");
    expect(availablePromptVersions()).toContain("v1");
  });
  it("rejects unknown versions", () => {
    expect(() => getPrompt("v99")).toThrow(/Unknown prompt version/);
  });
});

describe("isTransientError", () => {
  it("classifies transient vs permanent", () => {
    expect(isTransientError(new ProcessingError("rate limited", "LLM_TRANSIENT", true))).toBe(true);
    expect(isTransientError(new ProcessingError("bad key", "LLM_AUTH", false))).toBe(false);
    expect(isTransientError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isTransientError(new Error("Request timed out"))).toBe(true);
    expect(isTransientError(new AppError("nope", { status: 400 }))).toBe(false);
    expect(isTransientError(new Error("PDF is password protected"))).toBe(false);
  });
});
