import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { randomToken } from "@/lib/crypto";
import { getUserConnection } from "@/services/google-drive/oauth";
import { getDriveSyncQueue } from "@/services/processing/queue";

export const dynamic = "force-dynamic";

/** POST /api/google-drive/sync – "Sync Now": queues a full folder sync and returns a batch id to watch. */
export const POST = handler(async () => {
  const user = await requireUser();
  const conn = await getUserConnection(user.id);
  if (!conn) throw new AppError("Google Drive is not connected", { status: 400, code: "GOOGLE_NOT_CONNECTED" });
  if (!conn.folderId) throw new AppError("Select a Drive folder first", { status: 400, code: "NO_FOLDER" });
  const batchId = `drive_${randomToken(9)}`;
  const job = await getDriveSyncQueue().add("manual", { connectionId: conn.id, reason: "manual", batchId }, { jobId: `manual-${conn.id}-${Date.now()}` });
  return ok({ queued: true, queueJobId: job.id, batchId });
});
