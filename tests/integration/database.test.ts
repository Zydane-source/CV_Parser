import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { updateCandidate, listCandidates, candidateFiltersSchema, getCandidateDetail } from "@/backend/candidates";
import { getDashboardStats } from "@/backend/stats";
import { sha256Hex } from "@/lib/crypto";

/**
 * Real PostgreSQL persistence tests (require DATABASE_URL + a reachable DB).
 * Skipped when the database is not available.
 */
let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
const d = dbUp ? describe : describe.skip;

const TAG = `dbtest_${Date.now()}`;

d("database persistence", () => {
  let cvFileId = "";

  beforeAll(async () => {
    const cv = await prisma.cVFile.create({
      data: { sourceType: "MANUAL", fileName: `${TAG}_Rahul.pdf`, mimeType: "application/pdf", fileHash: sha256Hex(TAG), fileSize: 123, storagePath: `test/${TAG}.pdf`, status: "PROCESSED" },
    });
    cvFileId = cv.id;
    await prisma.candidate.create({
      data: {
        cvFileId,
        candidateName: "Rahul Sharma",
        phoneNumber: "+919876543210",
        jobRoleAppliedFor: "Java Developer",
        nameConfidence: 0.98,
        phoneConfidence: 0.96,
        roleConfidence: 0.61,
        overallConfidence: 0.88,
        reviewReasons: ["Below confidence threshold 0.75: job role confidence 0.61"],
        processedAt: new Date(),
      },
    });
    await prisma.cVFile.update({ where: { id: cvFileId }, data: { status: "NEEDS_REVIEW" } });
    await prisma.processingJob.create({ data: { cvFileId, status: "NEEDS_REVIEW", attempts: 1, completedAt: new Date() } });
  });

  afterAll(async () => {
    await prisma.cVFile.deleteMany({ where: { fileName: { startsWith: TAG } } });
    await prisma.$disconnect();
  });

  it("persists and reads back a candidate with its file and jobs", async () => {
    const detail = await getCandidateDetail(cvFileId);
    expect(detail.candidate?.candidateName).toBe("Rahul Sharma");
    expect(detail.jobs.length).toBe(1);
    expect(detail.status).toBe("NEEDS_REVIEW");
  });

  it("search + filters are database-backed and paginated", async () => {
    const byPhone = await listCandidates(candidateFiltersSchema.parse({ q: "98765 43210", pageSize: 5 }));
    expect(byPhone.items.some((i) => i.id === cvFileId)).toBe(true);
    const byName = await listCandidates(candidateFiltersSchema.parse({ q: "rahul sh" }));
    expect(byName.items.some((i) => i.id === cvFileId)).toBe(true);
    const byFile = await listCandidates(candidateFiltersSchema.parse({ q: TAG }));
    expect(byFile.total).toBe(1);
    const byStatus = await listCandidates(candidateFiltersSchema.parse({ status: "NEEDS_REVIEW", role: "Java", source: "MANUAL" }));
    expect(byStatus.items.some((i) => i.id === cvFileId)).toBe(true);
    const none = await listCandidates(candidateFiltersSchema.parse({ q: TAG, status: "FAILED" }));
    expect(none.total).toBe(0);
    const paged = await listCandidates(candidateFiltersSchema.parse({ q: TAG, page: 2, pageSize: 1 }));
    expect(paged.items.length).toBe(0);
    expect(paged.pages).toBe(1);
  });

  it("manual correction sets is_manually_corrected and clears the review flag", async () => {
    const c = await updateCandidate(cvFileId, { jobRoleAppliedFor: "Senior Java Developer" });
    expect(c.isManuallyCorrected).toBe(true);
    expect(c.correctedFields).toEqual(["jobRoleAppliedFor"]);
    expect(c.roleConfidence).toBe(1);
    expect(c.reviewReasons).toEqual([]);
    const file = await prisma.cVFile.findUnique({ where: { id: cvFileId } });
    expect(file?.status).toBe("PROCESSED");
  });

  it("rejects invalid manual corrections", async () => {
    await expect(updateCandidate(cvFileId, { phoneNumber: "12" })).rejects.toThrow(/Invalid phone/);
    await expect(updateCandidate(cvFileId, { candidateName: "Infosys Ltd" })).rejects.toThrow();
    await expect(updateCandidate("does-not-exist", { candidateName: "X Y" })).rejects.toThrow(/not found/);
  });

  it("normalises a manually entered phone number", async () => {
    const c = await updateCandidate(cvFileId, { phoneNumber: "098765 43211" });
    expect(c.phoneNumber).toBe("+919876543211");
    expect(c.correctedFields.sort()).toEqual(["jobRoleAppliedFor", "phoneNumber"]);
  });

  it("enforces unique Drive file ids (duplicate prevention)", async () => {
    const data = { sourceType: "GOOGLE_DRIVE" as const, sourceFileId: `${TAG}_drive1`, fileName: `${TAG}_drive.pdf`, mimeType: "application/pdf", fileHash: `drive:${TAG}`, fileSize: 1 };
    await prisma.cVFile.create({ data });
    await expect(prisma.cVFile.create({ data })).rejects.toThrow();
  });

  it("dashboard stats aggregate by status", async () => {
    const s = await getDashboardStats();
    expect(s.total).toBeGreaterThanOrEqual(2);
    expect(s.processed + s.needsReview + s.failed + s.pending + s.processing + s.skipped).toBe(s.total);
  });
});
