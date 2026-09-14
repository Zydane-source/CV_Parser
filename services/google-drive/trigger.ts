import { logger } from "@/lib/logger";
import { errorMessage } from "@/lib/errors";
import { effectiveProcessingMode } from "@/lib/processing-mode";
import { addDriveSyncJob } from "@/services/processing/queue";
import { syncConnection, type SyncResult } from "./sync";

/**
 * The one place that decides how a Drive sync gets started.
 *
 * Three routes want to start a sync — selecting a folder, pressing Sync Now, and
 * a push notification from Google — and each has to branch on whether a queue
 * consumer can exist. Written out three times, one of them was missed: saving a
 * folder still enqueued into a queue nothing reads, so the folder saved and then
 * the request returned 500.
 *
 * This never throws. Starting a sync is always a *follow-up* to the thing the
 * user actually asked for, and none of those actions should fail because the
 * follow-up did. Callers get the outcome and decide what to say about it.
 */
export type TriggerOutcome =
  | { status: "ran"; result: SyncResult }
  | { status: "queued"; jobId?: string }
  | { status: "failed"; error: string };

export async function triggerDriveSync(
  connectionId: string,
  reason: "manual" | "folder-changed" | "webhook",
  opts: { full?: boolean; batchId?: string } = {},
): Promise<TriggerOutcome> {
  try {
    if (effectiveProcessingMode() === "inline") {
      const result = await syncConnection(connectionId, opts);
      return { status: "ran", result };
    }
    const jobId = await addDriveSyncJob(
      reason,
      { connectionId, reason, batchId: opts.batchId },
      { jobId: `${reason}-${connectionId}-${Date.now()}` },
    );
    return { status: "queued", jobId };
  } catch (err) {
    const error = errorMessage(err);
    logger.warn({ connectionId, reason, err: error }, "Could not start Drive sync");
    return { status: "failed", error };
  }
}
