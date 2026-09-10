import { z } from "zod";
import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { reprocessCVFile } from "@/services/processing/enqueue";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST /api/candidates/:id/reprocess – re-run the pipeline (manual corrections preserved). */
export const POST = handler(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const { id } = await ctx.params;
  const cvFileId = z.string().min(1).max(64).parse(id);
  const cv = await prisma.cVFile.findUnique({ where: { id: cvFileId }, select: { id: true } });
  if (!cv) throw new NotFoundError("CV not found");
  const job = await reprocessCVFile(cvFileId);
  return ok({ job });
});
