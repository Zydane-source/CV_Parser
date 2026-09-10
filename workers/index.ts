/**
 * Background worker process.
 *   npm run worker
 *
 * Consumes:
 *   - cv-processing : parses CVs (concurrency + LLM rate limit configurable)
 *   - drive-sync    : scheduled + on-demand Google Drive synchronisation
 */
import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { env } from "@/lib/config";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";
import { createRedisConnection } from "@/lib/redis";
import { getSettings } from "@/lib/settings";
import { errorMessage } from "@/lib/errors";
import { CV_QUEUE_NAME, DRIVE_SYNC_QUEUE_NAME, getDriveSyncQueue, type CVJobData, type DriveSyncJobData } from "@/services/processing/queue";
import { processCVJob } from "@/services/processing/processor";
import { syncConnection, syncAllConnections } from "@/services/google-drive/sync";
import { shutdownOCR } from "@/services/ocr";

const DRIVE_SCHEDULER_ID = "drive-sync-poll";

async function main() {
  const e = env();
  const settings = await getSettings();
  const log = logger.child({ component: "worker" });

  log.info(
    { concurrency: settings.workerConcurrency, llmRateLimitPerMinute: settings.llmRateLimitPerMinute, provider: e.LLM_PROVIDER, model: settings.llmModel },
    "Starting CV worker",
  );

  const cvWorker = new Worker<CVJobData>(
    CV_QUEUE_NAME,
    async (job: Job<CVJobData>) => {
      await processCVJob(job.data, job.attemptsMade + 1, job.opts.attempts ?? settings.maxRetries);
    },
    {
      connection: createRedisConnection(),
      concurrency: settings.workerConcurrency,
      // Global rate limit protects the LLM API across all concurrent jobs.
      limiter: { max: settings.llmRateLimitPerMinute, duration: 60_000 },
      lockDuration: 5 * 60_000, // OCR of multi-page scans can take a while
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );

  cvWorker.on("completed", (job) => log.debug({ jobId: job.id }, "job completed"));
  cvWorker.on("failed", (job, err) => log.warn({ jobId: job?.id, attempts: job?.attemptsMade, err: errorMessage(err) }, "job failed"));
  cvWorker.on("error", (err) => log.error({ err: errorMessage(err) }, "worker error"));

  const driveWorker = new Worker<DriveSyncJobData>(
    DRIVE_SYNC_QUEUE_NAME,
    async (job: Job<DriveSyncJobData>) => {
      const { connectionId, reason, batchId } = job.data;
      if (connectionId) {
        return syncConnection(connectionId, { full: reason === "manual" || reason === "folder-changed", batchId });
      }
      return syncAllConnections(reason);
    },
    { connection: createRedisConnection(), concurrency: 1, lockDuration: 10 * 60_000 },
  );
  driveWorker.on("failed", (job, err) => log.warn({ jobId: job?.id, err: errorMessage(err) }, "drive sync failed"));

  // Repeatable polling job for new Drive files (interval from settings).
  const intervalMs = Math.max(1, settings.driveSyncIntervalMinutes) * 60_000;
  await getDriveSyncQueue().upsertJobScheduler(DRIVE_SCHEDULER_ID, { every: intervalMs }, {
    name: "poll",
    data: { reason: "scheduled" },
  });
  log.info({ everyMinutes: settings.driveSyncIntervalMinutes }, "Drive polling scheduler registered");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down worker");
    await Promise.allSettled([cvWorker.close(), driveWorker.close()]);
    await shutdownOCR().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: errorMessage(err) }, "Worker failed to start");
  process.exit(1);
});
