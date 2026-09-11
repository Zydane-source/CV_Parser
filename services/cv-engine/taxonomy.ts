/**
 * Role taxonomy loader and matcher.
 *
 * The taxonomy is data, not code: `taxonomy/role-taxonomy.json` ships as the
 * default and an admin can override it through the `roleTaxonomy` setting (see
 * `taxonomy-store.ts`), so a new job title never requires a deploy.
 *
 * Matching is lexical and deterministic. It normalises separators and casing,
 * strips seniority prefixes so "Sr. Backend Engineer" reaches "Backend
 * Developer", and falls back to token overlap so unseen-but-plausible titles
 * ("Golang Developer") still resolve to a family rather than being discarded.
 */
import taxonomyJson from "./taxonomy/role-taxonomy.json";

export interface RoleEntry {
  canonical: string;
  aliases: string[];
}

export interface RoleFamily {
  family: string;
  roles: RoleEntry[];
}

export interface Taxonomy {
  version: string;
  families: RoleFamily[];
  seniorityPrefixes: string[];
  genericRejects: string[];
}

export interface RoleMatch {
  canonical: string;
  family: string;
  /** 1 for an exact canonical/alias hit, lower for token-overlap matches. */
  strength: number;
  /** Seniority word found on the source string, preserved for display. */
  seniority?: string;
  matchedOn: "canonical" | "alias" | "token_overlap";
}

const DEFAULT_TAXONOMY = taxonomyJson as unknown as Taxonomy;

/** Collapse separators and case so "Back-End  Developer" == "back end developer". */
export function canonicalKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[._/\\|,]+/g, " ")
    .replace(/[^\p{L}\p{N}+#\s-]/gu, " ")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that carry no discriminating power when comparing titles. */
const STOP_TOKENS = new Set(["a", "an", "the", "of", "for", "in", "and", "to", "as", "with", "position", "role", "job", "post", "profile", "opening", "vacancy"]);

function tokens(s: string): string[] {
  return canonicalKey(s)
    .split(" ")
    .filter((t) => t && !STOP_TOKENS.has(t));
}

export class RoleTaxonomy {
  readonly version: string;
  /** The source data, kept so callers can report or re-serialise what is in force. */
  readonly data: Taxonomy;
  private byKey = new Map<string, { entry: RoleEntry; family: string; kind: "canonical" | "alias" }>();
  private entries: Array<{ entry: RoleEntry; family: string; tokenSet: Set<string> }> = [];
  private seniority: string[];
  private generics: Set<string>;

  constructor(data: Taxonomy = DEFAULT_TAXONOMY) {
    this.data = data;
    this.version = data.version;
    this.seniority = [...(data.seniorityPrefixes ?? [])].sort((a, b) => b.length - a.length);
    this.generics = new Set((data.genericRejects ?? []).map(canonicalKey));

    for (const fam of data.families ?? []) {
      for (const entry of fam.roles ?? []) {
        this.byKey.set(canonicalKey(entry.canonical), { entry, family: fam.family, kind: "canonical" });
        for (const alias of entry.aliases ?? []) {
          const k = canonicalKey(alias);
          // A canonical name always wins over another role's alias.
          if (!this.byKey.has(k)) this.byKey.set(k, { entry, family: fam.family, kind: "alias" });
        }
        const tokenSet = new Set([...tokens(entry.canonical), ...(entry.aliases ?? []).flatMap(tokens)]);
        this.entries.push({ entry, family: fam.family, tokenSet });
      }
    }
  }

  /** True when the string is a placeholder rather than an actual job title. */
  isGeneric(s: string): boolean {
    return this.generics.has(canonicalKey(s));
  }

  /** Strip and return a leading seniority word, so the core title can be matched. */
  splitSeniority(s: string): { seniority?: string; rest: string } {
    const trimmed = s.trim();
    for (const p of this.seniority) {
      const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s.-]*`, "i");
      if (re.test(trimmed)) {
        return { seniority: p.replace(/\.$/, ""), rest: trimmed.replace(re, "").trim() };
      }
    }
    return { rest: trimmed };
  }

  /**
   * Resolve a free-text title to a taxonomy entry.
   * Returns null when nothing plausible matches.
   */
  match(input: string): RoleMatch | null {
    const raw = input.trim();
    if (!raw || this.isGeneric(raw)) return null;

    const { seniority, rest } = this.splitSeniority(raw);
    for (const probe of [raw, rest]) {
      const hit = this.byKey.get(canonicalKey(probe));
      if (hit) {
        return {
          canonical: hit.entry.canonical,
          family: hit.family,
          strength: hit.kind === "canonical" ? 1 : 0.95,
          seniority,
          matchedOn: hit.kind,
        };
      }
    }

    // Token overlap: handles unseen variants built from known words.
    const probeTokens = tokens(rest || raw);
    if (probeTokens.length === 0) return null;
    let best: { m: RoleMatch; score: number } | null = null;
    for (const e of this.entries) {
      const shared = probeTokens.filter((t) => e.tokenSet.has(t));
      if (shared.length === 0) continue;
      // Require the overlap to cover most of the probe, so "Developer" alone does
      // not resolve to an arbitrary developer role.
      const coverage = shared.length / probeTokens.length;
      if (coverage < 0.6 || shared.length < 2) continue;
      const score = coverage * 0.85;
      if (!best || score > best.score) {
        best = {
          score,
          m: { canonical: e.entry.canonical, family: e.family, strength: Number(score.toFixed(3)), seniority, matchedOn: "token_overlap" },
        };
      }
    }
    return best?.m ?? null;
  }

  /** Every canonical title, for the admin UI and for validation. */
  allCanonical(): string[] {
    return [...new Set(this.entries.map((e) => e.entry.canonical))].sort();
  }

  /** Longest-first alias list, used for scanning free text. */
  allSurfaceForms(): Array<{ surface: string; canonical: string; family: string }> {
    const out: Array<{ surface: string; canonical: string; family: string }> = [];
    for (const e of this.entries) {
      out.push({ surface: e.entry.canonical, canonical: e.entry.canonical, family: e.family });
      for (const a of e.entry.aliases ?? []) out.push({ surface: a, canonical: e.entry.canonical, family: e.family });
    }
    return out.sort((a, b) => b.surface.length - a.surface.length);
  }
}

let cached: RoleTaxonomy | null = null;

/** Default taxonomy instance (bundled JSON). */
export function getTaxonomy(): RoleTaxonomy {
  if (!cached) cached = new RoleTaxonomy();
  return cached;
}

/** Replace the active taxonomy, e.g. with an admin override from the database. */
export function setTaxonomy(data: Taxonomy | null): void {
  cached = data ? new RoleTaxonomy(data) : null;
}
