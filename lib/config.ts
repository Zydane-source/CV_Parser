import { z } from "zod";

/**
 * Environment configuration, validated once at startup.
 * Secrets never leave the server: only `publicConfigSummary()` is exposed to the UI,
 * and it reports whether a credential is set – never its value.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());

const str = (def = "") =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v));

const envSchema = z.object({
  NODE_ENV: str("development"),
  APP_URL: str("http://localhost:3000"),
  AUTH_SECRET: str(""),
  TOKEN_ENCRYPTION_KEY: str(""),
  ADMIN_EMAIL: str("admin@example.com"),
  ADMIN_PASSWORD: str(""),
  ADMIN_NAME: str("Admin"),

  DATABASE_URL: str(""),
  REDIS_URL: str("redis://localhost:6379"),
  WORKER_CONCURRENCY: num(3),
  LLM_RATE_LIMIT_PER_MINUTE: num(60),
  MAX_RETRIES: num(3),
  RETRY_BACKOFF_MS: num(5000),

  GOOGLE_CLIENT_ID: str(""),
  GOOGLE_CLIENT_SECRET: str(""),
  GOOGLE_REDIRECT_URI: str(""),
  GOOGLE_DRIVE_FOLDER_ID: str(""),
  GOOGLE_SHEETS_SPREADSHEET_ID: str(""),
  GOOGLE_DRIVE_SYNC_INTERVAL_MINUTES: num(5),

  LLM_PROVIDER: z.enum(["openai", "anthropic"]).optional().default("openai"),
  LLM_API_KEY: str(""),
  LLM_MODEL: str("gpt-4o-mini"),
  LLM_BASE_URL: str(""),
  LLM_TIMEOUT_MS: num(60000),
  LLM_TEMPERATURE: num(0),
  LLM_PROMPT_VERSION: str("v1"),

  OCR_PROVIDER: str("tesseract"),
  OCR_LANGUAGES: str("eng"),
  OCR_CACHE_PATH: str("./.tesseract-cache"),
  OCR_MIN_TEXT_CHARS: num(150),
  OCR_MAX_PAGES: num(5),

  STORAGE_DRIVER: z.enum(["local", "s3"]).optional().default("local"),
  LOCAL_STORAGE_PATH: str("./uploads"),
  STORAGE_BUCKET: str(""),
  STORAGE_REGION: str(""),
  STORAGE_ENDPOINT: str(""),
  STORAGE_ACCESS_KEY: str(""),
  STORAGE_SECRET_KEY: str(""),
  STORAGE_FORCE_PATH_STYLE: bool,

  MAX_FILE_SIZE_MB: num(15),
  MAX_FILES_PER_REQUEST: num(25),
  CONFIDENCE_THRESHOLD: num(0.75),
  MAX_CV_TEXT_CHARS: num(20000),

  LOG_LEVEL: str("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the cache (tests). */
export function resetEnvCache() {
  cached = null;
}

export const isProduction = () => env().NODE_ENV === "production";

export const SUPPORTED_MIME_TYPES: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};

export const SUPPORTED_EXTENSIONS = Object.values(SUPPORTED_MIME_TYPES).flat();

/** Non-secret configuration summary safe to show in the Settings UI. */
export function publicConfigSummary() {
  const e = env();
  return {
    appUrl: e.APP_URL,
    llm: {
      provider: e.LLM_PROVIDER,
      model: e.LLM_MODEL,
      baseUrl: e.LLM_BASE_URL || (e.LLM_PROVIDER === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
      apiKeyConfigured: Boolean(e.LLM_API_KEY),
      promptVersion: e.LLM_PROMPT_VERSION,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    google: {
      clientConfigured: Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
      redirectUri: e.GOOGLE_REDIRECT_URI || `${e.APP_URL}/api/google-drive/callback`,
      defaultFolderId: e.GOOGLE_DRIVE_FOLDER_ID || null,
      defaultSpreadsheetId: e.GOOGLE_SHEETS_SPREADSHEET_ID || null,
      webhooksEnabled: e.APP_URL.startsWith("https://"),
    },
    ocr: {
      provider: e.OCR_PROVIDER,
      languages: e.OCR_LANGUAGES,
    },
    storage: {
      driver: e.STORAGE_DRIVER,
      bucket: e.STORAGE_DRIVER === "s3" ? e.STORAGE_BUCKET : null,
      configured: e.STORAGE_DRIVER === "local" || Boolean(e.STORAGE_BUCKET && e.STORAGE_ACCESS_KEY && e.STORAGE_SECRET_KEY),
    },
    queue: {
      redisConfigured: Boolean(e.REDIS_URL),
      workerConcurrency: e.WORKER_CONCURRENCY,
    },
  };
}
