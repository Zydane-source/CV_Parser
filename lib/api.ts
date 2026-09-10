import { NextResponse } from "next/server";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { AppError, ValidationError } from "./errors";
import { logger } from "./logger";

/** JSON success response. */
export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, { status: 200, ...init });
}

/** Convert any thrown error into a safe JSON error response. */
export function errorResponse(err: unknown) {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details ?? undefined },
      { status: err.status },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid request", code: "VALIDATION_ERROR", details: err.flatten() },
      { status: 400 },
    );
  }
  logger.error({ err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err }, "Unhandled API error");
  return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
}

/** Wrap a route handler so thrown errors become JSON responses. */
export function handler<Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Parse and validate a JSON body against a schema. */
export async function parseJson<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationError("Invalid request body", result.error.flatten());
  return result.data;
}

/** Parse and validate URL search params against a schema. */
export function parseQuery<S extends ZodTypeAny>(req: Request, schema: S): z.output<S> {
  const url = new URL(req.url);
  const obj: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (obj[k] = v));
  const result = schema.safeParse(obj);
  if (!result.success) throw new ValidationError("Invalid query parameters", result.error.flatten());
  return result.data;
}
