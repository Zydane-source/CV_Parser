import pino from "pino";

/**
 * Structured logger with PII redaction.
 * CV text, phone numbers and candidate names must never reach logs; the redact
 * list below strips them if any caller accidentally includes such keys.
 */
const REDACT_PATHS = [
  "text",
  "cvText",
  "rawText",
  "phone",
  "phoneNumber",
  "phone_number",
  "candidateName",
  "candidate_name",
  "email",
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  "authorization",
  "apiKey",
  "password",
  "*.text",
  "*.cvText",
  "*.phoneNumber",
  "*.candidateName",
  "*.accessToken",
  "*.refreshToken",
  "*.password",
];

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  base: { service: "cv-parser" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
