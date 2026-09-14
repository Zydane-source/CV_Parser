import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { randomToken } from "@/lib/crypto";
import { getUserConnection } from "@/services/google-drive/oauth";
import { triggerDriveSync } from "@/services/google-drive/trigger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Listing a folder and registering each file is network-bound. 60s is the
// Vercel Hobby ceiling; the scan itself is bounded by the Drive page size.
export const maxDuration = 60;

/**
 * POST /api/google-drive/sync — "Sync Now".
 *
 * Where a worker exists this enqueues and returns a batch id to watch. Where one
 * cannot exist — any serverless deployment — the scan runs here and returns real
 * counts, so the UI can report what happened rather than claiming "queued" for
 * work nothing would ever pick up.
 *
 * A manual sync always re-scans the folder rather than trusting the Changes
 * cursor: the reason someone presses this button is usually that they believe
 * the cursor missed something.
 */
export const POST = handler(async () => {
  const user = await requireUser();
  const conn = await getUserConnection(user.id);
  if (!conn) throw new AppError("Google Drive is not connected", { status: 400, code: "GOOGLE_NOT_CONNECTED" });
  if (!conn.folderId) throw new AppError("Select a Drive folder first", { status: 400, code: "NO_FOLDER" });

  const batchId = `drive_${randomToken(9)}`;
  const sync = await triggerDriveSync(conn.id, "manual", { full: true, batchId });

  if (sync.status === "failed") {
    throw new AppError(`Sync could not be started: ${sync.error}`, { status: 502, code: "DRIVE_SYNC_FAILED" });
  }

  return sync.status === "ran"
    ? ok({
        ran: true,
        queued: false,
        batchId,
        mode: sync.result.mode,
        discovered: sync.result.discovered,
        enqueued: sync.result.enqueued,
        reprocessed: sync.result.reprocessed,
        unchanged: sync.result.unchanged,
      })
    : ok({ ran: false, queued: true, batchId, queueJobId: sync.jobId });
});
