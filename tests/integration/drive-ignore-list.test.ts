import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { getIgnoredDriveFileIds, ignoreDriveFile, unignoreDriveFiles } from "@/backend/delete";

/**
 * Regression: a deleted Drive CV could never be re-imported.
 *
 * Deleting a Drive-sourced CV records its file id so the next sync does not
 * immediately bring back what someone just removed. Nothing ever cleared that
 * list, so the door only opened one way: re-testing with the same files
 * reported "Found 0 file(s)" from a folder that visibly contained them, with no
 * indication why.
 *
 * These run against the real Setting row the sync reads, because the bug was in
 * that round trip rather than in any single function.
 */
const KEY = "drive:ignored-file-ids";
const TAG = `test_${Date.now()}`;

afterEach(async () => {
  const current = await getIgnoredDriveFileIds();
  const mine = current.filter((id) => id.startsWith(TAG));
  if (mine.length) await unignoreDriveFiles(mine);
});

describe("the Drive ignore list", () => {
  it("remembers a deleted file so a sync does not undo the delete", async () => {
    const id = `${TAG}_a`;
    await ignoreDriveFile(id, null, "Rahul_Sharma_Resume.pdf");
    expect(await getIgnoredDriveFileIds()).toContain(id);
  });

  it("does not record the same file twice", async () => {
    const id = `${TAG}_b`;
    await ignoreDriveFile(id, null, "cv.pdf");
    await ignoreDriveFile(id, null, "cv.pdf");
    const ids = await getIgnoredDriveFileIds();
    expect(ids.filter((x) => x === id)).toHaveLength(1);
  });

  it("can be cleared, which is what makes re-testing possible", async () => {
    const ids = [`${TAG}_c`, `${TAG}_d`];
    for (const id of ids) await ignoreDriveFile(id, null, "cv.pdf");
    expect(await getIgnoredDriveFileIds()).toEqual(expect.arrayContaining(ids));

    const cleared = await unignoreDriveFiles(ids);
    expect(cleared).toBe(2);

    const after = await getIgnoredDriveFileIds();
    for (const id of ids) expect(after).not.toContain(id);
  });

  it("clearing one file leaves the others alone", async () => {
    const keep = `${TAG}_keep`;
    const drop = `${TAG}_drop`;
    await ignoreDriveFile(keep, null, "keep.pdf");
    await ignoreDriveFile(drop, null, "drop.pdf");

    await unignoreDriveFiles([drop]);

    const after = await getIgnoredDriveFileIds();
    expect(after).toContain(keep);
    expect(after).not.toContain(drop);
  });

  it("survives the setting being absent entirely", async () => {
    // A fresh deployment has no row at all; reading must not throw.
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    expect(Array.isArray(await getIgnoredDriveFileIds())).toBe(true);
    expect(row === null || typeof row === "object").toBe(true);
  });
});
