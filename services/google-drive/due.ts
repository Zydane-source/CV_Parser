import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { errorMessage } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { syncConnection } from "./sync";

/**
 * Drive discovery for deployments with no always-on worker.
 *
 * In queue mode a repeatable BullMQ job polls Drive every
 * `GOOGLE_DRIVE_SYNC_INTERVAL_MINUTES`. A serverless deployment has no process
 * to run that, so without this nothing ever notices a new CV in a connected
 * folder — the folder is connected, the credentials are valid, and files simply
 * never arrive.
 *
 * The scheduled drain calls this before it drains CVs, so a sync and the
 * processing of whatever it discovered happen in the same invocation.
 *
 * Sync is skipped rather than queued when a connection is not yet due, so a
 * browser-driven drain running every few seconds does not hammer the Drive API.
 */
export interface DueSyncSummary {
  connectionsChecked: number;
  connectionsSynced: number;
  discovered: number;
  enqueued: number;
}

export async function syncDueConnections(): Promise<DueSyncSummary> {
  const summary: DueSyncSummary = { connectionsChecked: 0, connectionsSynced: 0, discovered: 0, enqueued: 0 };

  const settings = await getSettings();
  const intervalMs = Math.max(1, settings.driveSyncIntervalMinutes) * 60_000;
  const cutoff = new Date(Date.now() - intervalMs);

  const due = await prisma.googleDriveConnection.findMany({
    where: {
      isActive: true,
      folderId: { not: null },
      // Never synced, or last synced longer ago than the configured interval.
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: cutoff } }],
    },
    select: { id: true },
  });

  summary.connectionsChecked = due.length;

  for (const c of due) {
    try {
      const r = await syncConnection(c.id);
      summary.connectionsSynced++;
      summary.discovered += r.discovered;
      summary.enqueued += r.enqueued;
    } catch (err) {
      // One broken connection — revoked access, a deleted folder — must not stop
      // the others, and must not fail the drain that called us. syncConnection
      // already records the reason on the connection for the UI to show.
      logger.warn({ connectionId: c.id, err: errorMessage(err) }, "Scheduled Drive sync failed");
    }
  }

  return summary;
}
