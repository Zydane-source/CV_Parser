import { z } from "zod";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireOwner } from "@/lib/auth";
import { dayQuerySchema, getWorkspaceDay } from "@/backend/activity";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/workspaces/:id/activity/day?date=YYYY-MM-DD&tz= — each CV fetched that day, with its time. Owner only. */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  await requireOwner();
  const { id } = await ctx.params;
  return ok(await getWorkspaceDay(z.string().min(1).max(64).parse(id), parseQuery(req, dayQuerySchema)));
});
