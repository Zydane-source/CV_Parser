import { z } from "zod";
import { handler, ok, parseJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getUserConnection } from "@/services/google-drive/oauth";
import { getFolderPath } from "@/services/google-drive/files";
import { addDriveSyncJob } from "@/services/processing/queue";
import { stopWatch } from "@/services/google-drive/watch";

export const dynamic = "force-dynamic";

const schema = z.object({ folderId: z.string().min(1).max(200) });

/** PUT /api/google-drive/folder { folderId } – select the folder to watch; triggers a full sync. */
export const PUT = handler(async (req: Request) => {
  const user = await requireUser();
  const { folderId } = await parseJson(req, schema);
  const conn = await getUserConnection(user.id);
  if (!conn) throw new AppError("Google Drive is not connected", { status: 400, code: "GOOGLE_NOT_CONNECTED" });

  const info = await getFolderPath(conn.id, folderId);
  if (conn.watchChannelId) await stopWatch(conn.id).catch(() => undefined);
  const updated = await prisma.googleDriveConnection.update({
    where: { id: conn.id },
    data: { folderId, folderName: info.name, folderPath: info.path, startPageToken: null, lastSyncError: null },
  });
  await addDriveSyncJob("folder-changed", { connectionId: conn.id, reason: "folder-changed" }, { jobId: `folder-${conn.id}-${Date.now()}` });
  return ok({ folderId: updated.folderId, folderName: updated.folderName, folderPath: updated.folderPath });
});
