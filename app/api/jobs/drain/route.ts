import { NextResponse, after } from "next/server";
import { handler, ok } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { env } from "@/lib/config";
import { AuthError } from "@/lib/errors";
import { drainPendingJobs } from "@/services/processing/drain";
import { effectiveProcessingMode } from "@/lib/processing-mode";
import { syncDueConnections } from "@/services/google-drive/due";
import { beat, endChain, kickBackgroundDrain, startLink } from "@/services/processing/background";
import { logger } from "@/lib/logger";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 60s is the Vercel Hobby ceiling; a higher value fails the build there. Raise to
// 300 on Pro together with DRAIN_TIME_BUDGET_MS. The drain loop stops starting new
// CVs at 70% of DRAIN_TIME_BUDGET_MS, so it finishes well inside this limit.
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

/**
 * One link of a background chain (see services/processing/background.ts).
 *
 * Answers 202 immediately so the link that started it is not kept waiting, then
 * drains for most of this invocation's time limit and hands over to a successor
 * if CVs are still waiting. Two links in a row that find nothing to claim end the
 * chain, so it cannot spin on work another chain has already taken.
 */
function backgroundLink(req: Request, url: URL) {
  const chainId = url.searchParams.get("chain") || "anon";
  const idle = Number(url.searchParams.get("idle") || "0") || 0;
  const origin = url.origin;
  after(async () => {
    try {
      await beat(chainId);
      const result = await drainPendingJobs({});
      const nextIdle = result.claimed === 0 ? idle + 1 : 0;
      if (result.remaining > 0 && nextIdle < 2) {
        await beat(chainId);
        if (!(await startLink(origin, chainId, nextIdle))) await endChain(chainId);
      } else {
        await endChain(chainId);
      }
      logger.info({ chainId, ...result }, "background: link finished");
    } catch (err) {
      logger.error({ chainId, err: errorMessage(err) }, "background: link failed");
      await endChain(chainId).catch(() => undefined);
    }
  });
  return NextResponse.json({ accepted: true, chain: chainId }, { status: 202 });
}

export const POST = handler(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.get("background") === "1") {
    // Background links are server-to-server only: a browser session is not enough.
    const secret = env().CRON_SECRET;
    if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) throw new AuthError("Background drain requires the cron secret");
    return backgroundLink(req, url);
  }
  await authorize(req);
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
  // Whatever the scheduled call could not finish continues in background chains.
  const origin = new URL(req.url).origin;
  after(() => kickBackgroundDrain(origin, "cron").then(() => undefined, () => undefined));
  return NextResponse.json({ ...result, drive, mode: effectiveProcessingMode() });
});
