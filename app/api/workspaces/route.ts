import { handler, ok, parseJson } from "@/lib/api";
import { requireOwner } from "@/lib/auth";
import { createWorkspace, createWorkspaceSchema, listWorkspaces } from "@/backend/workspaces";

export const dynamic = "force-dynamic";

/**
 * Client workspaces. Platform owner only — a client's own administrator manages
 * people (see /api/users) but never sees that other clients exist.
 *
 *   GET  – every client, with how many people and CVs each holds
 *   POST – create a client and its first administrator together
 */
export const GET = handler(async () => {
  await requireOwner();
  return ok({ workspaces: await listWorkspaces() });
});

export const POST = handler(async (req: Request) => {
  await requireOwner();
  const body = await parseJson(req, createWorkspaceSchema);
  const created = await createWorkspace(body);
  return ok(created, { status: 201 });
});
