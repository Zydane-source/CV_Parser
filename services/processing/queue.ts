import { Queue, type JobsOptions } from "bullmq";
import { getRedis, isRedisConfigured } from "@/lib/redis";
import { withTimeout } from "@/lib/timeout";

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

/**
 * Add a Drive-sync job, bounded so a request path cannot hang on an unreachable
 * Redis. Throws when there is no usable queue, which the callers already report.
 */
export async function addDriveSyncJob(name: string, data: DriveSyncJobData, opts: JobsOptions): Promise<string | undefined> {
  if (!isRedisConfigured()) {
    throw new Error("No queue is configured (PROCESSING_MODE=inline, or REDIS_URL is not reachable from here)");
  }
  const job = await withTimeout(getDriveSyncQueue().add(name, data, opts), 5000, "Drive sync enqueue timed out – Redis is not responding");
  return job.id;
}

/** Retry policy for CV jobs: exponential backoff, capped attempts (configurable). */
export function cvJobOptions(maxAttempts: number, backoffMs: number): JobsOptions {
  return {
    attempts: Math.max(1, maxAttempts),
    backoff: { type: "exponential", delay: backoffMs },
  };
}

/**
 * Queue-level counts for the monitoring UI. Returns null when there is no queue
 * to count.
 *
 * BullMQ's connection waits forever for an unreachable Redis by design, so this
 * has to be bounded explicitly — a `.catch()` at the call site cannot rescue a
 * promise that never settles, and this runs on a request path.
 */
export async function getQueueCounts() {
  if (!isRedisConfigured()) return null;
  const q = getCVQueue();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      q.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("queue counts timed out")), 2000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
