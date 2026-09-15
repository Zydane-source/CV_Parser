import { z } from "zod";
import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { reprocessCVFile } from "@/services/processing/enqueue";
import { kickAfterResponse } from "@/services/processing/background";
import { workspaceScope } from "@/lib/tenant";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST /api/jobs/:id/retry – retry a single (failed) processing job. */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  // A job inherits its client from the CV it processes, so the restriction rides
  // the relation rather than sitting on the job row.
  const job = await prisma.processingJob.findFirst({
    where: { id: z.string().min(1).max(64).parse(id), cvFile: { ...workspaceScope(user) } },
  });
  if (!job) throw new NotFoundError("Job not found");
  const next = await reprocessCVFile(job.cvFileId, job.batchId ?? undefined);
  kickAfterResponse(req, "retry");
  return ok({ job: next });
});
