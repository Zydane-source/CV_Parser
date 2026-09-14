import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDashboardStats } from "@/backend/stats";
import { workspaceScope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  return ok(await getDashboardStats(workspaceScope(user)));
});
