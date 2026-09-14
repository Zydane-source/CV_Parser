import { z } from "zod";
import { handler, ok, parseJson, parseQuery } from "@/lib/api";
import { requireAdmin, type SessionUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";
import { createUser, createUserSchema, listUsers } from "@/backend/workspaces";
import { workspaceForWrite } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * The people in a client workspace.
 *
 *   GET  – everyone in the client
 *   POST – add an administrator or a recruiter
 *
 * An administrator manages their own client and nothing else, so the workspace
 * comes from the session rather than the request body. The platform owner has no
 * workspace of their own and must name one with ?workspaceId= — the only place
 * this route reads a workspace from the request, and it is refused for anyone
 * but the owner.
 */
const querySchema = z.object({ workspaceId: z.string().min(1).max(64).optional() });

function targetWorkspace(session: SessionUser, requested?: string): string {
  if (!requested) return workspaceForWrite(session);
  if (session.role !== "OWNER") throw new ForbiddenError("You can only manage people in your own client");
  return requested;
}

export const GET = handler(async (req: Request) => {
  const user = await requireAdmin();
  const { workspaceId } = parseQuery(req, querySchema);
  return ok({ users: await listUsers(targetWorkspace(user, workspaceId)) });
});

export const POST = handler(async (req: Request) => {
  const user = await requireAdmin();
  const { workspaceId } = parseQuery(req, querySchema);
  const body = await parseJson(req, createUserSchema);
  const created = await createUser(targetWorkspace(user, workspaceId), body);
  return ok({ user: created }, { status: 201 });
});
