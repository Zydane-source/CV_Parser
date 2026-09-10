import { describe, it, expect } from "vitest";
import { candidateToRow, EXPORT_HEADERS } from "@/services/google-sheets";
import { isSupportedDriveFile, toDriveCvFile, effectiveMime, DRIVE_SUPPORTED_MIMES } from "@/services/google-drive/files";
import { buildCandidateWhere, candidateFiltersSchema } from "@/backend/candidates";
import type { CandidateRow } from "@/backend/candidates";

const baseRow = (over: Partial<CandidateRow> = {}): CandidateRow =>
  ({
    id: "cv1",
    sourceType: "MANUAL",
    sourceFileId: null,
    fileName: "Rahul.pdf",
    mimeType: "application/pdf",
    fileSize: 1000,
    driveUrl: null,
    status: "PROCESSED",
    statusMessage: null,
    createdAt: new Date("2026-09-10T10:00:00Z"),
    updatedAt: new Date("2026-09-10T10:00:00Z"),
    candidate: {
      id: "c1",
      candidateName: "Rahul Sharma",
      phoneNumber: "+919876543210",
      jobRoleAppliedFor: "Java Developer",
      nameConfidence: 0.98,
      phoneConfidence: 0.96,
      roleConfidence: 0.9,
      overallConfidence: 0.951,
      isManuallyCorrected: false,
      correctedFields: [],
      reviewReasons: [],
      extractionMethod: "PDF_TEXT",
      llmModel: "gpt-4o-mini",
      promptVersion: "v1",
      processedAt: new Date("2026-09-10T10:05:00Z"),
      updatedAt: new Date("2026-09-10T10:05:00Z"),
    },
    ...over,
  }) as CandidateRow;

describe("Google Sheets export rows", () => {
  it("has the required columns in order", () => {
    expect([...EXPORT_HEADERS]).toEqual(["Candidate Name", "Phone Number", "Job Role Applied For", "CV File Name", "CV Link", "Source", "Status", "Confidence", "Processed At"]);
  });
  it("maps a manual-upload candidate to a row with an app download link", () => {
    const row = candidateToRow(baseRow(), "https://cv.example.com/");
    expect(row).toEqual(["Rahul Sharma", "+919876543210", "Java Developer", "Rahul.pdf", "https://cv.example.com/api/cv-files/cv1/download", "Manual Upload", "PROCESSED", "0.95", "2026-09-10T10:05:00.000Z"]);
  });
  it("uses the Drive link for Drive files and Not Found for missing candidates", () => {
    const row = candidateToRow(baseRow({ sourceType: "GOOGLE_DRIVE", driveUrl: "https://drive.google.com/file/d/abc/view", candidate: null, status: "FAILED" }), "http://localhost:3000");
    expect(row[0]).toBe("Not Found");
    expect(row[4]).toBe("https://drive.google.com/file/d/abc/view");
    expect(row[5]).toBe("Google Drive");
    expect(row[6]).toBe("FAILED");
    expect(row[7]).toBe("");
  });
});

describe("Google Drive file detection", () => {
  it("accepts supported CV types and ignores unrelated/trashed files", () => {
    expect(isSupportedDriveFile({ mimeType: "application/pdf", name: "a.pdf", trashed: false })).toBe(true);
    expect(isSupportedDriveFile({ mimeType: "image/webp", name: "a.webp", trashed: false })).toBe(true);
    expect(isSupportedDriveFile({ mimeType: "application/vnd.google-apps.document", name: "gdoc", trashed: false })).toBe(true);
    expect(isSupportedDriveFile({ mimeType: "application/vnd.google-apps.spreadsheet", name: "sheet", trashed: false })).toBe(false);
    expect(isSupportedDriveFile({ mimeType: "text/plain", name: "notes.txt", trashed: false })).toBe(false);
    expect(isSupportedDriveFile({ mimeType: "video/mp4", name: "v.mp4", trashed: false })).toBe(false);
    expect(isSupportedDriveFile({ mimeType: "application/pdf", name: "a.pdf", trashed: true })).toBe(false);
    expect(DRIVE_SUPPORTED_MIMES).toContain("application/msword");
  });
  it("maps Drive metadata (id, name, mime, times, url)", () => {
    const f = toDriveCvFile({ id: "f1", name: "Candidate_C.pdf", mimeType: "application/pdf", size: "123", md5Checksum: "abc", createdTime: "2026-09-10T10:00:00Z", modifiedTime: "2026-09-10T11:00:00Z", parents: ["folder1"] });
    expect(f).toMatchObject({ id: "f1", name: "Candidate_C.pdf", mimeType: "application/pdf", size: 123, md5Checksum: "abc", parents: ["folder1"] });
    expect(f.webViewLink).toBe("https://drive.google.com/file/d/f1/view");
    expect(effectiveMime("application/vnd.google-apps.document")).toBe("application/pdf");
    expect(effectiveMime("image/png")).toBe("image/png");
  });
});

describe("candidate search filters", () => {
  it("builds database-backed search across name, phone, role and file name", () => {
    const f = candidateFiltersSchema.parse({ q: "98765 43210", source: "MANUAL", status: "NEEDS_REVIEW", role: "Java", from: "2026-09-01", to: "2026-09-10", page: "2", pageSize: "10" });
    expect(f.page).toBe(2);
    const where = buildCandidateWhere(f);
    expect(where.sourceType).toBe("MANUAL");
    expect(where.status).toBe("NEEDS_REVIEW");
    expect(where.OR).toHaveLength(4);
    expect(JSON.stringify(where.OR)).toContain("+919876543210");
    expect(where.createdAt).toMatchObject({ gte: new Date("2026-09-01") });
    expect((where.createdAt as { lte: Date }).lte.toISOString()).toBe("2026-09-10T23:59:59.999Z");
  });
  it("rejects invalid filter values", () => {
    expect(candidateFiltersSchema.safeParse({ status: "BOGUS" }).success).toBe(false);
    expect(candidateFiltersSchema.safeParse({ pageSize: "1000" }).success).toBe(false);
  });
});
