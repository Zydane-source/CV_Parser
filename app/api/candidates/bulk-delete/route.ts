import { handler, ok, parseJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { RateLimitError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { deleteCVs, deleteRequestSchema } from "@/backend/delete";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/candidates/bulk-delete  { ids: string[], ignoreFutureSync?: boolean }
 *
 * Deletes up to 500 CVs in one call. Uses POST rather than DELETE so the id list
 * travels in a body that every client and proxy handles consistently.
 */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const rl = await rateLimit(`bulk-delete:${user.id}`, 20, 60);
  if (!rl.allowed) throw new RateLimitError("Too many delete requests. Please wait a moment.");
  const body = await parseJson(req, deleteRequestSchema);
  return ok(await deleteCVs(body));
});
