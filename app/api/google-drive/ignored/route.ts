import { handler, ok } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { getIgnoredDriveFileIds, unignoreDriveFiles } from "@/backend/delete";
import { workspaceForWrite } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * The list of Drive files that syncing deliberately skips.
 *
 * Deleting a Drive-sourced CV records its file id here so the next sync does
 * not immediately re-import what someone just removed. That is the right
 * default and the wrong permanent state: nothing could clear the list, so a
 * deleted file could never come back and the folder reported "0 files" forever
 * with no indication why.
 *
 *   GET    – how many files are being skipped
 *   DELETE – stop skipping them, so the next sync picks them up again
 */
export const GET = handler(async () => {
  const user = await requireUser();
  const ids = await getIgnoredDriveFileIds(workspaceForWrite(user));
  return ok({ count: ids.length });
});

export const DELETE = handler(async () => {
  const user = await requireAdmin();
  // workspaceForWrite, not workspaceScope: clearing the list is an action on one
  // client's list, and there is no "all clients" version of it to fall back to.
  const workspaceId = workspaceForWrite(user);
  const ids = await getIgnoredDriveFileIds(workspaceId);
  const cleared = await unignoreDriveFiles(workspaceId, ids);
  return ok({ cleared });
});
