import { z } from "zod";
import { handler, ok, parseJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { RateLimitError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { candidateFiltersSchema } from "@/backend/candidates";
import { exportCandidatesToSheets } from "@/services/google-sheets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  filters: candidateFiltersSchema.omit({ page: true, pageSize: true }).partial().optional(),
  spreadsheetId: z.string().max(200).optional(),
});

/** POST /api/google-sheets/export { filters?, spreadsheetId? } */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const rl = await rateLimit(`sheets-export:${user.id}`, 10, 600);
  if (!rl.allowed) throw new RateLimitError("Too many exports. Please wait a few minutes.");
  const body = req.headers.get("content-type")?.includes("application/json") ? await parseJson(req, schema) : {};
  const filters = candidateFiltersSchema.omit({ page: true, pageSize: true }).parse(body.filters ?? {});
  const result = await exportCandidatesToSheets(user.id, filters, body.spreadsheetId);
  return ok(result);
});
