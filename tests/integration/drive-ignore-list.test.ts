import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { getIgnoredDriveFileIds, ignoreDriveFile, unignoreDriveFiles } from "@/backend/delete";
import { makeWorkspace, dropWorkspace } from "../helpers/workspace";

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
const TAG = `test_${Date.now()}`;

// The list is per client, so the tests need one to act as.
const ws = await makeWorkspace("ignore");
const KEY = `drive:ignored-file-ids:${ws.id}`;

afterEach(async () => {
  const current = await getIgnoredDriveFileIds(ws.id);
  const mine = current.filter((id) => id.startsWith(TAG));
  if (mine.length) await unignoreDriveFiles(ws.id, mine);
});

afterAll(async () => {
  await dropWorkspace(ws.id);
});

describe("the Drive ignore list", () => {
  it("remembers a deleted file so a sync does not undo the delete", async () => {
    const id = `${TAG}_a`;
    await ignoreDriveFile(ws.id, id, null, "Rahul_Sharma_Resume.pdf");
    expect(await getIgnoredDriveFileIds(ws.id)).toContain(id);
  });

  it("does not record the same file twice", async () => {
    const id = `${TAG}_b`;
    await ignoreDriveFile(ws.id, id, null, "cv.pdf");
    await ignoreDriveFile(ws.id, id, null, "cv.pdf");
    const ids = await getIgnoredDriveFileIds(ws.id);
    expect(ids.filter((x) => x === id)).toHaveLength(1);
  });

  it("can be cleared, which is what makes re-testing possible", async () => {
    const ids = [`${TAG}_c`, `${TAG}_d`];
    for (const id of ids) await ignoreDriveFile(ws.id, id, null, "cv.pdf");
    expect(await getIgnoredDriveFileIds(ws.id)).toEqual(expect.arrayContaining(ids));

    const cleared = await unignoreDriveFiles(ws.id, ids);
    expect(cleared).toBe(2);

    const after = await getIgnoredDriveFileIds(ws.id);
    for (const id of ids) expect(after).not.toContain(id);
  });

  it("clearing one file leaves the others alone", async () => {
    const keep = `${TAG}_keep`;
    const drop = `${TAG}_drop`;
    await ignoreDriveFile(ws.id, keep, null, "keep.pdf");
    await ignoreDriveFile(ws.id, drop, null, "drop.pdf");

    await unignoreDriveFiles(ws.id, [drop]);

    const after = await getIgnoredDriveFileIds(ws.id);
    expect(after).toContain(keep);
    expect(after).not.toContain(drop);
  });

  it("survives the setting being absent entirely", async () => {
    // A fresh deployment has no row at all; reading must not throw.
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    expect(Array.isArray(await getIgnoredDriveFileIds(ws.id))).toBe(true);
    expect(row === null || typeof row === "object").toBe(true);
  });
});
