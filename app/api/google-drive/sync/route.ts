import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { randomToken } from "@/lib/crypto";
import { getUserConnection } from "@/services/google-drive/oauth";
import { addDriveSyncJob } from "@/services/processing/queue";
import { syncConnection } from "@/services/google-drive/sync";
import { effectiveProcessingMode } from "@/lib/processing-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Listing a folder and registering each file is network-bound. 60s is the
// Vercel Hobby ceiling; the sync itself is bounded by the Drive page size.
export const maxDuration = 60;

/**
 * POST /api/google-drive/sync — "Sync Now".
 *
 * Two paths, because the platform decides which one is possible:
 *
 *   queue mode   a worker process consumes the drive-sync queue, so this
 *                enqueues and returns a batch id for the UI to watch.
 *
 *   inline mode  there is no worker and no Redis — which is exactly what a
 *                serverless deployment runs — so the sync executes here and
 *                returns the real counts. Enqueuing in that mode threw
 *                "No queue is configured", which is why Sync Now did nothing in
 *                production.
 *
 * Either way the discovered files are registered as CVFile rows and handed to
 * the existing pipeline through `enqueueCVFile`; nothing about extraction
 * changes.
 */
export const POST = handler(async () => {
  const user = await requireUser();
  const conn = await getUserConnection(user.id);
  if (!conn) throw new AppError("Google Drive is not connected", { status: 400, code: "GOOGLE_NOT_CONNECTED" });
  if (!conn.folderId) throw new AppError("Select a Drive folder first", { status: 400, code: "NO_FOLDER" });

  const batchId = `drive_${randomToken(9)}`;

  if (effectiveProcessingMode() === "inline") {
    // `full: true` — a manual "Sync Now" should re-scan the folder rather than
    // trust the Changes cursor, because the reason someone presses it is
    // usually that they believe the cursor missed something.
    const result = await syncConnection(conn.id, { full: true, batchId });
    return ok({
      queued: false,
      ran: true,
      batchId,
      mode: result.mode,
      discovered: result.discovered,
      enqueued: result.enqueued,
      reprocessed: result.reprocessed,
      unchanged: result.unchanged,
    });
  }

  const queueJobId = await addDriveSyncJob(
    "manual",
    { connectionId: conn.id, reason: "manual", batchId },
    { jobId: `manual-${conn.id}-${Date.now()}` },
  );
  return ok({ queued: true, ran: false, queueJobId, batchId });
});
