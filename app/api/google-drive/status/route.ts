import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getUserConnection, isGoogleConfigured, redirectUri } from "@/services/google-drive/oauth";
import { webhooksPossible } from "@/services/google-drive/watch";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** GET /api/google-drive/status */
export const GET = handler(async () => {
  const user = await requireUser();
  const [conn, settings] = await Promise.all([getUserConnection(user.id), getSettings()]);
  return ok({
    configured: isGoogleConfigured(),
    redirectUri: redirectUri(),
    webhooksEnabled: webhooksPossible(),
    syncIntervalMinutes: settings.driveSyncIntervalMinutes,
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
