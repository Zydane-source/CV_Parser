import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "@/lib/config";

/**
 * Regression: Google Drive must work on a deployment with no worker.
 *
 * The sync logic was complete, but every trigger for it went through BullMQ —
 * "Sync Now", the push webhook, and the repeatable poll. Only `workers/index.ts`
 * consumes that queue, and a serverless deployment cannot run it, so on Vercel
 * the folder connected successfully and then nothing ever happened: Sync Now
 * threw "No queue is configured", and no schedule existed to poll the folder.
 *
 * These pin the decision points rather than the Drive API itself, which needs a
 * real Google account and is covered by the manual end-to-end pass.
 */
const SAVED = { ...process.env };

beforeEach(() => {
  for (const k of ["PROCESSING_MODE", "REDIS_URL", "VERCEL", "AWS_LAMBDA_FUNCTION_NAME"]) delete process.env[k];
  resetEnvCache();
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...SAVED };
  resetEnvCache();
});

describe("processing mode decides how a Drive sync is triggered", () => {
  it("is inline on a serverless host, where no queue consumer can exist", async () => {
    process.env.VERCEL = "1";
    resetEnvCache();
    const { effectiveProcessingMode } = await import("@/lib/processing-mode");
    expect(effectiveProcessingMode()).toBe("inline");
  });

  it("downgrades to inline when queue mode is configured but unreachable", async () => {
    // The shape a misconfigured Vercel project actually has.
    process.env.VERCEL = "1";
    process.env.PROCESSING_MODE = "queue";
    process.env.REDIS_URL = "redis://localhost:6379";
    resetEnvCache();
    const { effectiveProcessingMode } = await import("@/lib/processing-mode");
    expect(effectiveProcessingMode()).toBe("inline");
  });

  it("stays on the queue where a worker can genuinely run", async () => {
    process.env.PROCESSING_MODE = "queue";
    process.env.REDIS_URL = "redis://redis.internal:6379";
    resetEnvCache();
    const { effectiveProcessingMode } = await import("@/lib/processing-mode");
    expect(effectiveProcessingMode()).toBe("queue");
  });
});

describe("enqueuing a Drive sync without a queue", () => {
  it("fails loudly rather than silently doing nothing", async () => {
    process.env.VERCEL = "1";
    process.env.PROCESSING_MODE = "inline";
    resetEnvCache();
    const { addDriveSyncJob } = await import("@/services/processing/queue");
    // This is the throw that made "Sync Now" a no-op in production. The route no
    // longer reaches it in inline mode — it runs the sync directly instead — but
    // the guard must stay, so a future caller cannot enqueue into the void.
    await expect(addDriveSyncJob("manual", { reason: "manual" }, {})).rejects.toThrow(/No queue is configured/);
  });
});

describe("due-connection selection", () => {
  it("only syncs connections that have a folder and are active", async () => {
    // The query is the contract: an inactive or folder-less connection must not
    // be polled, or a disconnected account keeps costing Drive quota.
    const src = await import("node:fs").then((fs) =>
      fs.promises.readFile("services/google-drive/due.ts", "utf8"),
    );
    expect(src).toContain("isActive: true");
    expect(src).toContain("folderId: { not: null }");
    expect(src).toContain("lastSyncAt: null");
  });
});
