/**
 * Deterministic phone extraction.
 *
 * The hard part is not finding digits, it is choosing the candidate's own mobile
 * from among a reference's number, an employer's landline, a PIN code, an Aadhaar
 * fragment, a date and a salary figure. So every digit run is scored on where it
 * sits and what labels surround it, and obvious non-phones are rejected outright
 * before scoring.
 */
import { normalizePhone } from "@/services/cv-parser/phone";
import type { StructuredDocument, DocLine } from "./document";
import type { FieldCandidate, FieldResult, ExtractionSignal } from "./types";
import { emptyField } from "./types";

/**
 * Digit runs that could be a phone number. Deliberately permissive — rejection
 * happens in scoring, where there is context to judge with.
 */
const PHONE_CANDIDATE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)[\s.-]?)?\d[\d\s.-]{5,17}\d/g;

/** Labels that mark the candidate's own contact number. */
const OWN_PHONE_LABEL = /\b(mobile|mob|cell|phone|contact|contact\s*(no|number)|ph|tel|telephone|whatsapp|personal\s*(no|number|contact))\b/i;
/** Labels that mark a number belonging to someone or something else. */
const FOREIGN_PHONE_LABEL = /\b(alternate|alternative|secondary|office|work|landline|residence|residential|home|emergency|father|mother|guardian|spouse|parent|company|employer|hr|reference|referee|fax)\b/i;

/**
 * A reference entry, recognised by its shape rather than by which section the
 * parser thinks it is in. Multi-column PDFs are read in visual order, so a
 * referee line can surface among the header lines; "Mr. Suresh Menon, Manager,
 * Infosys - 9899988877" is somebody else's number wherever it appears.
 */
// The honorific is spelled case-insensitively by hand rather than with the `i`
// flag, because the name that follows must stay case-sensitive: `\p{Lu}` is what
// distinguishes "Mr. Suresh Menon, Manager" from ordinary prose.
const THIRD_PARTY_LINE =
  /\b(?:[Mm]rs?|[Mm]s|[Mm]iss|[Dd]r|[Pp]rof|[Ss]hri|[Ss]mt)\.?\s+[\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+)?\s*[,-]\s*[^,]{2,40}/u;

/** Contexts where a digit run is definitely not a phone number. */
const NON_PHONE_CONTEXT =
  /\b(pin\s*code|pincode|postal\s*code|zip|aadhaar|aadhar|uid|pan|passport|employee\s*(id|code|no)|emp\s*id|roll\s*(no|number)|registration|enrol(l)?ment|account\s*(no|number)|ifsc|gst(in)?|cgpa|gpa|percentage|marks|salary|ctc|lpa|package|invoice|order\s*no|pf\s*(no|number)|esic|uan)\b/i;

/** A four-digit year, a year range, or a date — common false positives. */
const LOOKS_LIKE_DATE =
  /\b(19|20)\d{2}\s*[-–—to]+\s*((19|20)\d{2}|present|current|till\s*date)\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i;

export interface PhoneEvidence {
  /** Line index the number was found on, for `sourceLocation`. */
  line: number;
  normalized: string;
}

interface Scored extends FieldCandidate {
  normalized: string;
}

/**
 * Reject digit runs that cannot be phone numbers on their own merits, before any
 * context is considered.
 */
function structurallyImpossible(digits: string): boolean {
  // Length is gated here and nowhere else; the match pattern stays permissive so
  // formats like "+1 (415) 555-0123" are not lost to an arithmetic edge case.
  if (digits.length < 8 || digits.length > 15) return true;
  // A single repeated digit is a placeholder, never a number.
  if (/^(\d)\1+$/.test(digits)) return true;
  // Note: no sequential-run rejection. "9876543210" is a perfectly valid Indian
  // mobile as well as the textbook example, and an ascending run like
  // "1234567890" is already rejected because Indian mobiles must start 6-9.
  return false;
}

/** Does the surrounding text mark this run as something other than a phone? */
function inNonPhoneContext(lineText: string, match: string): boolean {
  if (NON_PHONE_CONTEXT.test(lineText)) {
    // The label may head a different value on the same line, so only veto when
    // the run is close to the offending label.
    const idx = lineText.indexOf(match);
    const before = lineText.slice(Math.max(0, idx - 40), idx);
    const after = lineText.slice(idx + match.length, idx + match.length + 20);
    if (NON_PHONE_CONTEXT.test(before) || NON_PHONE_CONTEXT.test(after)) return true;
  }
  if (LOOKS_LIKE_DATE.test(lineText)) {
    const stripped = match.replace(/\D/g, "");
    // A 4-digit year inside a date range is never a phone; a 10-digit mobile on
    // the same line as a date still is.
    if (stripped.length <= 8) return true;
  }
  return false;
}

export function extractPhone(doc: StructuredDocument): FieldResult & { evidence?: PhoneEvidence } {
  const candidates: Scored[] = [];
  const seen = new Map<string, Scored>();

  for (const line of doc.lines) {
    for (const m of line.text.matchAll(PHONE_CANDIDATE)) {
      const raw = m[0];
      const digits = raw.replace(/\D/g, "");
      if (structurallyImpossible(digits)) continue;
      if (inNonPhoneContext(line.text, raw)) continue;

      const norm = normalizePhone(raw);
      if (!norm.valid) continue;

      const prev = doc.lines[doc.lines.indexOf(line) - 1];
      const scored = scoreCandidate(raw, norm.normalized, line, doc, norm.country, prev?.text);
      if (scored.score <= 0) continue;

      // Same number may appear twice (header and footer); keep the best-scoring.
      const existing = seen.get(scored.normalized);
      if (!existing || scored.score > existing.score) seen.set(scored.normalized, scored);
    }
  }
  candidates.push(...seen.values());

  if (candidates.length === 0) {
    return emptyField("no digit run in the document passed phone validation");
  }

  candidates.sort((a, b) => b.score - a.score);

  /**
   * Acceptance floor. Every surviving candidate scoring below this is a number
   * the document itself attributes to somebody else — an office switchboard, a
   * referee, an emergency contact. Presenting one as the candidate's phone is
   * worse than admitting there isn't one, so we return Not Found instead.
   */
  const ACCEPT_FLOOR = 0.32;
  if (candidates[0].score < ACCEPT_FLOOR) {
    return emptyField(
      `the only numbers found are attributed to someone else (best: ${candidates[0].why})`,
    );
  }

  const best = candidates[0];
  const runnerUp = candidates[1];

  // Confidence is evidence-derived: a labelled mobile in the header is near
  // certain; an unlabelled number competing with others is not.
  let confidence = Math.min(0.99, best.score);
  if (runnerUp) {
    const margin = best.score - runnerUp.score;
    // A close second means genuine ambiguity about whose number this is.
    if (margin < 0.15) confidence = Math.min(confidence, 0.72);
    else if (margin < 0.3) confidence = Math.min(confidence, 0.85);
  }

  const method: ExtractionSignal = best.signals[0] ?? "regex";
  return {
    value: best.normalized,
    confidence: Number(confidence.toFixed(3)),
    method,
    why: best.why,
    alternatives: candidates.slice(1, 4).map((c) => ({ value: c.normalized, confidence: Number(Math.min(0.99, c.score).toFixed(3)) })),
    evidence: { line: best.line ?? -1, normalized: best.normalized },
  };
}

function scoreCandidate(
  raw: string,
  normalized: string,
  line: DocLine,
  doc: StructuredDocument,
  country: string,
  prevText?: string,
): Scored {
  let score = 0.35; // a validated, structurally plausible number
  const signals: ExtractionSignal[] = ["regex"];
  const why: string[] = [];

  const text = line.text;
  const idx = text.indexOf(raw);
  const before = text.slice(Math.max(0, idx - 45), idx);

  // Explicit "Mobile:" / "Contact No:" label immediately before the number.
  const labelledOwn = OWN_PHONE_LABEL.test(before) || (line.label ? OWN_PHONE_LABEL.test(line.label) : false);
  const labelledForeign = FOREIGN_PHONE_LABEL.test(before) || (line.label ? FOREIGN_PHONE_LABEL.test(line.label) : false);

  if (labelledOwn && !labelledForeign) {
    score += 0.4;
    signals.unshift("explicit_label");
    why.push("labelled as the candidate's mobile/contact");
  } else if (labelledForeign) {
    // Alternate/office/reference numbers are demoted hard but not discarded:
    // a CV whose only number is labelled "Office" still needs an answer.
    score -= 0.3;
    why.push("labelled as an alternate/third-party number");
  }

  // Position: the contact block at the top is where a candidate's own number lives.
  if (line.index < doc.headerEndLine) {
    score += 0.25;
    if (signals[0] !== "explicit_label") signals.unshift("contact_section");
    why.push("in the header contact block");
  } else if (line.index < doc.headerEndLine + 6) {
    score += 0.1;
  }

  if (line.section === "personal_details") {
    score += 0.2;
    if (signals[0] === "regex") signals.unshift("contact_section");
    why.push("in the personal details section");
  }

  // A number under References or Declaration belongs to a referee, not the candidate.
  if (line.section === "references") {
    score -= 0.6;
    why.push("inside the references section");
  }
  // Independent of section: the line, or the line it wrapped from, names a third
  // party. Reference entries routinely wrap between the name and the number.
  const withPrev = prevText ? `${prevText} ${text}` : text;
  if (THIRD_PARTY_LINE.test(text) || THIRD_PARTY_LINE.test(withPrev)) {
    score -= 0.55;
    why.push("attributed to a named third party");
  }
  if (line.section === "experience" || line.section === "education") {
    // Employer/institute switchboard numbers.
    score -= 0.25;
    why.push("inside an employer/institute section");
  }

  // Indian mobile numbers are the expected shape for this user base.
  if (country === "IN" && /^\+91[6-9]\d{9}$/.test(normalized)) {
    score += 0.15;
    why.push("valid Indian mobile format");
  } else if (country === "IN") {
    // Landline: plausible but less likely to be the contact they want reaching.
    score -= 0.05;
    why.push("Indian landline format");
  }

  // Sharing a line with an email is strong evidence of a contact line.
  if (doc.emails.some((e) => e.line === line.index)) {
    score += 0.12;
    why.push("on the same line as an email address");
  }

  return {
    value: raw,
    normalized,
    score: Math.max(0, score),
    signals,
    line: line.index,
    why: why.join("; ") || "matched a phone pattern",
  };
}
