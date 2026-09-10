import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TesseractOCRProvider } from "@/services/ocr/tesseract-provider";
import { renderPdfPagesToImages } from "@/services/ocr/pdf-render";
import { ensureFixtures, fixture } from "../helpers/fixtures";

/**
 * Real OCR (Tesseract WASM) over generated image / scanned-PDF fixtures.
 * First run downloads ~4 MB of English language data into OCR_CACHE_PATH.
 */
const ocr = new TesseractOCRProvider(process.env.OCR_CACHE_PATH || "./.tesseract-cache");
const opts = { languages: "eng", maxPages: 2 };

beforeAll(ensureFixtures);
afterAll(() => ocr.terminate());

describe("Tesseract OCR provider", () => {
  it("reads text from a PNG image CV", async () => {
    const r = await ocr.extractFromImage(await fixture("image-cv.png"), "image/png", opts);
    expect(r.pagesProcessed).toBe(1);
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.text.replace(/\s+/g, " ")).toMatch(/DEEPAK JOSHI/i);
    expect(r.text.replace(/\s+/g, "")).toContain("9876543211");
    expect(r.text).toMatch(/Accountant/i);
  });

  it("reads JPEG and WEBP inputs (converted internally)", async () => {
    const jpg = await ocr.extractFromImage(await fixture("image-cv.jpg"), "image/jpeg", opts);
    const webp = await ocr.extractFromImage(await fixture("image-cv.webp"), "image/webp", opts);
    expect(jpg.text.replace(/\s+/g, "")).toContain("9876543211");
    expect(webp.text.replace(/\s+/g, "")).toContain("9876543211");
  });

  it("renders scanned PDF pages to images and OCRs them", async () => {
    const pages = await renderPdfPagesToImages(await fixture("scanned.pdf"), 3);
    expect(pages.length).toBe(1);
    expect(pages[0].subarray(0, 4).toString("hex")).toBe("89504e47"); // PNG magic
    const r = await ocr.extractFromScannedPDF(await fixture("scanned.pdf"), opts);
    expect(r.pagesProcessed).toBe(1);
    expect(r.text.replace(/\s+/g, " ")).toMatch(/ROHAN MEHTA/i);
    expect(r.text.replace(/\s+/g, "")).toContain("9000011111");
    expect(r.text).toMatch(/Sales Manager/i);
  });
});
