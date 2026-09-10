import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseCV, type PipelineOptions } from "@/services/cv-parser/pipeline";
import { TesseractOCRProvider } from "@/services/ocr/tesseract-provider";
import { ensureFixtures, fixture, mimeFor, FIXTURES } from "../helpers/fixtures";
import { HeuristicLLM, ScriptedLLM } from "../helpers/fake-llm";

/**
 * Unified pipeline over every CV variation: real text extraction + real OCR,
 * with a deterministic test LLM so results are reproducible offline.
 * (The real LLM providers are exercised in llm-provider.test.ts when a key is set.)
 */
const ocr = new TesseractOCRProvider(process.env.OCR_CACHE_PATH || "./.tesseract-cache");
const base = (llm: PipelineOptions["llmProvider"]): PipelineOptions => ({
  ocrMinTextChars: 150,
  ocrMaxPages: 2,
  ocrLanguages: "eng",
  maxCvTextChars: 20000,
  confidenceThreshold: 0.75,
  llmModel: "test",
  llmTemperature: 0,
  llmTimeoutMs: 10000,
  promptVersion: "v1",
  llmProvider: llm,
  ocrProvider: ocr,
});

beforeAll(ensureFixtures);
afterAll(() => ocr.terminate());

describe("parseCV across real-world CV variations", () => {
  for (const f of FIXTURES) {
    it(`${f.file} – ${f.description}`, async () => {
      const stages: string[] = [];
      const llm = new HeuristicLLM();
      const r = await parseCV(await fixture(f.file), mimeFor(f.file), { ...base(llm), onStage: (s) => void stages.push(s) });

      expect(llm.calls).toBe(1); // exactly one LLM call per CV
      expect(stages).toContain("TEXT_EXTRACTION");
      expect(stages).toContain("LLM_EXTRACTION");
      expect(stages).toContain("VALIDATION");

      // Never hallucinate: missing fields must come back as "Not Found".
      if (f.expected.phone === null) {
        expect(r.phoneNumber).toBe("Not Found");
        expect(r.phoneConfidence).toBe(0);
        expect(r.needsReview).toBe(true);
      } else {
        expect(r.phoneNumber).toBe(f.expected.phone);
      }
      if (f.expected.role === null) {
        expect(r.jobRoleAppliedFor).toBe("Not Found");
        expect(r.needsReview).toBe(true);
      } else {
        expect(r.jobRoleAppliedFor.toLowerCase()).toBe(f.expected.role!.toLowerCase());
      }
      if (f.expected.name) expect(r.candidateName.toLowerCase()).toBe(f.expected.name.toLowerCase());

      if (/scanned|image-cv/.test(f.file)) {
        expect(stages).toContain("OCR");
        expect(r.extractionMethod).toMatch(/^OCR_/);
        expect(r.ocrConfidence).toBeGreaterThan(0.5);
      } else {
        expect(stages).not.toContain("OCR");
      }
      expect(r.overallConfidence).toBeGreaterThanOrEqual(0);
      expect(r.overallConfidence).toBeLessThanOrEqual(1);
    });
  }

  it("multiple phone numbers: picks the candidate's own mobile, not the reference's", async () => {
    const r = await parseCV(await fixture("multi-phone.pdf"), "application/pdf", base(new HeuristicLLM()));
    expect(r.phoneNumber).toBe("+919811122233");
    expect(r.phoneNumber).not.toBe("+919899988877");
  });

  it("references: does not return a referee's name or number", async () => {
    const r = await parseCV(await fixture("references.pdf"), "application/pdf", base(new HeuristicLLM()));
    expect(r.candidateName).toBe("Karan Malhotra");
    expect(r.phoneNumber).toBe("+919700012345");
  });
});

describe("validation layer guards LLM output", () => {
  it("rejects a hallucinated phone number that is not in the CV", async () => {
    const llm = new ScriptedLLM([{ candidate_name: "Rahul Sharma", phone_number: "9000000000", job_role_applied_for: "Java Developer", confidence: { candidate_name: 0.99, phone_number: 0.99, job_role_applied_for: 0.99 } }]);
    const r = await parseCV(await fixture("traditional.pdf"), "application/pdf", base(llm));
    expect(r.phoneConfidence).toBeLessThanOrEqual(0.4);
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons.join(" ")).toMatch(/could not be verified/);
  });

  it("rejects a company as candidate name and a generic role", async () => {
    const llm = new ScriptedLLM([{ candidate_name: "Infosys Ltd", phone_number: "+91 98765 43210", job_role_applied_for: "Job Seeker", confidence: { candidate_name: 0.9, phone_number: 0.9, job_role_applied_for: 0.9 } }]);
    const r = await parseCV(await fixture("traditional.pdf"), "application/pdf", base(llm));
    expect(r.candidateName).toBe("Not Found");
    expect(r.jobRoleAppliedFor).toBe("Not Found");
    expect(r.phoneNumber).toBe("+919876543210");
    expect(r.needsReview).toBe(true);
  });

  it("flags low confidence (0.61) as needs review while keeping the value", async () => {
    const llm = new ScriptedLLM([{ candidate_name: "Rahul Sharma", phone_number: "+91 98765 43210", job_role_applied_for: "Java Developer", confidence: { candidate_name: 0.98, phone_number: 0.96, job_role_applied_for: 0.61 } }]);
    const r = await parseCV(await fixture("traditional.pdf"), "application/pdf", base(llm));
    expect(r.jobRoleAppliedFor).toBe("Java Developer");
    expect(r.roleConfidence).toBe(0.61);
    expect(r.needsReview).toBe(true);
  });

  it("propagates LLM errors (so the queue can retry transient ones)", async () => {
    const { ProcessingError } = await import("@/lib/errors");
    const llm = new ScriptedLLM([new ProcessingError("rate limited", "LLM_TRANSIENT", true)]);
    await expect(parseCV(await fixture("traditional.pdf"), "application/pdf", base(llm))).rejects.toThrow(/rate limited/);
  });

  it("fails clearly on documents with no readable text (no LLM call)", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    const blank = Buffer.from(await pdf.save());
    const llm = new HeuristicLLM();
    await expect(parseCV(blank, "application/pdf", base(llm))).rejects.toThrow(/No readable text/);
    expect(llm.calls).toBe(0);
  });
});
