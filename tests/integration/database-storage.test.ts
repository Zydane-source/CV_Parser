import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { buildObjectKey, setStorageProvider, getStorage } from "@/services/storage";
import { resetEnvCache } from "@/lib/config";

/**
 * The database storage driver against real Postgres.
 *
 * Selection logic alone proves nothing: a driver that is chosen but cannot
 * round-trip bytes is worse than one that fails loudly. This exercises the
 * whole interface the way the upload and download routes use it.
 */
const SAVED = { ...process.env };
const keys: string[] = [];

function dbStorage() {
  process.env.STORAGE_DRIVER = "vercel-blob";
  process.env.BLOB_READ_WRITE_TOKEN = ""; // shadowed → database fallback
  process.env.VERCEL = "1";
  resetEnvCache();
  setStorageProvider(null);
  return getStorage();
}

afterAll(async () => {
  if (keys.length) await prisma.storedFile.deleteMany({ where: { key: { in: keys } } });
  process.env = { ...SAVED };
  resetEnvCache();
  setStorageProvider(null);
});

describe("database storage driver", () => {
  it("round-trips a PDF byte for byte", async () => {
    const storage = dbStorage();
    expect(storage.name).toBe("database");

    // Binary with a null byte and high bytes: the cases a text column mangles.
    const original = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80]), Buffer.from("trailer")]);
    const key = buildObjectKey("Harshit.pdf");
    keys.push(key);

    await storage.put(key, original, "application/pdf");
    const read = await storage.get(key);
    expect(read.equals(original)).toBe(true);
    expect(read.length).toBe(original.length);
  });

  it("reports existence and deletes", async () => {
    const storage = dbStorage();
    const key = buildObjectKey("cv.pdf");
    keys.push(key);

    expect(await storage.exists(key)).toBe(false);
    await storage.put(key, Buffer.from("hello"), "application/pdf");
    expect(await storage.exists(key)).toBe(true);

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    // Deleting again must not throw: the delete path is best-effort.
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it("overwrites rather than duplicating on the same key", async () => {
    const storage = dbStorage();
    const key = buildObjectKey("cv.pdf");
    keys.push(key);
    await storage.put(key, Buffer.from("first"), "application/pdf");
    await storage.put(key, Buffer.from("second-and-longer"), "application/pdf");
    expect((await storage.get(key)).toString()).toBe("second-and-longer");
    expect(await prisma.storedFile.count({ where: { key } })).toBe(1);
  });

  it("fails clearly when the key is absent", async () => {
    const storage = dbStorage();
    await expect(storage.get("cvs/1999/01/nonexistent.pdf")).rejects.toThrow(/not found/i);
  });
});
