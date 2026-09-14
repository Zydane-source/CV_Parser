import { z } from "zod";
import { handler, ok } from "@/lib/api";
import { requireOwner } from "@/lib/auth";
import { approveSignup, rejectSignup } from "@/backend/signup";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idSchema = z.string().min(1).max(64);

/** POST /api/signup-requests/:id — approve: creates the client; the applicant signs in with the password they chose. */
export const POST = handler(async (_req: Request, ctx: Ctx) => {
  await requireOwner();
  const { id } = await ctx.params;
  return ok(await approveSignup(idSchema.parse(id)), { status: 201 });
});

/** DELETE /api/signup-requests/:id — reject. */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  await requireOwner();
  const { id } = await ctx.params;
  await rejectSignup(idSchema.parse(id));
  return ok({ rejected: true });
});
