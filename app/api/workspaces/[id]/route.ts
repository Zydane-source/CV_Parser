import { z } from "zod";
import { handler, ok, parseJson } from "@/lib/api";
import { requireOwner } from "@/lib/auth";
import { listUsers, updateWorkspace, updateWorkspaceSchema } from "@/backend/workspaces";

export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(64);
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/workspaces/:id/… – the people in one client. Owner only. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  await requireOwner();
  const { id } = await ctx.params;
  return ok({ users: await listUsers(idSchema.parse(id)) });
});

/**
 * PATCH /api/workspaces/:id – rename, or suspend and restore.
 *
 * Deactivating is the deliberate alternative to deleting: it stops everyone in
 * the client signing in while keeping every CV, so ending an engagement is
 * reversible and does not destroy the work.
 */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  await requireOwner();
  const { id } = await ctx.params;
  const patch = await parseJson(req, updateWorkspaceSchema);
  return ok({ workspace: await updateWorkspace(idSchema.parse(id), patch) });
});
