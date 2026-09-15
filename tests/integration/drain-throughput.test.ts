import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Serverless processing: stuck-job recovery, parallel draining, and background
 * chains. The CV pipeline itself is replaced with a timed stand-in, so these
 * measure the scheduling — who claims what, how many at once, and when it
 * stops — against the real database.
 */
const processed: string[] = [];
const PARSE_MS = 150;
vi.mock("@/services/processing/processor", () => ({
  processCVJob: async (data: { cvFileId: string; processingJobId: string }) => {
    processed.push(data.processingJobId);
    await new Promise((r) => setTimeout(r, PARSE_MS));
    const { prisma: db } = await import("@/lib/db");
    await db.processingJob.update({ where: { id: data.processingJobId }, data: { status: "PROCESSED", stage: null, completedAt: new Date() } });
  },
}));

process.env.PROCESSING_MODE = "inline";
process.env.CRON_SECRET = "test-cron-secret-0123456789";
const { resetEnvCache } = await import("@/lib/config");
resetEnvCache();
const { drainPendingJobs, recoverStaleJobs } = await import("@/services/processing/drain");
const { kickBackgroundDrain, activeChains } = await import("@/services/processing/background");
const { makeWorkspace, dropWorkspace } = await import("../helpers/workspace");

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
const d = dbUp ? describe : describe.skip;

const TAG = `drain${Date.now().toString(36)}`;

d("serverless processing", () => {
  let wsId = "";

  async function makeJobs(n: number, data: Partial<{ status: "PENDING" | "PROCESSING"; startedAt: Date; attempts: number; maxAttempts: number }> = {}) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const cv = await prisma.cVFile.create({
        data: { workspaceId: wsId, sourceType: "MANUAL", fileName: `${TAG}-${ids.length}-${Math.random()}.pdf`, mimeType: "application/pdf", fileHash: `${TAG}${Math.random()}`, fileSize: 1, status: data.status ?? "PENDING" },
      });
      const job = await prisma.processingJob.create({ data: { cvFileId: cv.id, status: "PENDING", maxAttempts: 3, ...data } });
      ids.push(job.id);
    }
    return ids;
  }

  beforeAll(async () => {
    // Other suites' leftovers must not be claimed by these drains.
    await prisma.processingJob.updateMany({ where: { status: { in: ["PENDING", "PROCESSING"] } }, data: { status: "SKIPPED" } });
    wsId = (await makeWorkspace("drain")).id;
  });

  beforeEach(async () => {
    processed.length = 0;
    await prisma.setting.deleteMany({ where: { key: "drain:chains" } });
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: "drain:chains" } });
    await dropWorkspace(wsId);
    await prisma.$disconnect();
  });

  it("returns a CV stranded in PROCESSING to the queue, and fails it once attempts are spent", async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const [retryable] = await makeJobs(1, { status: "PROCESSING", startedAt: old, attempts: 1 });
    const [exhausted] = await makeJobs(1, { status: "PROCESSING", startedAt: old, attempts: 3 });
    const [fresh] = await makeJobs(1, { status: "PROCESSING", startedAt: new Date(), attempts: 1 });

    expect(await recoverStaleJobs()).toBe(2);
    expect((await prisma.processingJob.findUniqueOrThrow({ where: { id: retryable } })).status).toBe("PENDING");
    const failed = await prisma.processingJob.findUniqueOrThrow({ where: { id: exhausted }, include: { cvFile: true } });
    expect(failed.status).toBe("FAILED");
    expect(failed.cvFile.status).toBe("FAILED");
    // A claim made moments ago belongs to a live invocation and is left alone.
    expect((await prisma.processingJob.findUniqueOrThrow({ where: { id: fresh } })).status).toBe("PROCESSING");

    await prisma.processingJob.updateMany({ where: { id: { in: [retryable, fresh] } }, data: { status: "SKIPPED" } });
  });

  it("works through a batch several CVs at a time instead of one by one", async () => {
    const ids = await makeJobs(12);
    const t = Date.now();
    const res = await drainPendingJobs({ concurrency: 4, timeBudgetMs: 30_000 });
    const elapsed = Date.now() - t;

    expect(res.processed).toBe(12);
    expect(res.remaining).toBe(0);
    // One at a time would need 12 × 150ms of parse alone.
    expect(elapsed).toBeLessThan(12 * PARSE_MS);
    expect(new Set(processed)).toEqual(new Set(ids));
  });

  it("never processes a CV twice when drains overlap", async () => {
    const ids = await makeJobs(20);
    // Three simultaneous invocations of four lanes each, all racing for 20 CVs.
    const results = await Promise.all([1, 2, 3].map(() => drainPendingJobs({ concurrency: 4, timeBudgetMs: 30_000 })));

    expect(results.reduce((a, r) => a + r.processed, 0)).toBe(20);
    expect(processed).toHaveLength(20);
    expect(new Set(processed).size).toBe(20);
    expect(new Set(processed)).toEqual(new Set(ids));
  });

  it("stops starting new CVs when the time budget runs low", async () => {
    await makeJobs(30);
    const res = await drainPendingJobs({ concurrency: 1, timeBudgetMs: 1_000 });
    expect(res.timedOut).toBe(true);
    expect(res.processed).toBeGreaterThan(0);
    expect(res.remaining).toBeGreaterThan(0);
    // Leave the rest for the next test's accounting.
    await prisma.processingJob.updateMany({ where: { status: "PENDING" }, data: { status: "SKIPPED" } });
  });

  it("starts background chains for waiting CVs, but never more than the cap", async () => {
    await makeJobs(50);
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });
    try {
      const first = await kickBackgroundDrain("https://app.example", "test");
      expect(first.background).toBe(true);
      expect(first.started).toBe(3); // 50 waiting, cap of 3
      expect(calls.every((u) => u.startsWith("https://app.example/api/jobs/drain?background=1&chain="))).toBe(true);
      expect(await activeChains()).toBe(3);

      // A second kick while those are running adds nothing: this is what makes
      // the browser's every-few-seconds nudge safe.
      const second = await kickBackgroundDrain("https://app.example", "test");
      expect(second.started).toBe(0);
      expect(calls).toHaveLength(3);
    } finally {
      fetchSpy.mockRestore();
      await prisma.processingJob.updateMany({ where: { status: "PENDING" }, data: { status: "SKIPPED" } });
    }
  });

  it("does not start chains when nothing is waiting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await kickBackgroundDrain("https://app.example", "test");
      expect(res.started).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
