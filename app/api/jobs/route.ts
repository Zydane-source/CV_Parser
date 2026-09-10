import { handler, ok, parseQuery } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { jobFiltersSchema, listJobs, batchProgress } from "@/backend/jobs";
import { getQueueCounts } from "@/services/processing/queue";
import { getWorkerHealth } from "@/lib/worker-health";

export const dynamic = "force-dynamic";

/** GET /api/jobs?batchId=&status=&page=&pageSize= */
export const GET = handler(async (req: Request) => {
  await requireUser();
  const f = parseQuery(req, jobFiltersSchema);
  const [list, progress, queue, worker] = await Promise.all([
    listJobs(f),
    batchProgress(f.batchId),
    getQueueCounts().catch(() => null),
    getWorkerHealth(),
  ]);
  return ok({ ...list, progress, queue, worker });
});
