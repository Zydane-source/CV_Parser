import { handler, ok, parseQuery } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { candidateFiltersSchema, listCandidates } from "@/backend/candidates";

export const dynamic = "force-dynamic";

/** GET /api/candidates?q=&source=&status=&role=&from=&to=&page=&pageSize=&sort=&order= */
export const GET = handler(async (req: Request) => {
  await requireUser();
  const filters = parseQuery(req, candidateFiltersSchema);
  return ok(await listCandidates(filters));
});
