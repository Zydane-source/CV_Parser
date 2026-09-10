import { Queue, type JobsOptions } from "bullmq";
import { getRedis } from "@/lib/redis";

/**
 * BullMQ queues.
 *  - cv-processing : one job per CV file (manual upload or Drive file).
 *  - drive-sync    : repeatable job that polls Google Drive for new files
 *                    (plus on-demand syncs triggered by "Sync Now" / webhooks).
 */
/**
 * Optional namespace for queue names. Lets an automated test run against the
 * same Redis instance as a live worker without the two stealing each other's
 * jobs. Unset in normal operation.
 */
const QUEUE_PREFIX = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : "";

export const CV_QUEUE_NAME = `${QUEUE_PREFIX}cv-processing`;
export const DRIVE_SYNC_QUEUE_NAME = `${QUEUE_PREFIX}drive-sync`;

export interface CVJobData {
  cvFileId: string;
  processingJobId: string;
  /** Set when reprocessing an already-parsed CV (manual corrections are preserved). */
  reprocess?: boolean;
}

export interface DriveSyncJobData {
  connectionId?: string; // undefined = all active connections
  reason: "scheduled" | "manual" | "webhook" | "folder-changed";
  batchId?: string;
}

const globalForQueues = globalThis as unknown as { cvQueue?: Queue<CVJobData>; driveSyncQueue?: Queue<DriveSyncJobData> };

export function getCVQueue(): Queue<CVJobData> {
  if (!globalForQueues.cvQueue) {
    globalForQueues.cvQueue = new Queue<CVJobData>(CV_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        removeOnComplete: { age: 24 * 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return globalForQueues.cvQueue;
}

export function getDriveSyncQueue(): Queue<DriveSyncJobData> {
  if (!globalForQueues.driveSyncQueue) {
    globalForQueues.driveSyncQueue = new Queue<DriveSyncJobData>(DRIVE_SYNC_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 24 * 3600 },
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
      },
    });
  }
  return globalForQueues.driveSyncQueue;
}

/** Retry policy for CV jobs: exponential backoff, capped attempts (configurable). */
export function cvJobOptions(maxAttempts: number, backoffMs: number): JobsOptions {
  return {
    attempts: Math.max(1, maxAttempts),
    backoff: { type: "exponential", delay: backoffMs },
  };
}

/** Queue-level counts for the monitoring UI. */
export async function getQueueCounts() {
  const q = getCVQueue();
  const counts = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused");
  return counts;
}
