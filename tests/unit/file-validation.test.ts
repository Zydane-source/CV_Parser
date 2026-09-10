import { describe, it, expect } from "vitest";
import { validateUploadedFile, sanitizeFileName, detectMimeType, isSupportedFileName } from "@/services/cv-parser/file-validation";
import { fixture } from "../helpers/fixtures";

const MAX = 15 * 1024 * 1024;

describe("file validation", () => {
  it("sanitises file names", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName('bad<>:"|?*name.pdf')).toBe("bad_______name.pdf");
    expect(sanitizeFileName("")).toBe("cv");
    expect(sanitizeFileName("Rahul Sharma - CV.pdf")).toBe("Rahul Sharma - CV.pdf");
  });

  it("recognises supported extensions only", () => {
    expect(isSupportedFileName("a.PDF")).toBe(true);
    expect(isSupportedFileName("a.docx")).toBe(true);
    expect(isSupportedFileName("a.webp")).toBe(true);
    expect(isSupportedFileName("a.exe")).toBe(false);
    expect(isSupportedFileName("a.txt")).toBe(false);
  });

  it("detects real MIME types from magic bytes", async () => {
    expect(await detectMimeType(await fixture("traditional.pdf"), "x.pdf")).toBe("application/pdf");
    expect(await detectMimeType(await fixture("cv.docx"), "x.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(await detectMimeType(await fixture("image-cv.png"), "x.png")).toBe("image/png");
    expect(await detectMimeType(await fixture("image-cv.jpg"), "x.jpg")).toBe("image/jpeg");
    expect(await detectMimeType(await fixture("image-cv.webp"), "x.webp")).toBe("image/webp");
  });

  it("accepts valid files", async () => {
    const v = await validateUploadedFile(await fixture("traditional.pdf"), "Rahul.pdf", MAX);
    expect(v).toEqual({ fileName: "Rahul.pdf", mimeType: "application/pdf", size: expect.any(Number) });
  });

  it("rejects executables disguised with a document extension", async () => {
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0x90)]);
    await expect(validateUploadedFile(exe, "malware.pdf", MAX)).rejects.toThrow(/does not match/);
  });

  it("rejects a PDF renamed as .docx (extension/content mismatch)", async () => {
    await expect(validateUploadedFile(await fixture("traditional.pdf"), "cv.docx", MAX)).rejects.toThrow(/does not match its extension/);
  });

  it("rejects an image renamed as .pdf", async () => {
    await expect(validateUploadedFile(await fixture("image-cv.png"), "cv.pdf", MAX)).rejects.toThrow(/does not match/);
  });

  it("rejects unsupported types, empty and oversized files", async () => {
    await expect(validateUploadedFile(Buffer.from("hello"), "notes.txt", MAX)).rejects.toThrow(/Unsupported file type/);
    await expect(validateUploadedFile(Buffer.alloc(0), "empty.pdf", MAX)).rejects.toThrow(/empty/);
    await expect(validateUploadedFile(await fixture("traditional.pdf"), "big.pdf", 100)).rejects.toThrow(/too large/);
  });
});
