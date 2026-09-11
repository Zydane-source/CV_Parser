import { handler, ok } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import {
  bundledTaxonomy,
  getActiveTaxonomy,
  resetTaxonomyOverride,
  saveTaxonomyOverride,
  taxonomyStatus,
} from "@/services/cv-engine/taxonomy-store";

export const dynamic = "force-dynamic";

/**
 * The role taxonomy as data, editable at runtime.
 *
 * Roles are the part of extraction that goes stale: an organisation starts
 * hiring for a title the taxonomy has never seen, and role accuracy quietly
 * drops. Requiring a deploy for that guarantees it stops being maintained, so
 * it is an admin form instead.
 *
 *   GET    – the taxonomy in force, plus whether it is the default or an override
 *   PUT    – validate and store an override (admin)
 *   DELETE – discard the override and return to the bundled default (admin)
 */
export const GET = handler(async () => {
  await requireUser();
  const [taxonomy, status] = await Promise.all([getActiveTaxonomy(), taxonomyStatus()]);
  return ok({ status, taxonomy: taxonomy.data, bundledVersion: bundledTaxonomy().version });
});

export const PUT = handler(async (req: Request) => {
  await requireAdmin();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("Body must be valid JSON");
  }
  // saveTaxonomyOverride validates; a ZodError becomes a 400 with the details,
  // so a malformed taxonomy is rejected at the boundary rather than at parse time.
  const saved = await saveTaxonomyOverride(body);
  return ok({ status: await taxonomyStatus(), taxonomy: saved });
});

export const DELETE = handler(async () => {
  await requireAdmin();
  await resetTaxonomyOverride();
  return ok({ status: await taxonomyStatus(), reverted: true });
});
