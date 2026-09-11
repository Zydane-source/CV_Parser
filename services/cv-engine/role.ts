/**
 * Deterministic applied-role extraction.
 *
 * The distinction that matters is *applied* versus *current*. A CV that says
 * "Senior Software Engineer at Infosys (2021-Present)" under Experience is
 * stating history, not a request. So evidence is ranked by intent:
 *
 *   1. explicit applied labels   "Applied For: Java Developer"
 *   2. intent phrases            "seeking a role as a Data Analyst"
 *   3. resume headline/objective a title stated in the summary block
 *   4. header title line         a job title directly under the name
 *   5. most recent designation   only as a last resort, and never at full confidence
 *
 * Anything drawn from level 5 is capped below the review threshold, because
 * inferring intent from history is exactly where the old prompt told the model
 * not to guess.
 */
import type { StructuredDocument, DocLine } from "./document";
import type { FieldCandidate, FieldResult, ExtractionSignal } from "./types";
import { emptyField } from "./types";
import { getTaxonomy, type RoleTaxonomy, type RoleMatch } from "./taxonomy";

/** Labels that state the role being applied for. */
const APPLIED_LABEL =
  /^(position\s*applied(\s*for)?|applied\s*for|applying\s*for|post\s*applied(\s*for)?|job\s*(role|profile|title|position)|role\s*applied(\s*for)?|desired\s*(position|role|job)|position\s*sought|preferred\s*(role|position)|apply\s*for|position|role|post|designation\s*applied)$/i;

/** Labels that state the *current* designation — useful, but weak evidence of intent. */
const CURRENT_LABEL = /^(current\s*(designation|position|role|job\s*title)|designation|present\s*(position|role)|job\s*title|title)$/i;

/** Free-text intent phrases, capturing the title that follows. */
const INTENT_PATTERNS: RegExp[] = [
  /\b(?:seeking|searching|looking)\s+(?:for\s+)?(?:a\s+|an\s+|the\s+)?(?:challenging\s+|suitable\s+|rewarding\s+)?(?:opportunit(?:y|ies)\s+as\s+|role\s+as\s+|position\s+as\s+|job\s+as\s+|career\s+as\s+|opportunit(?:y|ies)\s+in\s+|position\s+of\s+|role\s+of\s+)(?:a\s+|an\s+)?([^.,;:\n()]{3,60})/i,
  /\b(?:to\s+work|want\s+to\s+work|wish\s+to\s+work|aspire\s+to\s+work)\s+as\s+(?:a\s+|an\s+)?([^.,;:\n()]{3,60})/i,
  /\b(?:apply(?:ing)?\s+for)\s+(?:the\s+)?(?:post\s+of\s+|position\s+of\s+|role\s+of\s+)?(?:a\s+|an\s+)?([^.,;:\n()]{3,60})/i,
  /\b(?:position|role|post)\s+of\s+(?:a\s+|an\s+)?([^.,;:\n()]{3,60})/i,
  /\b(?:as\s+an?\s+)([^.,;:\n()]{3,50})\s+(?:in\s+a\s+(?:reputed|reputable|growing|leading)|with\s+a\s+(?:reputed|reputable|growing|leading))/i,
];

/** Sections whose content describes intent rather than history. */
const INTENT_SECTIONS = new Set(["objective", "summary", "header"]);

export interface RoleOptions {
  taxonomy?: RoleTaxonomy;
}

interface RoleCandidate extends FieldCandidate {
  match: RoleMatch | null;
  /** Evidence tier, 1 (strongest intent) to 5 (history only). */
  tier: number;
}

export function extractRole(doc: StructuredDocument, opts: RoleOptions = {}): FieldResult {
  const tax = opts.taxonomy ?? getTaxonomy();
  const candidates: RoleCandidate[] = [];

  const push = (rawValue: string, tier: number, score: number, signals: ExtractionSignal[], line: number, why: string) => {
    const cleaned = cleanTitle(rawValue);
    if (!cleaned) return;
    if (tax.isGeneric(cleaned)) return;
    const match = tax.match(cleaned);
    // Without a taxonomy match the string must at least look like a job title.
    if (!match && !looksLikeJobTitle(cleaned)) return;
    const value = match ? presentable(match, cleaned) : titleCase(cleaned);
    candidates.push({
      value,
      score: score + (match ? match.strength * 0.12 : 0),
      signals: match ? [...signals, "taxonomy_match"] : signals,
      line,
      why: match ? `${why}; resolved to taxonomy entry "${match.canonical}" (${match.matchedOn})` : `${why}; no taxonomy entry, kept as written`,
      match,
      tier,
    });
  };

  // Tier 1 — explicit applied labels.
  for (const line of doc.lines) {
    if (!line.label || !line.labelValue) continue;
    const label = line.label.trim();
    if (APPLIED_LABEL.test(label)) {
      push(line.labelValue, 1, 0.72, ["explicit_label"], line.index, `explicit "${label}" label`);
    }
  }

  // Tier 2 — intent phrases anywhere, but weighted up inside objective/summary.
  // Scanned over a two-line window: PDFs wrap prose, so "... as a Digital
  // Marketing | Executive ..." is one sentence split across two drawn lines, and
  // matching a single line alone would capture a truncated title.
  for (const { text, line, joined } of lineWindows(doc)) {
    for (const re of INTENT_PATTERNS) {
      const m = text.match(re);
      if (!m?.[1]) continue;
      const boost = INTENT_SECTIONS.has(line.section) ? 0.08 : 0;
      // A window match is slightly weaker evidence than a self-contained line.
      push(m[1], 2, 0.58 + boost - (joined ? 0.02 : 0), ["keyword_match"], line.index, `intent phrase in the ${line.section} section${joined ? " (spanning wrapped lines)" : ""}`);
    }
  }

  // Tier 3 — a title stated on its own inside the objective/summary/headline block.
  for (const { text, line, joined } of lineWindows(doc)) {
    if (!INTENT_SECTIONS.has(line.section) || line.section === "header") continue;
    const surface = scanForKnownTitle(text, tax);
    if (surface) push(surface, 3, 0.5 - (joined ? 0.02 : 0), ["taxonomy_match"], line.index, `known job title inside the ${line.section} block${joined ? " (spanning wrapped lines)" : ""}`);
  }

  // Tier 4 — a job title on its own line in the header, typically under the name.
  for (const line of doc.lines) {
    if (line.index >= doc.headerEndLine || line.isHeading) continue;
    const text = line.text.trim();
    // Must be a standalone short line, not a contact line.
    if (!text || text.length > 50) continue;
    if (/@|\d{4,}|https?:/i.test(text)) continue;
    const match = tax.match(text);
    if (match) push(text, 4, 0.46, ["header_detection"], line.index, "standalone job title in the header");
  }

  // Tier 5 — current designation, or the most recent experience title. Weak.
  for (const line of doc.lines) {
    if (line.label && CURRENT_LABEL.test(line.label.trim()) && line.labelValue) {
      push(line.labelValue, 5, 0.3, ["explicit_label"], line.index, `current-designation label "${line.label.trim()}" (history, not intent)`);
    }
  }
  const firstExperience = doc.lines.find((l) => l.section === "experience" && !l.isHeading && l.text.trim().length > 0);
  if (firstExperience) {
    const surface = scanForKnownTitle(firstExperience.text, tax);
    if (surface) push(surface, 5, 0.26, ["keyword_match"], firstExperience.index, "most recent experience entry (history, not intent)");
  }

  if (candidates.length === 0) {
    return emptyField("no applied-role statement, intent phrase or recognised job title was found");
  }

  // Best tier wins outright; within a tier, score decides. Intent always beats history.
  candidates.sort((a, b) => a.tier - b.tier || b.score - a.score);
  const best = candidates[0];

  // Confidence is bounded by the evidence tier. Tier 5 is inference from history
  // and must land below the 0.75 review threshold so a human sees it.
  const TIER_CEILING: Record<number, number> = { 1: 0.97, 2: 0.9, 3: 0.82, 4: 0.78, 5: 0.55 };
  let confidence = Math.min(best.score, TIER_CEILING[best.tier] ?? 0.5);

  // Corroboration: the same role asserted by a second, independent tier.
  const corroborating = candidates.find((c) => c !== best && c.value.toLowerCase() === best.value.toLowerCase() && c.tier !== best.tier);
  if (corroborating) {
    confidence = Math.min(TIER_CEILING[best.tier] ?? 0.5, confidence + 0.06);
  }
  // Genuine disagreement inside the top tier means we are guessing between two.
  const rivalSameTier = candidates.find((c) => c !== best && c.tier === best.tier && c.value.toLowerCase() !== best.value.toLowerCase());
  if (rivalSameTier && Math.abs(rivalSameTier.score - best.score) < 0.08) {
    confidence = Math.min(confidence, 0.7);
  }

  const method: ExtractionSignal = best.signals.includes("explicit_label")
    ? "explicit_label"
    : best.signals.includes("keyword_match")
      ? "keyword_match"
      : best.signals.includes("taxonomy_match")
        ? "taxonomy_match"
        : (best.signals[0] ?? "heuristic");

  const unique = new Map<string, RoleCandidate>();
  for (const c of candidates) if (!unique.has(c.value.toLowerCase())) unique.set(c.value.toLowerCase(), c);

  return {
    value: best.value,
    confidence: Number(confidence.toFixed(3)),
    method,
    why: `tier ${best.tier}: ${best.why}`,
    alternatives: [...unique.values()]
      .filter((c) => c.value.toLowerCase() !== best.value.toLowerCase())
      .slice(0, 3)
      .map((c) => ({ value: c.value, confidence: Number(Math.min(c.score, TIER_CEILING[c.tier] ?? 0.5).toFixed(3)) })),
  };
}

/**
 * Each body line on its own, then each line joined with the one after it.
 *
 * A PDF stores wrapped prose as separate drawn lines, so a job title can be cut
 * in half by the page width. Scanning both the line and the two-line window
 * recovers those without inventing matches that span unrelated sections.
 */
function lineWindows(doc: StructuredDocument): Array<{ text: string; line: DocLine; joined: boolean }> {
  const body = doc.lines.filter((l) => !l.isHeading);
  const out: Array<{ text: string; line: DocLine; joined: boolean }> = [];
  for (let i = 0; i < body.length; i++) {
    out.push({ text: body[i].text, line: body[i], joined: false });
    const next = body[i + 1];
    // Only join consecutive lines from the same section — a wrapped sentence
    // never crosses a section heading.
    if (next && next.index === body[i].index + 1 && next.section === body[i].section) {
      out.push({ text: `${body[i].text} ${next.text}`, line: body[i], joined: true });
    }
  }
  return out;
}

/** Trim a captured title down to the words that form the role. */
function cleanTitle(raw: string): string | null {
  let s = raw
    .replace(/[•·*|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–—:\s]+/, "")
    .replace(/[.,;:]+$/, "");

  // Drop trailing qualifiers: "Java Developer in a reputed organisation".
  s = s.replace(
    /\s+(?:in|at|with|for)\s+(?:a|an|the)?\s*(?:reputed|reputable|growing|leading|good|well[\s-]known|dynamic|progressive|esteemed)\b.*$/i,
    "",
  );
  s = s.replace(/\s+(?:where|which|that|who)\b.*$/i, "");
  s = s.replace(/\s+(?:position|role|post|profile|job|vacancy|opening)$/i, "");
  s = s.replace(/^(?:the|a|an)\s+/i, "");
  s = s.trim();

  if (s.length < 3 || s.length > 60) return null;
  const words = s.split(" ").filter(Boolean);
  if (words.length > 6) return null;
  if (/@|https?:|\d{4,}/i.test(s)) return null;
  // Must be mostly letters — rejects "9876543210" and "B.Tech 2018".
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  if (letters < s.replace(/\s/g, "").length * 0.75) return null;
  return s;
}

/** Words that make a string plausible as a job title even without a taxonomy hit. */
const TITLE_NOUN =
  /\b(engineer|developer|analyst|manager|executive|specialist|consultant|designer|administrator|architect|scientist|officer|associate|assistant|coordinator|lead|head|director|intern|trainee|technician|operator|supervisor|accountant|auditor|recruiter|writer|editor|marketer|representative|advisor|strategist|planner|programmer|tester|nurse|teacher|professor|lecturer|clerk|agent|counsellor|counselor)\b/i;

function looksLikeJobTitle(s: string): boolean {
  return TITLE_NOUN.test(s);
}

/** Find the longest known role surface form inside a line of free text. */
function scanForKnownTitle(text: string, tax: RoleTaxonomy): string | null {
  const hay = ` ${text.toLowerCase()} `;
  for (const { surface } of tax.allSurfaceForms()) {
    // 3 is the floor: it admits real abbreviations recruiters write (BDE, SDE,
    // DBA, SRE) while excluding two-letter forms (CA, BA, RM) that collide with
    // ordinary words. Matching is space-padded, so these are whole-word hits.
    if (surface.length < 3) continue;
    const needle = ` ${surface.toLowerCase()} `;
    if (hay.includes(needle)) return surface;
    // Also allow the form to end the line: "... as a Data Analyst."
    if (hay.includes(` ${surface.toLowerCase()}.`) || hay.includes(` ${surface.toLowerCase()},`)) return surface;
  }
  return null;
}

/** Keep the seniority the CV stated, but use the taxonomy's canonical title. */
function presentable(match: RoleMatch, original: string): string {
  const seniority = match.seniority;
  if (!seniority) return match.canonical;
  // Avoid "Senior Senior Software Engineer".
  if (new RegExp(`^${seniority}\\b`, "i").test(match.canonical)) return match.canonical;
  void original;
  return `${titleCase(seniority)} ${match.canonical}`;
}

function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => {
      if (!w) return w;
      // Preserve acronyms the CV wrote in caps (HR, SEO, QA, UI/UX).
      if (w.length <= 4 && w === w.toUpperCase() && /^[A-Z./]+$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}
