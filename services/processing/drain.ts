import { prisma } from "@/lib/db";
import { env } from "@/lib/config";
import { logger } from "@/lib/logger";
import { errorMessage, isTransientError } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { processCVJob } from "./processor";

/**
 * Serverless drain: processes pending CVs without a long-running worker.
 *
 * On a platform with no always-on process (Vercel), nothing consumes the BullMQ
 * queue. In `PROCESSING_MODE=inline` the upload endpoint only records the job,
 * and this function does the work in short bursts that fit inside a serverless
 * invocation. It is driven from two places:
 *   - the browser, while a batch is in flight (immediate feedback), and
 *   - a scheduled cron, so a batch still finishes after the tab is closed.
 *
 * Claiming is atomic: a conditional update on PENDING means two concurrent
 * invocations can never process the same CV.
 */
export interface DrainResult {
  claimed: number;
  processed: number;
  failed: number;
  remaining: number;
  timedOut: boolean;
  durationMs: number;
}

export interface DrainOptions {
  max?: number;
  timeBudgetMs?: number;
}

/** Atomically take ownership of one pending job. Returns null when none are left. */
async function claimNextJob(): Promise<string | null> {
  // Oldest first so a batch completes in upload order.
  const candidates = await prisma.processingJob.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 10,
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
  const max = opts.max ?? e.DRAIN_BATCH_SIZE;
  const budget = opts.timeBudgetMs ?? e.DRAIN_TIME_BUDGET_MS;
  const started = Date.now();

  const result: DrainResult = { claimed: 0, processed: 0, failed: 0, remaining: 0, timedOut: false, durationMs: 0 };

  for (let i = 0; i < max; i++) {
    // Leave room for one more CV; stop rather than be killed mid-write.
    if (Date.now() - started > budget * 0.6) {
      result.timedOut = true;
      break;
    }
    const jobId = await claimNextJob();
    if (!jobId) break;
    result.claimed++;

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

  result.remaining = await prisma.processingJob.count({ where: { status: "PENDING" } });
  result.durationMs = Date.now() - started;
  return result;
}

/** True when this deployment has no dedicated worker and relies on draining. */
export function isInlineMode(): boolean {
  return env().PROCESSING_MODE === "inline";
}
