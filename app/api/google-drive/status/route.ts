import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getWorkspaceConnection, isGoogleConfigured, redirectUri } from "@/services/google-drive/oauth";
import { webhooksPossible } from "@/services/google-drive/watch";
import { getSettings } from "@/lib/settings";
import { getIgnoredDriveFileIds } from "@/backend/delete";

export const dynamic = "force-dynamic";

/** GET /api/google-drive/status */
export const GET = handler(async () => {
  const user = await requireUser();
  // The ignore list belongs to a client, so an owner with no workspace of their
  // own simply has none to report rather than being shown someone else's.
  const [conn, settings, ignored] = await Promise.all([
    getWorkspaceConnection(user.workspaceId),
    getSettings(),
    user.workspaceId ? getIgnoredDriveFileIds(user.workspaceId) : Promise.resolve([]),
  ]);
  return ok({
    configured: isGoogleConfigured(),
    redirectUri: redirectUri(),
    webhooksEnabled: webhooksPossible(),
    syncIntervalMinutes: settings.driveSyncIntervalMinutes,
    // Files a sync will deliberately skip because they were deleted here before.
    ignoredCount: ignored.length,
    connection: conn
      ? {
          id: conn.id,
          email: conn.googleAccountEmail,
          folderId: conn.folderId,
          folderName: conn.folderName,
          folderPath: conn.folderPath,
          lastSyncAt: conn.lastSyncAt,
          lastSyncError: conn.lastSyncError,
          lastSyncFileCount: conn.lastSyncFileCount,
          watchActive: Boolean(conn.watchChannelId && conn.watchExpiry && conn.watchExpiry > new Date()),
          watchExpiry: conn.watchExpiry,
          connectedAt: conn.createdAt,
        }
      : null,
  });
});
