import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getWorkerHealth } from "@/lib/worker-health";
import { prisma } from "@/lib/db";
import { env } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/worker-status – cheap authenticated liveness check for the UI banner.
 * Unlike /api/health this includes the provider error text, so it stays behind auth.
 */
export const GET = handler(async () => {
  await requireUser();
  const mode = env().PROCESSING_MODE;
  const [worker, pending] = await Promise.all([
    mode === "inline" ? Promise.resolve({ online: true, count: 0, workers: [], configError: null }) : getWorkerHealth(),
    prisma.processingJob.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
  ]);
  // In inline mode there is no worker process by design; the browser and the
  // cron drain the queue, so the "no worker" alarm must not fire.
  return ok({ worker, pending, mode });
});
