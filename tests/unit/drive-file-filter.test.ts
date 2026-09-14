import { describe, it, expect } from "vitest";
import { isSupportedDriveFile } from "@/services/google-drive/files";

/**
 * Regression: a folder that plainly contains CVs reported "Found 0 file(s)".
 *
 * The Drive query asked Google to filter by mime type, so anything Drive
 * mislabelled never reached the app at all. Drive's declared mime is not
 * reliable for uploaded files — a PDF synced from a desktop client, or copied
 * between accounts, is often reported as application/octet-stream.
 *
 * The name now decides when the mime does not. Extraction identifies the real
 * format from magic bytes anyway, so being generous here costs nothing: a
 * genuine non-CV is rejected at parse time with a reason the user can read.
 */
describe("which Drive files count as CVs", () => {
  it("accepts correctly typed files", () => {
    for (const mimeType of [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/vnd.google-apps.document",
    ]) {
      expect(isSupportedDriveFile({ mimeType, name: "cv", trashed: false }), mimeType).toBe(true);
    }
  });

  it("accepts a mislabelled file on its extension — the actual bug", () => {
    // Exactly what Drive reports for many uploaded PDFs.
    expect(isSupportedDriveFile({ mimeType: "application/octet-stream", name: "Rahul_Sharma_Resume.pdf", trashed: false })).toBe(true);
    expect(isSupportedDriveFile({ mimeType: "application/octet-stream", name: "cv.DOCX", trashed: false })).toBe(true);
    expect(isSupportedDriveFile({ mimeType: null, name: "scan.JPG", trashed: false })).toBe(true);
  });

  it("still rejects what the app cannot parse", () => {
    expect(isSupportedDriveFile({ mimeType: "text/csv", name: "candidates.csv", trashed: false })).toBe(false);
    expect(isSupportedDriveFile({ mimeType: "application/zip", name: "cvs.zip", trashed: false })).toBe(false);
    expect(isSupportedDriveFile({ mimeType: "application/octet-stream", name: "notes", trashed: false })).toBe(false);
  });

  it("never treats a folder as a CV", () => {
    expect(isSupportedDriveFile({ mimeType: "application/vnd.google-apps.folder", name: "CV_Test 2", trashed: false })).toBe(false);
  });

  it("ignores trashed files whatever they are called", () => {
    expect(isSupportedDriveFile({ mimeType: "application/pdf", name: "old.pdf", trashed: true })).toBe(false);
  });
});
