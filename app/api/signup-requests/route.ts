import { handler, ok } from "@/lib/api";
import { requireOwner } from "@/lib/auth";
import { listPendingSignups } from "@/backend/signup";

export const dynamic = "force-dynamic";

/** GET /api/signup-requests — Create account requests awaiting approval. Owner only. */
export const GET = handler(async () => {
  await requireOwner();
  return ok({ requests: await listPendingSignups() });
});
