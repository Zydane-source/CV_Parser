import { z } from "zod";
import { handler, ok, parseJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { retryFailed } from "@/services/processing/enqueue";

export const dynamic = "force-dynamic";

const schema = z.object({ batchId: z.string().max(100).optional() });

/** POST /api/jobs/retry-failed { batchId? } – re-queue every FAILED CV. */
export const POST = handler(async (req: Request) => {
  await requireUser();
  const body = req.headers.get("content-type")?.includes("application/json") ? await parseJson(req, schema) : {};
  const retried = await retryFailed(body.batchId);
  return ok({ retried });
});
