import type { CVFile, ProcessingJob } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { env } from "@/lib/config";
import { getCVQueue, cvJobOptions } from "./queue";

/**
 * Create a ProcessingJob row for a CV file and add it to the BullMQ queue.
 * The DB row is the source of truth for status shown in the UI; the queue job
 * id is stored for correlation.
 */
export async function enqueueCVFile(cvFile: Pick<CVFile, "id">, opts: { batchId?: string; reprocess?: boolean } = {}): Promise<ProcessingJob> {
  const settings = await getSettings();
  const job = await prisma.processingJob.create({
    data: {
      cvFileId: cvFile.id,
      batchId: opts.batchId ?? null,
      status: "PENDING",
      maxAttempts: settings.maxRetries,
    },
  });
  await prisma.cVFile.update({ where: { id: cvFile.id }, data: { status: "PENDING", statusMessage: null } });

  // Inline mode has no worker and no Redis: the DB row *is* the queue, and
  // /api/jobs/drain picks it up. Returning here keeps uploads fast.
  if (env().PROCESSING_MODE === "inline") return job;

  try {
    // BullMQ custom ids must not contain ":" – use "cv-<jobId>".
    const queued = await getCVQueue().add(
      "parse",
      { cvFileId: cvFile.id, processingJobId: job.id, reprocess: opts.reprocess ?? false },
      { ...cvJobOptions(settings.maxRetries, settings.retryBackoffMs), jobId: `cv-${job.id}` },
    );
    return await prisma.processingJob.update({ where: { id: job.id }, data: { queueJobId: String(queued.id) } });
  } catch (err) {
    // Queue unavailable: never leave a phantom PENDING job behind.
    const message = `Could not queue job: ${err instanceof Error ? err.message : String(err)}`;
    await prisma.$transaction([
      prisma.processingJob.update({ where: { id: job.id }, data: { status: "FAILED", errorMessage: message, errorCode: "QUEUE_UNAVAILABLE", completedAt: new Date() } }),
      prisma.cVFile.update({ where: { id: cvFile.id }, data: { status: "FAILED", statusMessage: message } }),
    ]);
    throw err;
  }
}

/** Reprocess a CV: creates a new job; manual corrections are preserved by the processor. */
export async function reprocessCVFile(cvFileId: string, batchId?: string): Promise<ProcessingJob> {
  const active = await prisma.processingJob.findFirst({
    where: { cvFileId, status: { in: ["PENDING", "PROCESSING"] } },
    orderBy: { createdAt: "desc" },
  });
  if (active) return active; // already queued – don't double-process
  return enqueueCVFile({ id: cvFileId }, { batchId, reprocess: true });
}

/** Retry every FAILED CV (optionally limited to a batch). */
export async function retryFailed(batchId?: string): Promise<number> {
  const failed = await prisma.cVFile.findMany({
    where: { status: "FAILED", ...(batchId ? { jobs: { some: { batchId } } } : {}) },
    select: { id: true },
  });
  let n = 0;
  for (const f of failed) {
    await reprocessCVFile(f.id, batchId);
    n++;
  }
  return n;
}
