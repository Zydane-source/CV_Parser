import { promises as fs } from "node:fs";
import path from "node:path";
import { generateAllFixtures, FIXTURES } from "@/scripts/generate-fixtures";

export const FIXTURE_DIR = path.resolve("tests/fixtures/generated");

let ready: Promise<void> | null = null;

/** Ensure fixtures exist (generated once per test run). */
export async function ensureFixtures(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const missing = await Promise.all(
        FIXTURES.map(async (f) =>
          fs
            .access(path.join(FIXTURE_DIR, f.file))
            .then(() => false)
            .catch(() => true),
        ),
      );
      if (missing.some(Boolean)) await generateAllFixtures(FIXTURE_DIR);
    })();
  }
  return ready;
}

export async function fixture(name: string): Promise<Buffer> {
  await ensureFixtures();
  return fs.readFile(path.join(FIXTURE_DIR, name));
}

export function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return (
    {
      ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".doc": "application/msword",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    }[ext] ?? "application/octet-stream"
  );
}

export { FIXTURES };
