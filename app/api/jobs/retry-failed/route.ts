import { z } from "zod";
import { handler, ok, parseJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { retryFailed } from "@/services/processing/enqueue";
import { kickAfterResponse } from "@/services/processing/background";
import { workspaceScope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const schema = z.object({ batchId: z.string().max(100).optional() });

/** POST /api/jobs/retry-failed { batchId? } – re-queue every FAILED CV. */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = req.headers.get("content-type")?.includes("application/json") ? await parseJson(req, schema) : {};
  const retried = await retryFailed(workspaceScope(user), body.batchId);
  if (retried) kickAfterResponse(req, "retry-failed");
  return ok({ retried });
});
