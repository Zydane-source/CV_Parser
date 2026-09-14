import { handler, ok, parseQuery } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { jobFiltersSchema, listJobs, batchProgress } from "@/backend/jobs";
import { workspaceScope } from "@/lib/tenant";
import { getQueueCounts } from "@/services/processing/queue";
import { getWorkerHealth } from "@/lib/worker-health";

export const dynamic = "force-dynamic";

/** GET /api/jobs?batchId=&status=&page=&pageSize= */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const f = parseQuery(req, jobFiltersSchema);
  const scope = workspaceScope(user);
  const [list, progress, queue, worker] = await Promise.all([
    listJobs(scope, f),
    batchProgress(scope, f.batchId),
    getQueueCounts().catch(() => null),
    getWorkerHealth(),
  ]);
  return ok({ ...list, progress, queue, worker });
});
