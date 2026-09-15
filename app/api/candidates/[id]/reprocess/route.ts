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

/** POST /api/candidates/:id/reprocess – re-run the pipeline (manual corrections preserved). */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const cvFileId = z.string().min(1).max(64).parse(id);
  // The existence check is also the access check: a CV in another workspace does
  // not match, so it 404s instead of being re-queued at another client's expense.
  const cv = await prisma.cVFile.findFirst({ where: { id: cvFileId, ...workspaceScope(user) }, select: { id: true } });
  if (!cv) throw new NotFoundError("CV not found");
  const job = await reprocessCVFile(cvFileId);
  kickAfterResponse(req, "reprocess");
  return ok({ job });
});
