import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetEnvCache } from "@/lib/config";
import { AppError } from "@/lib/errors";

/**
 * Regression: a misconfigured storage driver must fail *diagnosably*.
 *
 * Uploading a CV returned a bare "Internal server error". The per-file loop in
 * `/api/uploads` already reports each file's own failure, so the 500 came from
 * `getStorage()` throwing a plain `Error` before the loop — and `errorResponse`
 * deliberately anonymises anything that is not an `AppError`. The cause was
 * therefore invisible outside the platform's own logs.
 *
 * Two things are pinned here: the errors are `AppError`s carrying an actionable
 * message, and attaching a Blob store is enough on its own — Vercel injects
 * BLOB_READ_WRITE_TOKEN but does not set STORAGE_DRIVER, so a deployment that
 * did everything right in the dashboard would otherwise fall through to "local".
 */
const SAVED = { ...process.env };

async function freshStorage() {
  resetEnvCache();
  const mod = await import("@/services/storage");
  mod.setStorageProvider(null); // clear the memoised instance
  return mod;
}

beforeEach(() => {
  for (const k of ["STORAGE_DRIVER", "BLOB_READ_WRITE_TOKEN", "VERCEL", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY", "STORAGE_SECRET_KEY"]) {
    delete process.env[k];
  }
  resetEnvCache();
});

afterEach(async () => {
  process.env = { ...SAVED };
  resetEnvCache();
  const mod = await import("@/services/storage");
  mod.setStorageProvider(null);
});

describe("storage driver selection", () => {
  it("uses the Blob store when its token is present and no driver was chosen", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    const { effectiveStorageDriver, getStorage } = await freshStorage();
    expect(effectiveStorageDriver()).toBe("vercel-blob");
    expect(getStorage().name).toBe("vercel-blob");
  });

  it("honours an explicit driver over the token heuristic", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    process.env.STORAGE_DRIVER = "local";
    const { effectiveStorageDriver } = await freshStorage();
    expect(effectiveStorageDriver()).toBe("local");
  });

  it("still uses local storage off-platform with nothing configured", async () => {
    const { getStorage } = await freshStorage();
    expect(getStorage().name).toBe("local");
  });
});

describe("storage misconfiguration is reported, not swallowed", () => {
  it("prefers an attached Blob store over an impossible local driver on serverless", async () => {
    // The exact production shape: STORAGE_DRIVER=local imported from
    // .env.example, with a Blob store attached in the dashboard.
    process.env.VERCEL = "1";
    process.env.STORAGE_DRIVER = "local";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    const { effectiveStorageDriver, getStorage } = await freshStorage();
    expect(effectiveStorageDriver()).toBe("vercel-blob");
    expect(getStorage().name).toBe("vercel-blob");
  });

  it("refuses local storage on a serverless platform", async () => {
    process.env.VERCEL = "1";
    process.env.STORAGE_DRIVER = "local";
    const { getStorage } = await freshStorage();
    // A read-only, per-instance filesystem loses the upload even when the write
    // appears to succeed, so this must fail loudly at selection time.
    expect(() => getStorage()).toThrow(AppError);
    expect(() => getStorage()).toThrow(/serverless/i);
  });

  it("names the missing variable when the blob driver has no token", async () => {
    process.env.STORAGE_DRIVER = "vercel-blob";
    const { getStorage } = await freshStorage();
    expect(() => getStorage()).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });

  it("names the missing variables when s3 is incomplete", async () => {
    process.env.STORAGE_DRIVER = "s3";
    const { getStorage } = await freshStorage();
    expect(() => getStorage()).toThrow(/STORAGE_BUCKET/);
  });

  it("throws an AppError so the API reports the reason instead of a bare 500", async () => {
    process.env.STORAGE_DRIVER = "vercel-blob";
    const { getStorage } = await freshStorage();
    try {
      getStorage();
      throw new Error("expected a throw");
    } catch (err) {
      // errorResponse() anonymises anything that is not an AppError. This is the
      // property that turns "Internal server error" into a usable message.
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(503);
      expect((err as AppError).code).toBe("CONFIG_ERROR");
    }
  });
});
