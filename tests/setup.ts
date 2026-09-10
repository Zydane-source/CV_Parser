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
