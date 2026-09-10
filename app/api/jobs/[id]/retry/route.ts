import { z } from "zod";
import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { reprocessCVFile } from "@/services/processing/enqueue";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST /api/jobs/:id/retry – retry a single (failed) processing job. */
export const POST = handler(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const { id } = await ctx.params;
  const job = await prisma.processingJob.findUnique({ where: { id: z.string().min(1).max(64).parse(id) } });
  if (!job) throw new NotFoundError("Job not found");
  const next = await reprocessCVFile(job.cvFileId, job.batchId ?? undefined);
  return ok({ job: next });
});
