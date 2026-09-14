import { handler, ok } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { getIgnoredDriveFileIds, unignoreDriveFiles } from "@/backend/delete";

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
  await requireUser();
  const ids = await getIgnoredDriveFileIds();
  return ok({ count: ids.length });
});

export const DELETE = handler(async () => {
  await requireAdmin();
  const ids = await getIgnoredDriveFileIds();
  const cleared = await unignoreDriveFiles(ids);
  return ok({ cleared });
});
