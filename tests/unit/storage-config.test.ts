import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetEnvCache } from "@/lib/config";

/**
 * Regression: uploading a CV must not be defeated by configuration.
 *
 * Three separate outages came from one mechanism. Vercel pre-fills its
 * environment-variable import form from `.env.example`, so importing that file
 * defines every key in it — including ones the platform provides itself.
 * `BLOB_READ_WRITE_TOKEN=` then exists as a *blank project variable overriding
 * the value an attached Blob store injects*, and uploads fail with
 * "BLOB_READ_WRITE_TOKEN is not set" while the dashboard shows a store
 * correctly attached.
 *
 * Resolution therefore substitutes a driver that works rather than failing, and
 * warns each time it does. These tests pin the substitutions.
 */
const SAVED = { ...process.env };
const OWNED = [
  "STORAGE_DRIVER",
  "BLOB_READ_WRITE_TOKEN",
  "VERCEL",
  "AWS_LAMBDA_FUNCTION_NAME",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY",
  "STORAGE_SECRET_KEY",
];

async function freshStorage() {
  resetEnvCache();
  const mod = await import("@/services/storage");
  mod.setStorageProvider(null); // clear the memoised instance
  return mod;
}

beforeEach(() => {
  for (const k of OWNED) delete process.env[k];
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

  it("honours an explicit driver this deployment can actually satisfy", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    process.env.STORAGE_DRIVER = "local";
    const { effectiveStorageDriver } = await freshStorage();
    // Off-platform, "local" is a perfectly good driver, so it wins over the token.
    expect(effectiveStorageDriver()).toBe("local");
  });

  it("still uses local storage off-platform with nothing configured", async () => {
    const { getStorage } = await freshStorage();
    expect(getStorage().name).toBe("local");
  });

  it("uses s3 when its credentials are complete", async () => {
    process.env.STORAGE_DRIVER = "s3";
    process.env.STORAGE_BUCKET = "cvs";
    process.env.STORAGE_ACCESS_KEY = "key";
    process.env.STORAGE_SECRET_KEY = "secret";
    const { effectiveStorageDriver } = await freshStorage();
    expect(effectiveStorageDriver()).toBe("s3");
  });
});

describe("unusable configuration substitutes a driver that works", () => {
  it("prefers an attached Blob store over an impossible local driver on serverless", async () => {
    process.env.VERCEL = "1";
    process.env.STORAGE_DRIVER = "local";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    const { effectiveStorageDriver, getStorage } = await freshStorage();
    expect(effectiveStorageDriver()).toBe("vercel-blob");
    expect(getStorage().name).toBe("vercel-blob");
  });

  it("falls back to the database when local is impossible and no store is attached", async () => {
    process.env.VERCEL = "1";
    process.env.STORAGE_DRIVER = "local";
    const { effectiveStorageDriver, getStorage } = await freshStorage();
    // A read-only, per-instance filesystem loses the upload even when the write
    // appears to succeed.
    expect(effectiveStorageDriver()).toBe("database");
    expect(getStorage().name).toBe("database");
  });

  it("falls back to the database when the blob token is shadowed by a blank value", async () => {
    // The actual production state this was written for.
    process.env.VERCEL = "1";
    process.env.STORAGE_DRIVER = "vercel-blob";
    process.env.BLOB_READ_WRITE_TOKEN = "";
    const { effectiveStorageDriver, getStorage } = await freshStorage();
    expect(effectiveStorageDriver()).toBe("database");
    expect(getStorage().name).toBe("database");
  });

  it("falls back to the database when s3 credentials are incomplete", async () => {
    process.env.STORAGE_DRIVER = "s3";
    process.env.STORAGE_BUCKET = "cvs"; // no key or secret
    const { effectiveStorageDriver } = await freshStorage();
    expect(effectiveStorageDriver()).toBe("database");
  });

  it("prefers an attached Blob store over the database when s3 is incomplete", async () => {
    process.env.STORAGE_DRIVER = "s3";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
    const { effectiveStorageDriver } = await freshStorage();
    expect(effectiveStorageDriver()).toBe("vercel-blob");
  });

  it("never leaves a serverless deployment on the local driver", async () => {
    for (const driver of ["local", "vercel-blob", "s3"]) {
      for (const k of OWNED) delete process.env[k];
      process.env.AWS_LAMBDA_FUNCTION_NAME = "cv-parser";
      process.env.STORAGE_DRIVER = driver;
      const { effectiveStorageDriver } = await freshStorage();
      expect(effectiveStorageDriver()).not.toBe("local");
    }
  });
});
