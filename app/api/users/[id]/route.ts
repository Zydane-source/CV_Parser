import { z } from "zod";
import { handler, ok, parseJson, parseQuery } from "@/lib/api";
import { requireAdmin, type SessionUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";
import { updateUser, updateUserSchema } from "@/backend/workspaces";
import { workspaceForWrite } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(64);
const querySchema = z.object({ workspaceId: z.string().min(1).max(64).optional() });
type Ctx = { params: Promise<{ id: string }> };

function targetWorkspace(session: SessionUser, requested?: string): string {
  if (!requested) return workspaceForWrite(session);
  if (session.role !== "OWNER") throw new ForbiddenError("You can only manage people in your own client");
  return requested;
}

/**
 * PATCH /api/users/:id – rename, change role, deactivate, or set a new password.
 *
 * The workspace is part of the lookup, not just a check afterwards: an id from
 * another client matches nothing and 404s, so this cannot be used to alter or
 * probe for accounts elsewhere.
 *
 * Deactivating rather than deleting keeps the audit trail — who uploaded which
 * CV stays answerable after someone leaves.
 */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const actor = await requireAdmin();
  const { id } = await ctx.params;
  const { workspaceId } = parseQuery(req, querySchema);
  const patch = await parseJson(req, updateUserSchema);
  const user = await updateUser(actor, targetWorkspace(actor, workspaceId), idSchema.parse(id), patch);
  return ok({ user });
});
