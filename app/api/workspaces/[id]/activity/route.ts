import { z } from "zod";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireOwner } from "@/lib/auth";
import { activityQuerySchema, getWorkspaceActivity } from "@/backend/activity";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/workspaces/:id/activity?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Asia/Kolkata — CVs fetched per day. Owner only. */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  await requireOwner();
  const { id } = await ctx.params;
  return ok(await getWorkspaceActivity(z.string().min(1).max(64).parse(id), parseQuery(req, activityQuerySchema)));
});
