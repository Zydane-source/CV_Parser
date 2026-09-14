import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { topJobRoles } from "@/backend/candidates";
import { workspaceScope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** GET /api/candidates/roles – distinct job roles for filters. */
export const GET = handler(async () => {
  const user = await requireUser();
  return ok({ roles: await topJobRoles(workspaceScope(user)) });
});
