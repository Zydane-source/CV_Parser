import { handler, ok, parseQuery } from "@/lib/api";
import { requireOwner } from "@/lib/auth";
import { dayQuerySchema, getWorkspaceDay } from "@/backend/activity";

export const dynamic = "force-dynamic";

/** GET /api/activity/day?date=&tz= — every CV fetched that day, by client, with times. Owner only. */
export const GET = handler(async (req: Request) => {
  await requireOwner();
  return ok(await getWorkspaceDay(null, parseQuery(req, dayQuerySchema)));
});
