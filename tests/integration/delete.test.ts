import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { getStorage, buildObjectKey } from "@/services/storage";
import { deleteCVs, getIgnoredDriveFileIds, unignoreDriveFiles } from "@/backend/delete";

/**
 * Deletion touches three stores: the database (with cascades), object storage
 * and the Drive ignore list. Skipped when PostgreSQL is unavailable.
 */
let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
const d = dbUp ? describe : describe.skip;

const TAG = `deltest_${Date.now()}`;

async function makeManualCv(name: string) {
  const bytes = Buffer.from(`${TAG}-${name}-${Math.random()}`);
  const key = buildObjectKey(`${name}.pdf`);
  await getStorage().put(key, bytes, "application/pdf");
  const cv = await prisma.cVFile.create({
    data: {
      sourceType: "MANUAL",
      fileName: `${TAG}_${name}.pdf`,
      mimeType: "application/pdf",
      fileHash: sha256Hex(bytes),
      fileSize: bytes.length,
      storagePath: key,
      status: "PROCESSED",
    },
  });
  await prisma.candidate.create({
    data: { cvFileId: cv.id, candidateName: "Test Person", phoneNumber: "+919876543210", jobRoleAppliedFor: "Tester", processedAt: new Date() },
  });
  await prisma.processingJob.create({ data: { cvFileId: cv.id, status: "PROCESSED", attempts: 1, completedAt: new Date() } });
  return { cv, key };
}

d("deleteCVs", () => {
  const createdDriveIds: string[] = [];

  afterAll(async () => {
    await prisma.cVFile.deleteMany({ where: { fileName: { startsWith: TAG } } });
    if (createdDriveIds.length) await unignoreDriveFiles(createdDriveIds);
    await prisma.$disconnect();
  });

  it("removes the record, its candidate, its jobs and the stored file", async () => {
    const { cv, key } = await makeManualCv("one");
    expect(await getStorage().exists(key)).toBe(true);

    const res = await deleteCVs({ ids: [cv.id], ignoreFutureSync: true });
    expect(res).toMatchObject({ requested: 1, deleted: 1, storageObjectsRemoved: 1, notFound: [] });

    expect(await prisma.cVFile.count({ where: { id: cv.id } })).toBe(0);
    expect(await prisma.candidate.count({ where: { cvFileId: cv.id } })).toBe(0);
    expect(await prisma.processingJob.count({ where: { cvFileId: cv.id } })).toBe(0);
    expect(await getStorage().exists(key)).toBe(false);
  });

  it("deletes many at once and reports ids that do not exist", async () => {
    const a = await makeManualCv("bulk-a");
    const b = await makeManualCv("bulk-b");
    const res = await deleteCVs({ ids: [a.cv.id, b.cv.id, "does-not-exist"], ignoreFutureSync: true });
    expect(res.deleted).toBe(2);
    expect(res.notFound).toEqual(["does-not-exist"]);
    expect(await getStorage().exists(a.key)).toBe(false);
    expect(await getStorage().exists(b.key)).toBe(false);
  });

  it("frees the content hash so the same file can be uploaded again", async () => {
    const { cv } = await makeManualCv("rehash");
    const hash = cv.fileHash;
    expect(await prisma.cVFile.count({ where: { fileHash: hash } })).toBe(1);
    await deleteCVs({ ids: [cv.id], ignoreFutureSync: true });
    // Duplicate detection looks up the hash; with no row left, a re-upload is new.
    expect(await prisma.cVFile.count({ where: { fileHash: hash } })).toBe(0);
  });

  it("unlinks a Drive file without deleting it, and suppresses re-import by default", async () => {
    const driveFileId = `${TAG}_drivefile`;
    createdDriveIds.push(driveFileId);
    const cv = await prisma.cVFile.create({
      data: {
        sourceType: "GOOGLE_DRIVE",
        sourceFileId: driveFileId,
        fileName: `${TAG}_from-drive.pdf`,
        mimeType: "application/pdf",
        fileHash: `md5:${TAG}`,
        fileSize: 10,
        driveUrl: "https://drive.google.com/file/d/x/view",
        status: "PROCESSED",
      },
    });

    const res = await deleteCVs({ ids: [cv.id], ignoreFutureSync: true });
    expect(res).toMatchObject({ deleted: 1, driveUnlinked: 1, driveIgnored: 1, storageObjectsRemoved: 0 });
    expect(await getIgnoredDriveFileIds()).toContain(driveFileId);
  });

  it("can leave a Drive file eligible for re-import", async () => {
    const driveFileId = `${TAG}_drivefile2`;
    const cv = await prisma.cVFile.create({
      data: {
        sourceType: "GOOGLE_DRIVE",
        sourceFileId: driveFileId,
        fileName: `${TAG}_from-drive-2.pdf`,
        mimeType: "application/pdf",
        fileHash: `md5:${TAG}2`,
        fileSize: 10,
        status: "PROCESSED",
      },
    });
    const res = await deleteCVs({ ids: [cv.id], ignoreFutureSync: false });
    expect(res).toMatchObject({ deleted: 1, driveUnlinked: 1, driveIgnored: 0 });
    expect(await getIgnoredDriveFileIds()).not.toContain(driveFileId);
  });

  it("is a no-op for an empty match rather than an error", async () => {
    const res = await deleteCVs({ ids: ["nope-1", "nope-2"], ignoreFutureSync: true });
    expect(res).toMatchObject({ requested: 2, deleted: 0 });
    expect(res.notFound).toEqual(["nope-1", "nope-2"]);
  });
});
