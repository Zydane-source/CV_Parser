import { z } from "zod";
import { handler, ok, parseJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { candidateUpdateSchema, getCandidateDetail, updateCandidate } from "@/backend/candidates";
import { deleteCVs } from "@/backend/delete";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(64);
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/candidates/:id – full detail (id is the CV file id). */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const { id } = await ctx.params;
  return ok(await getCandidateDetail(idSchema.parse(id)));
});

/** PATCH /api/candidates/:id – manual correction (marks is_manually_corrected). */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  await requireUser();
  const { id } = await ctx.params;
  const patch = await parseJson(req, candidateUpdateSchema);
  const candidate = await updateCandidate(idSchema.parse(id), patch);
  return ok({ candidate, detail: await getCandidateDetail(id) });
});

/**
 * DELETE /api/candidates/:id[?ignoreFutureSync=false]
 *
 * Removes the CV, its extracted candidate, its job history and the stored file.
 * A Google Drive file is only unlinked from the app – the Drive file itself is
 * never touched – and by default is also excluded from future syncs so it does
 * not immediately reappear.
 */
export const DELETE = handler(async (req: Request, ctx: Ctx) => {
  await requireUser();
  const { id } = await ctx.params;
  const ignoreFutureSync = new URL(req.url).searchParams.get("ignoreFutureSync") !== "false";
  const result = await deleteCVs({ ids: [idSchema.parse(id)], ignoreFutureSync });
  if (result.deleted === 0) throw new NotFoundError("CV not found");
  return ok(result);
});
