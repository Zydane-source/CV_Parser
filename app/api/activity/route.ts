import { handler, ok, parseQuery } from "@/lib/api";
import { requireOwner } from "@/lib/auth";
import { activityQuerySchema, getWorkspaceActivity } from "@/backend/activity";

export const dynamic = "force-dynamic";

/** GET /api/activity?from=&to=&tz= — CVs fetched per day across every client. Owner only. */
export const GET = handler(async (req: Request) => {
  await requireOwner();
  return ok(await getWorkspaceActivity(null, parseQuery(req, activityQuerySchema)));
});
