import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseCV, type PipelineOptions } from "@/services/cv-parser/pipeline";
import { TesseractOCRProvider } from "@/services/ocr/tesseract-provider";
import { setLLMProvider } from "@/services/llm";
import { ensureFixtures, fixture, mimeFor, FIXTURES } from "../helpers/fixtures";

/**
 * The production path: `parseCV` with the local engine, real text extraction and
 * real OCR, and **no LLM provider available at all**.
 *
 * `setLLMProvider` is deliberately pointed at a provider that throws. If any
 * code path still reached for an LLM, these tests would fail loudly rather than
 * silently succeeding because a key happened to be configured in the
 * environment. That is the guarantee the migration is really about.
 */
const ocr = new TesseractOCRProvider(process.env.OCR_CACHE_PATH || "./.tesseract-cache");

const opts = (): PipelineOptions => ({
  ocrMinTextChars: 150,
  ocrMaxPages: 2,
  ocrLanguages: "eng",
  maxCvTextChars: 20000,
  confidenceThreshold: 0.75,
  // Present only to satisfy the interface; the local engine ignores them.
  llmModel: "unused",
  llmTemperature: 0,
  llmTimeoutMs: 1,
  promptVersion: "v1",
  engine: "local",
  ocrProvider: ocr,
});

const exploding = {
  name: "openai" as const,
  extract: async () => {
    throw new Error("the local engine must never call an LLM");
  },
};

beforeAll(async () => {
  await ensureFixtures();
  setLLMProvider(exploding);
});
afterAll(async () => {
  setLLMProvider(null);
  await ocr.terminate();
});

describe("local engine through the real pipeline", () => {
  for (const f of FIXTURES) {
    it(`${f.file} – ${f.description}`, async () => {
      const stages: string[] = [];
      const r = await parseCV(await fixture(f.file), mimeFor(f.file), {
        ...opts(),
        fileName: f.file,
        onStage: (s) => void stages.push(s),
      });

      expect(r.engine).toBe("local");
      expect(r.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(stages).toContain("EXTRACTION");
      expect(stages).not.toContain("LLM_EXTRACTION");
      // No tokens are consumed because no model is called.
      expect(r.usage).toBeUndefined();

      if (f.expected.phone === null) {
        expect(r.phoneNumber).toBe("Not Found");
      } else {
        expect(r.phoneNumber).toBe(f.expected.phone);
      }
      if (f.expected.role === null) {
        expect(r.jobRoleAppliedFor).toBe("Not Found");
      } else {
        expect(r.jobRoleAppliedFor.toLowerCase()).toContain(f.expected.role.toLowerCase().split(" ").slice(-1)[0]);
      }
      if (f.expected.name) {
        expect(r.candidateName.toLowerCase()).toBe(f.expected.name.toLowerCase());
      }
    });
  }

  it("records per-field provenance", async () => {
    const r = await parseCV(await fixture("traditional.pdf"), "application/pdf", { ...opts(), fileName: "Rahul_Sharma_Resume.pdf" });
    expect(r.fieldMethods).toBeDefined();
    expect(r.fieldMethods?.phone_number).toBeTruthy();
    // "Applied For: Java Developer" is an explicit label, and should be reported as one.
    expect(r.fieldMethods?.job_role_applied_for).toBe("explicit_label");
  });

  it("is fast enough for a serverless function", async () => {
    const r = await parseCV(await fixture("traditional.pdf"), "application/pdf", opts());
    // Field extraction only; text extraction and OCR are measured separately.
    expect(r.extractionMs).toBeLessThan(250);
  });

  it("still fails clearly on an unreadable document", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    await expect(parseCV(Buffer.from(await pdf.save()), "application/pdf", opts())).rejects.toThrow(/No readable text/);
  });

  it("flags a low-confidence result for human review instead of asserting it", async () => {
    // no-role.pdf states no applied role at all.
    const r = await parseCV(await fixture("no-role.pdf"), "application/pdf", { ...opts(), fileName: "no-role.pdf" });
    expect(r.jobRoleAppliedFor).toBe("Not Found");
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons.join(" ")).toMatch(/role/i);
  });
});
