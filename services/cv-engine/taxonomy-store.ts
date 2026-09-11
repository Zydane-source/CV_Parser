import { z } from "zod";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { RoleTaxonomy, type Taxonomy } from "./taxonomy";
import defaultTaxonomy from "./taxonomy/role-taxonomy.json";

/**
 * Admin-editable role taxonomy.
 *
 * The bundled JSON is the default. An override stored in the `Setting` table
 * replaces it, so adding a job title the business has started hiring for is a
 * form submission rather than a deploy — which matters because a deploy is
 * exactly the kind of friction that stops a taxonomy being maintained, and an
 * unmaintained taxonomy is the main way role extraction degrades over time.
 *
 * The override is validated before it is accepted: a malformed taxonomy saved by
 * accident must not be able to take extraction down. If validation or the read
 * fails at any point, the bundled default is used.
 */
export const TAXONOMY_SETTING_KEY = "roleTaxonomy";

const roleEntrySchema = z.object({
  canonical: z.string().trim().min(2).max(80),
  aliases: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
});

const familySchema = z.object({
  family: z.string().trim().min(2).max(60),
  roles: z.array(roleEntrySchema).min(1).max(500),
});

export const taxonomySchema = z.object({
  version: z.string().trim().min(1).max(20),
  families: z.array(familySchema).min(1).max(100),
  seniorityPrefixes: z.array(z.string().trim().min(1).max(30)).max(100).default([]),
  genericRejects: z.array(z.string().trim().min(1).max(60)).max(300).default([]),
});

export type TaxonomyInput = z.input<typeof taxonomySchema>;

/** Cached because extraction runs per CV and the override changes rarely. */
const CACHE_TTL_MS = 30_000;
let cache: { value: RoleTaxonomy; at: number; source: "default" | "override" } | null = null;

export function bundledTaxonomy(): Taxonomy {
  return defaultTaxonomy as Taxonomy;
}

/** Drop the cache so the next extraction sees a freshly saved taxonomy. */
export function invalidateTaxonomyCache(): void {
  cache = null;
}

/**
 * The taxonomy extraction should use right now. Never throws: a broken override
 * degrades to the bundled default rather than failing the CV.
 */
export async function getActiveTaxonomy(): Promise<RoleTaxonomy> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let value = new RoleTaxonomy(bundledTaxonomy());
  let source: "default" | "override" = "default";
  try {
    const row = await prisma.setting.findUnique({ where: { key: TAXONOMY_SETTING_KEY } });
    if (row?.value) {
      const parsed = taxonomySchema.safeParse(row.value);
      if (parsed.success) {
        value = new RoleTaxonomy(parsed.data);
        source = "override";
      } else {
        logger.warn({ issues: parsed.error.issues.length }, "Stored role taxonomy is invalid; using the bundled default");
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Could not read the role taxonomy override; using the bundled default");
  }

  cache = { value, at: Date.now(), source };
  return value;
}

/** Which taxonomy is in force, for the admin UI. */
export async function taxonomyStatus(): Promise<{ source: "default" | "override"; version: string; families: number; roles: number }> {
  const t = await getActiveTaxonomy();
  const data = t.data;
  return {
    source: cache?.source ?? "default",
    version: data.version,
    families: data.families.length,
    roles: data.families.reduce((n, f) => n + f.roles.length, 0),
  };
}

/** Validate and store an override. Returns the parsed taxonomy actually saved. */
export async function saveTaxonomyOverride(input: unknown): Promise<Taxonomy> {
  const parsed = taxonomySchema.parse(input);
  await prisma.setting.upsert({
    where: { key: TAXONOMY_SETTING_KEY },
    create: { key: TAXONOMY_SETTING_KEY, value: parsed },
    update: { value: parsed },
  });
  invalidateTaxonomyCache();
  return parsed;
}

/** Remove the override and go back to the bundled taxonomy. */
export async function resetTaxonomyOverride(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: TAXONOMY_SETTING_KEY } });
  invalidateTaxonomyCache();
}
