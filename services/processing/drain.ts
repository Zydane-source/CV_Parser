import { prisma } from "@/lib/db";
import { env } from "@/lib/config";
import { effectiveProcessingMode } from "@/lib/processing-mode";
import { logger } from "@/lib/logger";
import { errorMessage, isTransientError } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { processCVJob } from "./processor";

/**
 * Serverless drain: processes pending CVs without a long-running worker.
 *
 * On a platform with no always-on process (Vercel), nothing consumes the BullMQ
 * queue. In `PROCESSING_MODE=inline` the upload endpoint only records the job,
 * and this function does the work in bursts that fit inside one serverless
 * invocation. Background chains (see ./background.ts) call it back to back, so a
 * batch keeps moving with no browser open.
 *
 * Within one call several CVs run at once. Parsing itself is quick — a text PDF
 * is well under a second — so most of a CV's wall time is waiting on the Drive
 * download and database round trips, which overlap cleanly. The call keeps
 * claiming work until its time budget is spent rather than stopping after a
 * fixed count, because a fixed count of two was leaving most of every
 * invocation idle.
 *
 * Claiming is atomic: a conditional update on PENDING means concurrent calls,
 * lanes and chains can never process the same CV.
 */
export interface DrainResult {
  claimed: number;
  processed: number;
  failed: number;
  recovered: number;
  remaining: number;
  timedOut: boolean;
  durationMs: number;
}

export interface DrainOptions {
  max?: number;
  timeBudgetMs?: number;
  concurrency?: number;
  /**
   * Called once, the moment the call stops taking new CVs because its time is
   * nearly up — before the CVs already in hand have finished. A background chain
   * starts its successor here: waiting for the tail first is what let links run
   * into the platform limit and die without handing over.
   */
  onStopClaiming?: () => void;
}

/**
 * A job still PROCESSING after this long is dead, not slow.
 *
 * The drain runs inside a function the platform kills at 60 seconds, so a claim
 * older than a few minutes belongs to an invocation that no longer exists. Before
 * this existed such a CV stayed "Processing" forever: nothing ever claims a job
 * that is not PENDING.
 */
const STALE_CLAIM_MS = 3 * 60 * 1000;

/** Return abandoned claims to the queue, or fail them once their attempts are spent. */
export async function recoverStaleJobs(): Promise<number> {
  const stale = await prisma.processingJob.findMany({
    where: { status: "PROCESSING", OR: [{ startedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }, { startedAt: null, updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }] },
    select: { id: true, cvFileId: true, attempts: true, maxAttempts: true },
    take: 100,
  });
  let recovered = 0;
  for (const job of stale) {
    const exhausted = job.attempts >= (job.maxAttempts || 3);
    const message = "Processing was interrupted (the server stopped mid-way)";
    // Conditional on still being PROCESSING, so a job that finished between the
    // read and this write is left alone.
    const res = await prisma.processingJob.updateMany({
      where: { id: job.id, status: "PROCESSING" },
      data: exhausted
        ? { status: "FAILED", stage: null, completedAt: new Date(), errorMessage: `${message}; no attempts left`, errorCode: "INTERRUPTED" }
        : { status: "PENDING", stage: null, errorMessage: `${message}; retrying`, errorCode: "INTERRUPTED" },
    });
    if (res.count !== 1) continue;
    await prisma.cVFile.update({
      where: { id: job.cvFileId },
      data: exhausted ? { status: "FAILED", statusMessage: `${message}.` } : { status: "PENDING", statusMessage: null },
    });
    recovered++;
  }
  if (recovered) logger.warn({ recovered }, "drain: recovered interrupted jobs");
  return recovered;
}

/** Atomically take ownership of one pending job. Returns null when none are left. */
async function claimNextJob(): Promise<string | null> {
  // Oldest first so a batch completes in upload order. A few candidates, so
  // lanes racing for the same head of the queue each find something.
  const candidates = await prisma.processingJob.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true },
  });
  for (const c of candidates) {
    const claimed = await prisma.processingJob.updateMany({
      where: { id: c.id, status: "PENDING" },
      data: { status: "PROCESSING", startedAt: new Date(), stage: "CLAIMED" },
    });
    if (claimed.count === 1) return c.id;
  }
  return null;
}

export async function drainPendingJobs(opts: DrainOptions = {}): Promise<DrainResult> {
  const e = env();
  const settings = await getSettings();
  const max = opts.max ?? e.DRAIN_MAX_PER_CALL;
  const budget = opts.timeBudgetMs ?? e.DRAIN_TIME_BUDGET_MS;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? e.DRAIN_CONCURRENCY, 8));
  const started = Date.now();

  const result: DrainResult = { claimed: 0, processed: 0, failed: 0, recovered: 0, remaining: 0, timedOut: false, durationMs: 0 };
  result.recovered = await recoverStaleJobs().catch((err) => {
    logger.warn({ err: errorMessage(err) }, "drain: stale recovery failed");
    return 0;
  });

  let stopNotified = false;
  const stopClaiming = () => {
    result.timedOut = true;
    if (!stopNotified) {
      stopNotified = true;
      opts.onStopClaiming?.();
    }
  };

  // One lane: claim, process, repeat — until the budget or the queue runs out.
  const lane = async () => {
    for (;;) {
      if (result.claimed >= max) return;
      // Stop starting new CVs with room left to finish the ones in hand, rather
      // than be killed mid-write by the platform.
      if (Date.now() - started > budget * 0.7) {
        stopClaiming();
        return;
      }
      result.claimed++;
      const jobId = await claimNextJob();
      if (!jobId) {
        result.claimed--;
        return;
      }
      const job = await prisma.processingJob.findUnique({ where: { id: jobId }, select: { cvFileId: true, attempts: true, maxAttempts: true } });
      if (!job) continue;
      try {
        // processCVJob re-reads and re-stamps the row; attempts is 1-based.
        await processCVJob({ cvFileId: job.cvFileId, processingJobId: jobId }, job.attempts + 1, job.maxAttempts || settings.maxRetries);
        result.processed++;
      } catch (err) {
        // processCVJob already recorded the failure and decided on a retry; a
        // re-thrown transient error means it left the row PENDING for us.
        result.failed++;
        logger.warn({ jobId, transient: isTransientError(err), err: errorMessage(err) }, "drain: job failed");
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));

  result.remaining = await prisma.processingJob.count({ where: { status: "PENDING" } });
  result.durationMs = Date.now() - started;
  return result;
}

/** True when this deployment has no dedicated worker and relies on draining. */
export function isInlineMode(): boolean {
  return effectiveProcessingMode() === "inline";
}
