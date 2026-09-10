/**
 * Application error types. `transient` errors are retried by the queue with
 * exponential backoff; permanent errors fail the job immediately.
 */
export class AppError extends Error {
  status: number;
  code: string;
  transient: boolean;
  details?: unknown;

  constructor(message: string, opts: { status?: number; code?: string; transient?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "AppError";
    this.status = opts.status ?? 500;
    this.code = opts.code ?? "INTERNAL_ERROR";
    this.transient = opts.transient ?? false;
    this.details = opts.details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 400, code: "VALIDATION_ERROR", details });
    this.name = "ValidationError";
  }
}

export class AuthError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, { status: 401, code: "UNAUTHORIZED" });
    this.name = "AuthError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, { status: 403, code: "FORBIDDEN" });
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, { status: 404, code: "NOT_FOUND" });
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests") {
    super(message, { status: 429, code: "RATE_LIMITED", transient: true });
    this.name = "RateLimitError";
  }
}

/** Errors from the processing pipeline. */
export class ProcessingError extends AppError {
  constructor(message: string, code: string, transient = false, details?: unknown) {
    super(message, { status: 500, code, transient, details });
    this.name = "ProcessingError";
  }
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof AppError) return err.transient;
  if (err && typeof err === "object") {
    const e = err as { code?: string; status?: number; name?: string; message?: string };
    const code = String(e.code ?? "");
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return true;
    if (e.name === "AbortError" || e.name === "TimeoutError") return true;
    const status = Number(e.status ?? 0);
    if (status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)) return true;
    const msg = String(e.message ?? "").toLowerCase();
    if (msg.includes("rate limit") || msg.includes("timeout") || msg.includes("timed out") || msg.includes("overloaded") || msg.includes("fetch failed")) return true;
  }
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Unknown error";
}
