import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const jobFiltersSchema = z.object({
  batchId: z.string().max(100).optional(),
  status: z.enum(["PENDING", "PROCESSING", "PROCESSED", "NEEDS_REVIEW", "FAILED", "SKIPPED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type JobFilters = z.infer<typeof jobFiltersSchema>;

export const jobSelect = {
  id: true,
  cvFileId: true,
  batchId: true,
  status: true,
  stage: true,
  attempts: true,
  maxAttempts: true,
  errorMessage: true,
  errorCode: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  cvFile: { select: { fileName: true, sourceType: true, status: true, candidate: { select: { id: true, candidateName: true, overallConfidence: true } } } },
} satisfies Prisma.ProcessingJobSelect;

export async function listJobs(f: JobFilters) {
  const where: Prisma.ProcessingJobWhereInput = {};
  if (f.batchId) where.batchId = f.batchId;
  if (f.status) where.status = f.status;
  const [total, items] = await Promise.all([
    prisma.processingJob.count({ where }),
    prisma.processingJob.findMany({ where, select: jobSelect, orderBy: { createdAt: "desc" }, skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
  ]);
  return { items, total, page: f.page, pageSize: f.pageSize, pages: Math.max(1, Math.ceil(total / f.pageSize)) };
}

/**
 * Progress summary for a batch (or the last 24 hours).
 *
 * Counts distinct CVs, not ProcessingJob rows: a CV that was retried has several
 * job rows, and counting those inflated the totals and made "Retry all failed
 * (N)" disagree with the number of CVs the retry action actually re-queues.
 */
export async function batchProgress(batchId?: string) {
  const where: Prisma.CVFileWhereInput = batchId
    ? { jobs: { some: { batchId } } }
    : { jobs: { some: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } } };
  const rows = await prisma.cVFile.groupBy({ by: ["status"], where, _count: { _all: true } });
  const c = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
  const total = rows.reduce((a, r) => a + r._count._all, 0);
  const done = c("PROCESSED") + c("NEEDS_REVIEW") + c("FAILED") + c("SKIPPED");
  return { total, done, pending: c("PENDING"), processing: c("PROCESSING"), processed: c("PROCESSED"), needsReview: c("NEEDS_REVIEW"), failed: c("FAILED"), skipped: c("SKIPPED") };
}
