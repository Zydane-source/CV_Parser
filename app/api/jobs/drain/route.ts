import { NextResponse } from "next/server";
import { handler, ok } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { env } from "@/lib/config";
import { AuthError } from "@/lib/errors";
import { drainPendingJobs } from "@/services/processing/drain";
import { effectiveProcessingMode } from "@/lib/processing-mode";
import { syncDueConnections } from "@/services/google-drive/due";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 60s is the Vercel Hobby ceiling; a higher value fails the build there. Raise to
// 300 on Pro if you also raise DRAIN_BATCH_SIZE. The drain loop stops starting new
// CVs at 60% of DRAIN_TIME_BUDGET_MS, so it finishes well inside this limit.
export const maxDuration = 60;

/**
 * POST /api/jobs/drain – process a few pending CVs and return.
 *
 * Replaces the always-on worker on serverless platforms. Two callers are
 * allowed: a signed-in user (the browser pumps this while a batch is running)
 * and a scheduler presenting CRON_SECRET as a bearer token (Vercel Cron), so a
 * batch still completes after the tab is closed.
 *
 * A scheduled call also polls any connected Google Drive folder that is due,
 * because in inline mode there is no worker to run the repeatable sync job. The
 * poll runs first so that anything it discovers is processed by the same
 * invocation rather than waiting for the next one.
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

/**
 * Poll Drive only for scheduled calls, and only when nothing else can.
 *
 * The browser pumps this endpoint every few seconds while a batch runs; letting
 * those calls hit the Drive API would burn quota for no benefit. In queue mode
 * the worker owns the polling, so this stays out of the way entirely.
 */
async function maybeSyncDrive(scheduled: boolean) {
  if (!scheduled || effectiveProcessingMode() !== "inline") return null;
  try {
    return await syncDueConnections();
  } catch {
    // Drive being unreachable must never stop CVs already in the queue.
    return null;
  }
}

export const POST = handler(async (req: Request) => {
  await authorize(req);
  const url = new URL(req.url);
  const max = Number(url.searchParams.get("max") ?? "") || undefined;
  const scheduled = req.headers.get("authorization") === `Bearer ${env().CRON_SECRET}` && Boolean(env().CRON_SECRET);
  const drive = await maybeSyncDrive(scheduled);
  const result = await drainPendingJobs({ max });
  return ok({ ...result, drive, mode: effectiveProcessingMode() });
});

/** Vercel Cron issues GET requests, so accept both verbs. */
export const GET = handler(async (req: Request) => {
  await authorize(req);
  // Vercel Cron issues GET, so this is the scheduled path in production.
  const drive = await maybeSyncDrive(true);
  const result = await drainPendingJobs({});
  return NextResponse.json({ ...result, drive, mode: effectiveProcessingMode() });
});
