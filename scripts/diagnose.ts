/**
 * Diagnostic: prints the real state of the processing pipeline.
 *   npx tsx scripts/diagnose.ts
 *
 * Checks database job/file status, the Redis queue depth, worker heartbeats and
 * the configured LLM/storage/Google settings (secrets are never printed).
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import IORedis from "ioredis";

const prisma = new PrismaClient();

async function main() {
  console.log("=== CV Parser diagnosis ===\n");

  // 1. Config (masked)
  const key = process.env.LLM_API_KEY ?? "";
  console.log("Config:");
  console.log("  LLM_PROVIDER  :", process.env.LLM_PROVIDER || "(unset)");
  console.log("  LLM_MODEL     :", process.env.LLM_MODEL || "(unset)");
  console.log("  LLM_BASE_URL  :", process.env.LLM_BASE_URL || "(default)");
  console.log("  LLM_API_KEY   :", key ? `${key.slice(0, 7)}…${key.slice(-4)} (${key.length} chars)` : "(EMPTY)");
  console.log("  DATABASE_URL  :", process.env.DATABASE_URL ? "set" : "(EMPTY)");
  console.log("  REDIS_URL     :", process.env.REDIS_URL || "(unset)");
  console.log("  STORAGE_DRIVER:", process.env.STORAGE_DRIVER || "local", "->", process.env.LOCAL_STORAGE_PATH || "./uploads");
  console.log();

  // 2. Database
  const byStatus = await prisma.cVFile.groupBy({ by: ["status"], _count: { _all: true } });
  console.log("CVFile status:");
  for (const r of byStatus) console.log(`  ${r.status.padEnd(13)} ${r._count._all}`);

  const jobsByStatus = await prisma.processingJob.groupBy({ by: ["status"], _count: { _all: true } });
  console.log("ProcessingJob status:");
  for (const r of jobsByStatus) console.log(`  ${r.status.padEnd(13)} ${r._count._all}`);
  console.log();

  const errs = await prisma.processingJob.groupBy({
    by: ["errorCode"],
    where: { status: "FAILED" },
    _count: { _all: true },
  });
  if (errs.length) {
    console.log("Failure reasons:");
    for (const e of errs) console.log(`  ${(e.errorCode ?? "(none)").padEnd(22)} ${e._count._all}`);
    const sample = await prisma.processingJob.findFirst({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      select: { errorCode: true, errorMessage: true, attempts: true, cvFile: { select: { fileName: true, mimeType: true, fileSize: true } } },
    });
    console.log("  latest:", JSON.stringify(sample, null, 2).slice(0, 900));
    console.log();
  }

  const pending = await prisma.processingJob.findMany({
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, queueJobId: true, status: true, stage: true, attempts: true, createdAt: true, cvFile: { select: { fileName: true, storagePath: true, sourceType: true } } },
  });
  console.log(`Pending/processing jobs: ${pending.length}`);
  for (const p of pending) {
    const ageMin = ((Date.now() - p.createdAt.getTime()) / 60000).toFixed(1);
    console.log(`  ${p.cvFile.fileName} | ${p.status} stage=${p.stage ?? "-"} attempts=${p.attempts} age=${ageMin}min queueJobId=${p.queueJobId ?? "NONE"} storage=${p.cvFile.storagePath ?? "-"}`);
  }
  console.log();

  // 3. Redis / queue
  const redis = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null, lazyConnect: true });
  try {
    await redis.connect();
    const q = "bull:cv-processing";
    const [waiting, active, delayed, failed, completed, paused] = await Promise.all([
      redis.llen(`${q}:wait`),
      redis.llen(`${q}:active`),
      redis.zcard(`${q}:delayed`),
      redis.zcard(`${q}:failed`),
      redis.zcard(`${q}:completed`),
      redis.exists(`${q}:meta`).then(() => redis.hget(`${q}:meta`, "paused")),
    ]);
    console.log("BullMQ cv-processing queue:");
    console.log(`  waiting=${waiting} active=${active} delayed=${delayed} failed=${failed} completed=${completed} paused=${paused ?? "0"}`);

    // Any worker attached? BullMQ registers consumer groups / heartbeat keys per worker.
    const clients = (await redis.client("LIST")) as string;
    const blocked = clients.split("\n").filter((l) => l.includes("cmd=brpoplpush") || l.includes("cmd=bzpopmin") || l.includes("cmd=blmove")).length;
    console.log(`  redis clients blocked on queue (≈ live workers): ${blocked}`);
    if (blocked === 0) console.log("  >>> NO WORKER IS CONSUMING THIS QUEUE — jobs will stay PENDING. Run: npm run worker");

    const waitingIds = await redis.lrange(`${q}:wait`, 0, 9);
    if (waitingIds.length) console.log("  first waiting job ids:", waitingIds.join(", "));
  } catch (err) {
    console.log("Redis check failed:", (err as Error).message);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

main()
  .catch((e) => {
    console.error("diagnose failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
