import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { listCandidates, getCandidateDetail, updateCandidate, topJobRoles, candidateFiltersSchema } from "@/backend/candidates";
import { getDashboardStats } from "@/backend/stats";
import { listJobs, batchProgress } from "@/backend/jobs";
import { deleteCVs } from "@/backend/delete";
import { workspaceScope } from "@/lib/tenant";
import { ForbiddenError } from "@/lib/errors";
import { makeWorkspace, dropWorkspace, OWNER_SCOPE } from "../helpers/workspace";

/**
 * Cross-tenant isolation.
 *
 * The whole point of client workspaces is that Acme cannot see Bravo, so these
 * assert the negative: every read path, given Acme's scope, must return nothing
 * of Bravo's — and every write path must refuse to touch it.
 *
 * Deliberately written against two real clients holding deliberately similar
 * data (the same candidate name, the same job role, the same file hash, the same
 * batch id), because identical content is exactly the case where a missing
 * filter stops being visible in a diff.
 */
let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
const d = dbUp ? describe : describe.skip;

const TAG = `iso_${Date.now()}`;
const SHARED_BATCH = `batch_${TAG}`;

d("workspace isolation", () => {
  let acme: Awaited<ReturnType<typeof makeWorkspace>>;
  let bravo: Awaited<ReturnType<typeof makeWorkspace>>;
  let acmeCvId = "";
  let bravoCvId = "";

  /** Identical CVs in two clients, down to the content hash and the batch id. */
  async function seed(workspaceId: string, who: string) {
    const cv = await prisma.cVFile.create({
      data: {
        workspaceId,
        sourceType: "MANUAL",
        fileName: `${TAG}_${who}.pdf`,
        mimeType: "application/pdf",
        // The same bytes in both clients: duplicate detection must not treat
        // one client's CV as a duplicate of another's.
        fileHash: sha256Hex(`${TAG}-identical-content`),
        fileSize: 1024,
        storagePath: `test/${TAG}-${who}.pdf`,
        status: "PROCESSED",
      },
    });
    await prisma.candidate.create({
      data: {
        cvFileId: cv.id,
        candidateName: "Rahul Sharma",
        phoneNumber: "+919876543210",
        jobRoleAppliedFor: `${TAG} Java Developer`,
        overallConfidence: 0.9,
        reviewReasons: [],
        processedAt: new Date(),
      },
    });
    await prisma.processingJob.create({
      data: { cvFileId: cv.id, batchId: SHARED_BATCH, status: "PROCESSED", attempts: 1, completedAt: new Date() },
    });
    return cv.id;
  }

  beforeAll(async () => {
    acme = await makeWorkspace("acme");
    bravo = await makeWorkspace("bravo");
    acmeCvId = await seed(acme.id, "acme");
    bravoCvId = await seed(bravo.id, "bravo");
  });

  afterAll(async () => {
    await dropWorkspace(acme.id);
    await dropWorkspace(bravo.id);
    await prisma.$disconnect();
  });

  it("both clients can hold the same file, name and role without colliding", async () => {
    // If the schema still had a global unique on the Drive file id, or the
    // upload path still matched fileHash globally, this fixture could not exist.
    const rows = await prisma.cVFile.findMany({ where: { fileName: { startsWith: TAG } }, select: { workspaceId: true } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.workspaceId)).size).toBe(2);
  });

  it("a listing shows only the caller's own candidates", async () => {
    const seen = await listCandidates(acme.scope, candidateFiltersSchema.parse({ q: TAG }));
    expect(seen.total).toBe(1);
    expect(seen.items[0].id).toBe(acmeCvId);
  });

  it("search cannot reach across clients, even on an exact match", async () => {
    // Both candidates are called "Rahul Sharma" with the same number: the only
    // thing separating them is the scope.
    const byName = await listCandidates(acme.scope, candidateFiltersSchema.parse({ q: "Rahul Sharma" }));
    expect(byName.items.map((i) => i.id)).not.toContain(bravoCvId);

    const byPhone = await listCandidates(acme.scope, candidateFiltersSchema.parse({ q: "9876543210" }));
    expect(byPhone.items.map((i) => i.id)).not.toContain(bravoCvId);
  });

  it("opening another client's candidate by id is a 404, not a peek", async () => {
    await expect(getCandidateDetail(acme.scope, bravoCvId)).rejects.toThrow(/not found/i);
    // ...and the same error a made-up id gives, so ids cannot be probed.
    await expect(getCandidateDetail(acme.scope, "cuid-that-does-not-exist")).rejects.toThrow(/not found/i);
  });

  it("editing another client's candidate is refused", async () => {
    await expect(updateCandidate(acme.scope, bravoCvId, { candidateName: "Tampered Name" })).rejects.toThrow(/not found/i);
    const untouched = await prisma.candidate.findUniqueOrThrow({ where: { cvFileId: bravoCvId } });
    expect(untouched.candidateName).toBe("Rahul Sharma");
    expect(untouched.isManuallyCorrected).toBe(false);
  });

  it("deleting another client's CV deletes nothing", async () => {
    const res = await deleteCVs(acme.scope, { ids: [bravoCvId], ignoreFutureSync: true });
    expect(res.deleted).toBe(0);
    expect(res.notFound).toEqual([bravoCvId]);
    expect(await prisma.cVFile.count({ where: { id: bravoCvId } })).toBe(1);
  });

  it("dashboard totals count only the caller's own CVs", async () => {
    const [a, b] = await Promise.all([getDashboardStats(acme.scope), getDashboardStats(bravo.scope)]);
    expect(a.total).toBe(1);
    expect(b.total).toBe(1);
  });

  it("the role filter does not advertise another client's hiring", async () => {
    const roles = await topJobRoles(bravo.scope, 200);
    // Both clients have a role tagged with TAG; bravo must see exactly its own.
    expect(roles.filter((r) => r.role.startsWith(TAG))).toHaveLength(1);
    expect(roles.find((r) => r.role.startsWith(TAG))?.count).toBe(1);
  });

  it("a guessed batch id returns an empty progress summary, not someone else's", async () => {
    // Both clients used SHARED_BATCH. Knowing the id must not be enough.
    const progress = await batchProgress(acme.scope, SHARED_BATCH);
    expect(progress.total).toBe(1);

    const jobs = await listJobs(acme.scope, { batchId: SHARED_BATCH, page: 1, pageSize: 50 });
    expect(jobs.total).toBe(1);
    expect(jobs.items.every((j) => j.cvFileId === acmeCvId)).toBe(true);
  });

  it("the platform owner sees across clients — the one deliberate exception", async () => {
    const all = await listCandidates(OWNER_SCOPE, candidateFiltersSchema.parse({ q: TAG }));
    expect(all.total).toBe(2);
    expect(all.items.map((i) => i.id).sort()).toEqual([acmeCvId, bravoCvId].sort());
  });

  it("an account with no client is refused rather than shown everything", async () => {
    // The dangerous failure mode: a non-owner whose workspace is null. Returning
    // an empty scope for them would hand over the entire database.
    const orphan = { id: "u", email: "a@b.c", name: "Orphan", role: "RECRUITER" as const, workspaceId: null, workspaceName: null };
    expect(() => workspaceScope(orphan)).toThrow(ForbiddenError);
  });
});
