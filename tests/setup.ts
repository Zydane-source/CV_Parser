/**
 * Vitest setup: load .env (if present) and provide safe defaults so unit tests
 * never need real credentials. Integration tests that require external services
 * check for their own env vars and skip when absent.
 */
import "dotenv/config";

const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.NODE_ENV = mutableEnv.NODE_ENV || "test";
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-at-least-32-characters-long";
process.env.APP_URL = process.env.APP_URL || "http://localhost:3000";
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || "local";
process.env.LOCAL_STORAGE_PATH = process.env.TEST_STORAGE_PATH || "./tests/fixtures/generated/storage";
process.env.OCR_CACHE_PATH = process.env.OCR_CACHE_PATH || "./.tesseract-cache";
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || "silent";
// Isolate test queues so a live `npm run worker` on the same Redis does not
// consume (and fail) jobs that the e2e suite enqueues for its own worker.
process.env.QUEUE_PREFIX = process.env.QUEUE_PREFIX || `test${process.pid}`;

/**
 * Safety guard. The integration/e2e suites write and delete rows (including any
 * CV whose content matches a bundled fixture), so they must never be pointed at
 * a shared or production database by accident.
 *
 * Local hosts are allowed automatically; anything else requires an explicit
 * ALLOW_DESTRUCTIVE_TESTS=yes.
 */
const dbUrl = process.env.DATABASE_URL ?? "";
if (dbUrl && process.env.ALLOW_DESTRUCTIVE_TESTS !== "yes") {
  let host = "";
  try {
    host = new URL(dbUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const isLocal = ["localhost", "127.0.0.1", "::1", "host.docker.internal", "postgres", "db"].includes(host);
  if (host && !isLocal) {
    throw new Error(
      `Refusing to run tests against a non-local database (${host}). ` +
        `These tests create and delete rows. Point DATABASE_URL at a local/test database, ` +
        `or set ALLOW_DESTRUCTIVE_TESTS=yes if you really mean it.`,
    );
  }
}
