import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { errorMessage } from "@/lib/errors";
import { enqueueCVFile, reprocessCVFile } from "@/services/processing/enqueue";
import { listCvFilesInFolder, listChanges, getStartPageToken, effectiveMime, type DriveCvFile } from "./files";
import { ensureWatch } from "./watch";

/**
 * Google Drive synchronisation.
 *  - Full sync   : lists the configured folder and enqueues every unseen file.
 *  - Incremental : consumes the Drive Changes API since the stored page token,
 *                  so newly added CVs (e.g. Candidate_C.pdf at 11:00) are picked
 *                  up without re-listing the whole folder.
 * Unchanged files are never reprocessed; modified files are reprocessed while
 * preserving manual corrections.
 */
export interface SyncResult {
  connectionId: string;
  mode: "full" | "incremental";
  discovered: number;
  enqueued: number;
  reprocessed: number;
  unchanged: number;
  batchId: string | null;
}

export async function syncConnection(connectionId: string, opts: { full?: boolean; batchId?: string } = {}): Promise<SyncResult> {
  const conn = await prisma.googleDriveConnection.findUnique({ where: { id: connectionId } });
  if (!conn || !conn.isActive) throw new Error("Connection not active");
  if (!conn.folderId) throw new Error("No Drive folder selected");

  const log = logger.child({ connectionId });
  const result: SyncResult = { connectionId, mode: "full", discovered: 0, enqueued: 0, reprocessed: 0, unchanged: 0, batchId: opts.batchId ?? null };

  try {
    let files: DriveCvFile[];
    let newToken: string | null = null;

    if (opts.full || !conn.startPageToken) {
      // Grab the page token BEFORE listing so changes during the listing are not lost.
      newToken = await getStartPageToken(connectionId);
      files = await listCvFilesInFolder(connectionId, conn.folderId);
      result.mode = "full";
    } else {
      const changes = await listChanges(connectionId, conn.startPageToken);
      files = changes.changed.filter((f) => f.parents.includes(conn.folderId!));
      newToken = changes.newStartPageToken;
      result.mode = "incremental";
    }
    result.discovered = files.length;

    for (const f of files) {
      const outcome = await upsertDriveFile(conn.id, f, opts.batchId);
      if (outcome === "enqueued") result.enqueued++;
      else if (outcome === "reprocessed") result.reprocessed++;
      else result.unchanged++;
    }

    await prisma.googleDriveConnection.update({
      where: { id: connectionId },
      data: {
        startPageToken: newToken ?? conn.startPageToken,
        lastSyncAt: new Date(),
        lastSyncError: null,
        lastSyncFileCount: result.discovered,
      },
    });

    // Keep push-notification channel alive (no-op if webhooks are not possible).
    await ensureWatch(connectionId).catch((err) => log.warn({ err: errorMessage(err) }, "ensureWatch failed"));

    log.info({ ...result }, "Drive sync completed");
    return result;
  } catch (err) {
    const msg = errorMessage(err);
    await prisma.googleDriveConnection.update({ where: { id: connectionId }, data: { lastSyncError: msg.slice(0, 500) } });
    // Invalid page token → force a full sync next time.
    if (/pageToken|page token/i.test(msg)) {
      await prisma.googleDriveConnection.update({ where: { id: connectionId }, data: { startPageToken: null } });
    }
    throw err;
  }
}

type Outcome = "enqueued" | "reprocessed" | "unchanged";

/** Create or refresh the CVFile row for a Drive file and enqueue processing when needed. */
export async function upsertDriveFile(connectionId: string, f: DriveCvFile, batchId?: string): Promise<Outcome> {
  const existing = await prisma.cVFile.findUnique({
    where: { sourceType_sourceFileId: { sourceType: "GOOGLE_DRIVE", sourceFileId: f.id } },
    include: { candidate: { select: { id: true } } },
  });
  const modified = f.modifiedTime ? new Date(f.modifiedTime) : null;

  if (!existing) {
    const created = await prisma.cVFile.create({
      data: {
        sourceType: "GOOGLE_DRIVE",
        sourceFileId: f.id,
        fileName: f.name,
        mimeType: effectiveMime(f.mimeType),
        fileHash: f.md5Checksum ? `md5:${f.md5Checksum}` : `drive:${f.id}`,
        fileSize: f.size,
        driveUrl: f.webViewLink,
        driveCreatedTime: f.createdTime ? new Date(f.createdTime) : null,
        driveModifiedTime: modified,
        driveConnectionId: connectionId,
        status: "PENDING",
      },
    });
    await enqueueCVFile(created, { batchId });
    return "enqueued";
  }

  // Unchanged file (same modified time) → do nothing. Never reprocess unchanged Drive files.
  const changed = modified && existing.driveModifiedTime && modified.getTime() > existing.driveModifiedTime.getTime();
  if (!changed) {
    // Edge: a previously failed file with no candidate and nothing in flight is left alone here;
    // the user can retry from the Jobs page. This avoids hammering a permanently broken file.
    return "unchanged";
  }

  await prisma.cVFile.update({
    where: { id: existing.id },
    data: {
      fileName: f.name,
      mimeType: effectiveMime(f.mimeType),
      fileSize: f.size,
      driveUrl: f.webViewLink,
      driveModifiedTime: modified,
      driveConnectionId: connectionId,
    },
  });
  await reprocessCVFile(existing.id, batchId);
  return "reprocessed";
}

/** Sync every active connection that has a folder configured (used by the scheduler). */
export async function syncAllConnections(reason: string): Promise<SyncResult[]> {
  const conns = await prisma.googleDriveConnection.findMany({ where: { isActive: true, folderId: { not: null } }, select: { id: true } });
  const results: SyncResult[] = [];
  for (const c of conns) {
    try {
      results.push(await syncConnection(c.id));
    } catch (err) {
      logger.error({ connectionId: c.id, reason, err: errorMessage(err) }, "Drive sync failed");
    }
  }
  return results;
}
