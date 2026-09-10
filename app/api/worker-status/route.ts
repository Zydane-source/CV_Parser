import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getWorkerHealth } from "@/lib/worker-health";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/worker-status – cheap authenticated liveness check for the UI banner.
 * Unlike /api/health this includes the provider error text, so it stays behind auth.
 */
export const GET = handler(async () => {
  await requireUser();
  const [worker, pending] = await Promise.all([
    getWorkerHealth(),
    prisma.processingJob.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
  ]);
  return ok({ worker, pending });
});
