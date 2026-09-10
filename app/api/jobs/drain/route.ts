import { NextResponse } from "next/server";
import { handler, ok } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { env } from "@/lib/config";
import { AuthError } from "@/lib/errors";
import { drainPendingJobs } from "@/services/processing/drain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Serverless ceiling. OCR of a scanned PDF plus an LLM call needs headroom.
export const maxDuration = 300;

/**
 * POST /api/jobs/drain – process a few pending CVs and return.
 *
 * Replaces the always-on worker on serverless platforms. Two callers are
 * allowed: a signed-in user (the browser pumps this while a batch is running)
 * and a scheduler presenting CRON_SECRET as a bearer token (Vercel Cron), so a
 * batch still completes after the tab is closed.
 */
async function authorize(req: Request): Promise<void> {
  const secret = env().CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth === `Bearer ${secret}`) return;
  }
  const session = await getSession();
  if (session) return;
  throw new AuthError("Sign in, or present the cron secret, to drain the queue");
}

export const POST = handler(async (req: Request) => {
  await authorize(req);
  const url = new URL(req.url);
  const max = Number(url.searchParams.get("max") ?? "") || undefined;
  const result = await drainPendingJobs({ max });
  return ok({ ...result, mode: env().PROCESSING_MODE });
});

/** Vercel Cron issues GET requests, so accept both verbs. */
export const GET = handler(async (req: Request) => {
  await authorize(req);
  const result = await drainPendingJobs({});
  return NextResponse.json({ ...result, mode: env().PROCESSING_MODE });
});
