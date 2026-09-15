import { z } from "zod";
import { handler, ok, parseJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getWorkspaceConnection } from "@/services/google-drive/oauth";
import { getFolderPath } from "@/services/google-drive/files";
import { triggerDriveSync } from "@/services/google-drive/trigger";
import { kickAfterResponse } from "@/services/processing/background";
import { stopWatch } from "@/services/google-drive/watch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Selecting a folder also scans it, which is network-bound.
export const maxDuration = 60;

const schema = z.object({ folderId: z.string().min(1).max(200) });

/**
 * PUT /api/google-drive/folder { folderId } — choose the folder to watch.
 *
 * Saving the folder is the user's action; scanning it is a follow-up. The scan
 * therefore cannot fail the request: previously it enqueued into a queue that
 * nothing reads on a serverless deployment, so the folder saved correctly and
 * the response was still a 500.
 */
export const PUT = handler(async (req: Request) => {
  const user = await requireUser();
  const { folderId } = await parseJson(req, schema);
  const conn = await getWorkspaceConnection(user.workspaceId);
  if (!conn) throw new AppError("Google Drive is not connected", { status: 400, code: "GOOGLE_NOT_CONNECTED" });

  const info = await getFolderPath(conn.id, folderId);
  if (conn.watchChannelId) await stopWatch(conn.id).catch(() => undefined);
  const updated = await prisma.googleDriveConnection.update({
    where: { id: conn.id },
    data: { folderId, folderName: info.name, folderPath: info.path, startPageToken: null, lastSyncError: null },
  });

  // A new folder has no Changes cursor, so this is necessarily a full scan.
  const sync = await triggerDriveSync(conn.id, "folder-changed", { full: true });
  if (sync.status === "ran" && sync.result.enqueued + sync.result.reprocessed > 0) kickAfterResponse(req, "drive-folder");

  return ok({
    folderId: updated.folderId,
    folderName: updated.folderName,
    folderPath: updated.folderPath,
    sync:
      sync.status === "ran"
        ? { status: "ran", discovered: sync.result.discovered, enqueued: sync.result.enqueued }
        : sync.status === "queued"
          ? { status: "queued" }
          : { status: "failed", error: sync.error },
  });
});
