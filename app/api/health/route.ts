import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redisHealthy } from "@/lib/redis";
import { effectiveProcessingMode, processingModeWasDowngraded } from "@/lib/processing-mode";
import { getWorkerHealth } from "@/lib/worker-health";
import { effectiveStorageDriver, getStorage } from "@/services/storage";

export const dynamic = "force-dynamic";

export async function GET() {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  const mode = effectiveProcessingMode();

  // Uploads fail before they reach a per-file error when storage is
  // misconfigured, so report it here: it is the difference between a useful
  // answer and an anonymous 500 nobody outside the platform logs can see.
  // Only a boolean and the driver name: this endpoint is unauthenticated, and
  // the ConfigError text names environment variables. The full message reaches
  // whoever tried the upload, who is authenticated.
  let storage: { driver: string; ok: boolean };
  try {
    storage = { driver: getStorage().name, ok: true };
  } catch {
    storage = { driver: effectiveStorageDriver(), ok: false };
  }
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
  const ok = db && redis && storage.ok && worker.online;
  return NextResponse.json(
    {
      ok,
      db,
      redis,
      mode,
      storage,
      // True when PROCESSING_MODE=queue was configured but cannot be honoured
      // here, so the app is draining inline instead. Reported because the
      // alternative is CVs sitting at Pending with no visible reason.
      modeDowngraded: processingModeWasDowngraded(),
      worker: { online: worker.online, count: worker.count, degraded: Boolean(worker.configError) },
      time: new Date().toISOString(),
    },
    { status: db && redis && storage.ok ? (worker.online ? 200 : 503) : 503 },
  );
}
