import { z } from "zod";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { errorMessage } from "@/lib/errors";
import type { WorkspaceScope } from "@/lib/tenant";
import { getStorage } from "@/services/storage";
import { isRedisConfigured } from "@/lib/redis";
import { withTimeout } from "@/lib/timeout";
import { getCVQueue } from "@/services/processing/queue";

/**
 * Deleting a CV removes the database record (cascading to its candidate and
 * processing jobs), cancels any queued work, and deletes the stored upload.
 *
 * Google Drive files are only ever *unlinked*: the app holds read-only scope and
 * must never touch the recruiter's Drive. Because the folder is re-scanned on a
 * schedule, an unlinked Drive file reappears on the next sync unless it is
 * ignored — see `ignoreDriveFile`.
 */
export const deleteRequestSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
  /** Drive files only: also suppress re-import on the next sync. */
  ignoreFutureSync: z.boolean().default(true),
});

export type DeleteRequest = z.infer<typeof deleteRequestSchema>;

export interface DeleteResult {
  requested: number;
  deleted: number;
  driveUnlinked: number;
  driveIgnored: number;
  storageObjectsRemoved: number;
  notFound: string[];
}

export async function deleteCVs(scope: WorkspaceScope, req: DeleteRequest): Promise<DeleteResult> {
  // Ids outside the caller's workspace simply do not match, so they are reported
  // as notFound rather than deleted. Every later step works from these rows, so
  // this single where is what keeps the whole operation inside one client.
  const rows = await prisma.cVFile.findMany({
    where: { ...scope, id: { in: req.ids } },
    select: {
      id: true,
      workspaceId: true,
      fileName: true,
      sourceType: true,
      sourceFileId: true,
      storagePath: true,
      driveConnectionId: true,
      jobs: { select: { id: true, status: true } },
    },
  });
  const found = new Set(rows.map((r) => r.id));
  const notFound = req.ids.filter((id) => !found.has(id));

  const result: DeleteResult = {
    requested: req.ids.length,
    deleted: 0,
    driveUnlinked: 0,
    driveIgnored: 0,
    storageObjectsRemoved: 0,
    notFound,
  };
  if (rows.length === 0) return result;

  // 1. Cancel queued/in-flight work so a worker does not resurrect a deleted row.
  //    Skipped entirely when there is no queue: in inline mode there is nothing
  //    to cancel, and against an unreachable Redis every call here would park
  //    forever rather than throw, hanging the delete request.
  try {
    if (!isRedisConfigured()) throw new Error("no queue configured");
    const queue = getCVQueue();
    for (const row of rows) {
      for (const job of row.jobs) {
        if (job.status !== "PENDING" && job.status !== "PROCESSING") continue;
        const queued = await withTimeout(queue.getJob(`cv-${job.id}`), 2000);
        await queued?.remove().catch(() => undefined);
      }
    }
  } catch (err) {
    // Redis down: the processor already fails safely when its DB row is gone.
    logger.warn({ err: errorMessage(err) }, "Could not cancel queued jobs during delete");
  }

  // 2. Suppress re-import of unlinked Drive files.
  const driveRows = rows.filter((r) => r.sourceType === "GOOGLE_DRIVE" && r.sourceFileId);
  if (req.ignoreFutureSync && driveRows.length) {
    for (const row of driveRows) {
      await ignoreDriveFile(row.workspaceId, row.sourceFileId!, row.driveConnectionId, row.fileName);
      result.driveIgnored++;
    }
  }
  result.driveUnlinked = driveRows.length;

  // 3. Delete the records (Candidate and ProcessingJob cascade).
  const del = await prisma.cVFile.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  result.deleted = del.count;

  // 4. Remove stored uploads. Best effort: an orphaned object is harmless, a
  //    failed delete must not roll back a completed database delete.
  const storage = getStorage();
  for (const row of rows) {
    if (!row.storagePath) continue;
    try {
      await storage.delete(row.storagePath);
      result.storageObjectsRemoved++;
    } catch (err) {
      logger.warn({ cvFileId: row.id, err: errorMessage(err) }, "Stored file could not be removed");
    }
  }

  logger.info({ ...result, notFound: notFound.length }, "CVs deleted");
  return result;
}

/**
 * The ignore list is stored per workspace.
 *
 * Drive file ids are global, and two clients can legitimately be connected to
 * the same shared folder. A single list would mean one client deleting a CV
 * silently suppressed it for the other, which looks exactly like the "0 files
 * found" bug and would be just as hard to diagnose.
 */
const ignoreKey = (workspaceId: string) => `drive:ignored-file-ids:${workspaceId}`;

/** Record a Drive file id that must not be re-imported by a later sync. */
export async function ignoreDriveFile(
  workspaceId: string,
  fileId: string,
  connectionId: string | null,
  fileName: string,
): Promise<void> {
  const current = await getIgnoredDriveFileIds(workspaceId);
  if (current.includes(fileId)) return;
  const next = [...current, fileId].slice(-5000);
  await prisma.setting.upsert({
    where: { key: ignoreKey(workspaceId) },
    create: { key: ignoreKey(workspaceId), value: next },
    update: { value: next },
  });
  logger.info({ workspaceId, fileId, connectionId, fileName }, "Drive file ignored for future syncs");
}

export async function getIgnoredDriveFileIds(workspaceId: string): Promise<string[]> {
  const row = await prisma.setting.findUnique({ where: { key: ignoreKey(workspaceId) } });
  return Array.isArray(row?.value) ? (row!.value as string[]) : [];
}

/** Allow a previously deleted Drive file to be imported again. */
export async function unignoreDriveFiles(workspaceId: string, fileIds: string[]): Promise<number> {
  const current = await getIgnoredDriveFileIds(workspaceId);
  const next = current.filter((id) => !fileIds.includes(id));
  await prisma.setting.upsert({
    where: { key: ignoreKey(workspaceId) },
    create: { key: ignoreKey(workspaceId), value: next },
    update: { value: next },
  });
  return current.length - next.length;
}
