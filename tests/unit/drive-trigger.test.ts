import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";

/**
 * Regression: every way of starting a Drive sync must work without a queue.
 *
 * Three routes start one — selecting a folder, Sync Now, and a push
 * notification. The mode branch was written out separately in each, and the
 * folder route was missed: it enqueued into a queue nothing reads on a
 * serverless deployment, so the folder saved correctly and the request still
 * returned 500. The branch now exists once, in triggerDriveSync.
 */
const ROUTES = [
  "app/api/google-drive/folder/route.ts",
  "app/api/google-drive/sync/route.ts",
  "app/api/google-drive/webhook/route.ts",
];

describe("starting a Drive sync", () => {
  it("no route reaches for the queue directly", async () => {
    for (const r of ROUTES) {
      const src = await fs.readFile(r, "utf8");
      expect(src, `${r} must not call addDriveSyncJob directly`).not.toContain("addDriveSyncJob");
    }
  });

  it("every route goes through the shared trigger", async () => {
    for (const r of ROUTES) {
      const src = await fs.readFile(r, "utf8");
      expect(src, `${r} should use triggerDriveSync`).toContain("triggerDriveSync");
    }
  });

  it("the trigger never throws, so a follow-up cannot fail the user's action", async () => {
    const src = await fs.readFile("services/google-drive/trigger.ts", "utf8");
    // A catch returning a "failed" outcome rather than rethrowing is the whole point.
    expect(src).toMatch(/catch\s*\(/);
    expect(src).toContain('status: "failed"');
    expect(src).not.toMatch(/throw\s/);
  });

  it("saving a folder reports the scan instead of failing on it", async () => {
    const src = await fs.readFile("app/api/google-drive/folder/route.ts", "utf8");
    // The folder update must be persisted before the scan is attempted. Match
    // the call site, not the import, which naturally sits above everything.
    expect(src.indexOf("googleDriveConnection.update")).toBeLessThan(src.indexOf("await triggerDriveSync("));
    expect(src).toContain("sync:");
  });
});
