import { after } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { kickBackgroundDrain, backgroundAvailable, activeChains } from "@/services/processing/background";
import { recoverStaleJobs } from "@/services/processing/drain";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/jobs/kick — make sure waiting CVs are being processed.
 *
 * The app calls this while it shows CVs pending. It returns at once with the
 * current state and starts background chains after responding, so a slow cold
 * start never makes the page feel stuck. Starting chains is idempotent and
 * capped, so calling it every few seconds is safe.
 */
export const POST = handler(async (req: Request) => {
  await requireUser();
  const background = backgroundAvailable();
  await recoverStaleJobs().catch(() => 0);
  const [pending, active] = await Promise.all([prisma.processingJob.count({ where: { status: "PENDING" } }), background ? activeChains() : Promise.resolve(0)]);
  if (background && pending > 0) {
    const origin = new URL(req.url).origin;
    after(() => kickBackgroundDrain(origin, "app").then(() => undefined, () => undefined));
  }
  return ok({ background, pending, active });
});
