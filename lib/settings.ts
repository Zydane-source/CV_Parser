import { z } from "zod";
import { prisma } from "./db";
import { env } from "./config";

/**
 * Runtime settings persisted in the `Setting` table and editable from the
 * Settings page. Environment variables provide defaults. Secrets (API keys,
 * client secrets) are NEVER stored here – they live only in the environment.
 */
export const settingsSchema = z.object({
  confidenceThreshold: z.number().min(0).max(1),
  /** Bands shown in the dashboard. Anything below reviewThreshold needs a human. */
  highConfidenceThreshold: z.number().min(0).max(1),
  reviewThreshold: z.number().min(0).max(1),
  /** Which extraction engine the pipeline uses. Env provides the default. */
  extractionEngine: z.enum(["local", "shadow", "legacy"]),
  maxFileSizeMb: z.number().int().min(1).max(200),
  maxFilesPerRequest: z.number().int().min(1).max(200),
  maxRetries: z.number().int().min(0).max(10),
  retryBackoffMs: z.number().int().min(500).max(600000),
  workerConcurrency: z.number().int().min(1).max(50),
  llmRateLimitPerMinute: z.number().int().min(1).max(10000),
  llmModel: z.string().min(1).max(200),
  llmTemperature: z.number().min(0).max(2),
  llmTimeoutMs: z.number().int().min(1000).max(600000),
  llmPromptVersion: z.string().min(1).max(20),
  maxCvTextChars: z.number().int().min(1000).max(200000),
  ocrMinTextChars: z.number().int().min(0).max(100000),
  ocrMaxPages: z.number().int().min(1).max(50),
  ocrLanguages: z.string().min(2).max(50),
  driveSyncIntervalMinutes: z.number().int().min(1).max(1440),
  driveFolderId: z.string().max(200).nullable(),
  sheetsSpreadsheetId: z.string().max(200).nullable(),
});

export type AppSettings = z.infer<typeof settingsSchema>;

export function defaultSettings(): AppSettings {
  const e = env();
  return {
    confidenceThreshold: e.CONFIDENCE_THRESHOLD,
    highConfidenceThreshold: 0.9,
    reviewThreshold: e.CONFIDENCE_THRESHOLD,
    extractionEngine: e.EXTRACTION_ENGINE,
    maxFileSizeMb: e.MAX_FILE_SIZE_MB,
    maxFilesPerRequest: e.MAX_FILES_PER_REQUEST,
    maxRetries: e.MAX_RETRIES,
    retryBackoffMs: e.RETRY_BACKOFF_MS,
    workerConcurrency: e.WORKER_CONCURRENCY,
    llmRateLimitPerMinute: e.LLM_RATE_LIMIT_PER_MINUTE,
    llmModel: e.LLM_MODEL,
    llmTemperature: e.LLM_TEMPERATURE,
    llmTimeoutMs: e.LLM_TIMEOUT_MS,
    llmPromptVersion: e.LLM_PROMPT_VERSION,
    maxCvTextChars: e.MAX_CV_TEXT_CHARS,
    ocrMinTextChars: e.OCR_MIN_TEXT_CHARS,
    ocrMaxPages: e.OCR_MAX_PAGES,
    ocrLanguages: e.OCR_LANGUAGES,
    driveSyncIntervalMinutes: e.GOOGLE_DRIVE_SYNC_INTERVAL_MINUTES,
    driveFolderId: e.GOOGLE_DRIVE_FOLDER_ID || null,
    sheetsSpreadsheetId: e.GOOGLE_SHEETS_SPREADSHEET_ID || null,
  };
}

const SETTINGS_KEY = "app";
let cache: { value: AppSettings; at: number } | null = null;
const CACHE_TTL_MS = 10_000;

export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const defaults = defaultSettings();
  try {
    const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    const merged = settingsSchema.parse({ ...defaults, ...((row?.value as object) ?? {}) });
    cache = { value: merged, at: Date.now() };
    return merged;
  } catch {
    return defaults;
  }
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = settingsSchema.parse({ ...current, ...patch });
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: next },
    update: { value: next },
  });
  cache = { value: next, at: Date.now() };
  return next;
}

export function invalidateSettingsCache() {
  cache = null;
}
