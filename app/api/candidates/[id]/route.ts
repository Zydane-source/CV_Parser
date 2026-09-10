import { z } from "zod";
import { handler, ok, parseJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { candidateUpdateSchema, getCandidateDetail, updateCandidate } from "@/backend/candidates";

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
