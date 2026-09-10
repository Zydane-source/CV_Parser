import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redisHealthy } from "@/lib/redis";
import { env } from "@/lib/config";
import { getWorkerHealth } from "@/lib/worker-health";

export const dynamic = "force-dynamic";

export async function GET() {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  const mode = env().PROCESSING_MODE;
  // Redis is only a dependency when a BullMQ worker is doing the processing.
  const redis = mode === "inline" ? true : await redisHealthy();
  const worker =
    mode === "inline"
      ? { online: true, count: 0, workers: [], configError: null } // drained by cron + browser, no process to check
      : redis
        ? await getWorkerHealth()
        : { online: false, count: 0, workers: [], configError: null };

  // db + redis are hard dependencies; a missing worker is degraded, not down,
  // but it must be visible because queued CVs will never progress without it.
  // This endpoint is unauthenticated, so it reports liveness only – never the
  // provider error text, which can echo back parts of a credential.
  const ok = db && redis && worker.online;
  return NextResponse.json(
    {
      ok,
      db,
      redis,
      worker: { online: worker.online, count: worker.count, degraded: Boolean(worker.configError) },
      time: new Date().toISOString(),
    },
    { status: db && redis ? (worker.online ? 200 : 503) : 503 },
  );
}
