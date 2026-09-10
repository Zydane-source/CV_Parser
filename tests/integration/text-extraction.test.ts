import { describe, it, expect, beforeAll } from "vitest";
import { extractDocumentText, isTextUsable, countMeaningfulChars } from "@/services/text-extraction";
import { ensureFixtures, fixture, mimeFor } from "../helpers/fixtures";

/**
 * Real text extraction over generated CV fixtures (pdf.js, mammoth). No mocks.
 */
beforeAll(ensureFixtures);

describe("PDF text extraction", () => {
  it("extracts a traditional single-column CV", async () => {
    const r = await extractDocumentText(await fixture("traditional.pdf"), "application/pdf", { minTextChars: 200 });
    expect(r.method).toBe("PDF_TEXT");
    expect(r.needsOcr).toBe(false);
    expect(r.text).toContain("RAHUL SHARMA");
    expect(r.text).toContain("+91 98765 43210");
    expect(r.text).toContain("Applied For: Java Developer");
  });

  it("keeps two-column content readable (both columns present)", async () => {
    const r = await extractDocumentText(await fixture("two-column.pdf"), "application/pdf", { minTextChars: 200 });
    expect(r.needsOcr).toBe(false);
    expect(r.text).toContain("AMIT KUMAR");
    expect(r.text).toContain("+91-9988776655");
    expect(r.text).toContain("Frontend Developer");
  });

  it("extracts cell text from tables", async () => {
    const r = await extractDocumentText(await fixture("table.pdf"), "application/pdf", { minTextChars: 100 });
    expect(r.text).toContain("Sneha Reddy");
    expect(r.text).toContain("09876501234");
    expect(r.text).toContain("HR Executive");
  });

  it("extracts text from a CV containing an embedded image", async () => {
    const r = await extractDocumentText(await fixture("with-image.pdf"), "application/pdf", { minTextChars: 100 });
    expect(r.needsOcr).toBe(false);
    expect(r.text).toContain("Arjun Patel");
    expect(r.text).toContain("Mechanical Engineer");
  });

  it("detects a scanned (image-only) PDF and flags OCR", async () => {
    const r = await extractDocumentText(await fixture("scanned.pdf"), "application/pdf", { minTextChars: 200 });
    expect(r.method).toBe("PDF_TEXT");
    expect(r.needsOcr).toBe(true);
    expect(countMeaningfulChars(r.text)).toBeLessThan(20);
    expect(r.pageCount).toBe(1);
  });
});

describe("DOCX extraction", () => {
  it("extracts paragraphs from a DOCX CV", async () => {
    const r = await extractDocumentText(await fixture("cv.docx"), mimeFor("cv.docx"), { minTextChars: 100 });
    expect(r.method).toBe("DOCX");
    expect(r.needsOcr).toBe(false);
    expect(r.text).toContain("Meera Iyer");
    expect(r.text).toContain("+91 99887 76655");
    expect(r.text).toContain("Position Applied: Business Analyst");
  });
});

describe("Images", () => {
  it("always routes images to OCR", async () => {
    const r = await extractDocumentText(await fixture("image-cv.png"), "image/png", { minTextChars: 100 });
    expect(r.needsOcr).toBe(true);
    expect(r.method).toBe("NONE");
  });
  it("rejects unsupported MIME types", async () => {
    await expect(extractDocumentText(Buffer.from("x"), "text/plain", { minTextChars: 1 })).rejects.toThrow(/Unsupported MIME/);
  });
});

describe("isTextUsable heuristic", () => {
  it("rejects sparse or symbol-heavy text layers", () => {
    expect(isTextUsable("", 1, 200)).toBe(false);
    expect(isTextUsable("a".repeat(50), 1, 200)).toBe(false);
    expect(isTextUsable("###$$$%%%^^^&&&***".repeat(30) + "abc", 1, 20)).toBe(false);
    expect(isTextUsable("Rahul Sharma Java Developer ".repeat(20), 1, 200)).toBe(true);
    expect(isTextUsable("Rahul Sharma Java Developer ".repeat(20), 10, 200)).toBe(false); // 10 pages, tiny text per page
  });
});
