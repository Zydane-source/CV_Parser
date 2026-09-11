/**
 * Deterministic candidate-name extraction.
 *
 * "Take the first line" fails on the very common CV that opens with
 * "CURRICULUM VITAE" or a job title. Instead every plausible name-shaped string
 * is collected from the places names actually appear, scored on independent
 * signals, and the best is chosen. Corroboration matters most: a top-of-document
 * string that also matches the email local part is near-certain.
 */
import type { StructuredDocument } from "./document";
import type { FieldCandidate, FieldResult, ExtractionSignal } from "./types";
import { emptyField } from "./types";

/** Explicit name labels, in decreasing specificity. */
const NAME_LABEL = /^(candidate\s*name|full\s*name|name\s*of\s*(the\s*)?candidate|applicant\s*name|name)$/i;

/** Words that disqualify a string from being a person's name. */
const NOT_A_NAME =
  /\b(resume|curriculum\s*vitae|\bcv\b|bio\s*-?\s*data|biodata|profile|objective|summary|declaration|reference|experience|education|skills?|projects?|address|contact|email|mobile|phone|date\s*of\s*birth|dob|nationality|gender|marital|languages?|hobbies|interests|achievements|certification|university|college|institute|school|academy|ltd|limited|pvt|private|llp|inc|corporation|company|technologies|solutions|services|systems|consultancy|enterprises|industries|infotech|software|hospital|bank|obtain|seeking|challenging|position|opportunity|organisation|organization|responsible|hardworking|dedicated)\b/i;

/** Honorifics that precede a name and should be stripped. */
const HONORIFIC = /^(mr|mrs|ms|miss|dr|er|prof|shri|smt|sri|md|col|capt)\.?\s+/i;

/** Suffixes commonly appended in Indian CVs. */
const NAME_SUFFIX = /\s+(jr|sr|ii|iii)\.?$/i;

/**
 * A name-shaped token: letters, plus the apostrophes, hyphens and single dots
 * that appear in real names (D'Souza, Jean-Luc, K. Ramesh).
 */
const NAME_TOKEN = /^[\p{Lu}][\p{L}'’-]*\.?$|^[\p{Lu}]\.$/u;

const MAX_NAME_WORDS = 5;
const MIN_NAME_WORDS = 1;

function cleanCandidate(raw: string): string | null {
  let s = raw
    .replace(/[,|•·–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(HONORIFIC, "").replace(NAME_SUFFIX, "").trim();
  if (!s) return null;
  if (s.length < 3 || s.length > 60) return null;
  if (/\d|@|https?:/i.test(s)) return null;
  if (NOT_A_NAME.test(s)) return null;

  const words = s.split(" ").filter(Boolean);
  if (words.length < MIN_NAME_WORDS || words.length > MAX_NAME_WORDS) return null;

  // Every token must look like a name token once case is normalised.
  const titled = words.map(toTitleCase);
  if (!titled.every((w) => NAME_TOKEN.test(w))) return null;
  // A single token is only a name when explicitly labelled; handled by the caller
  // via the label signal, so allow it through here.
  return titled.join(" ");
}

function toTitleCase(word: string): string {
  if (!word) return word;
  // Preserve internal capitals in names like McDonald or D'Souza.
  if (/^[\p{Lu}][\p{Ll}]/u.test(word) && !/^[\p{Lu}]+$/u.test(word)) return word;
  return word
    .split("-")
    .map((part) =>
      part
        .split("'")
        .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p))
        .join("'"),
    )
    .join("-");
}

/** Tokens from an email local part: rahul.sharma91 -> ["rahul","sharma"]. */
function emailNameTokens(email: string): string[] {
  const local = email.split("@")[0] ?? "";
  return local
    .split(/[._\-+0-9]+/)
    .filter((t) => t.length >= 3)
    .map((t) => t.toLowerCase());
}

/** Tokens from a file name: "Rahul_Sharma_Resume.pdf" -> ["rahul","sharma"]. */
export function fileNameTokens(fileName: string): string[] {
  const base = fileName.replace(/\.[a-z0-9]+$/i, "");
  return base
    .split(/[\s._\-()[\]0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !/^(resume|cv|curriculum|vitae|biodata|bio|data|final|updated|new|copy|doc|pdf|docx)$/i.test(t));
}

export interface NameOptions {
  /** Original upload file name — often contains the candidate's name. */
  fileName?: string;
  /** True when the text came from OCR, enabling glyph-confusion correction. */
  ocrUsed?: boolean;
}

export function extractName(doc: StructuredDocument, opts: NameOptions = {}): FieldResult {
  const candidates = new Map<string, FieldCandidate>();
  const emailTokens = new Set(doc.emails.flatMap((e) => emailNameTokens(e.value)));
  const fileTokens = new Set(opts.fileName ? fileNameTokens(opts.fileName) : []);

  const add = (value: string, score: number, signals: ExtractionSignal[], line: number, why: string) => {
    const existing = candidates.get(value.toLowerCase());
    if (existing) {
      // Independent signals corroborate: keep the union and the higher score.
      existing.score = Math.max(existing.score, score);
      for (const s of signals) if (!existing.signals.includes(s)) existing.signals.push(s);
      existing.why = `${existing.why}; ${why}`;
      return;
    }
    candidates.set(value.toLowerCase(), { value, score, signals: [...signals], line, why });
  };

  // Signal 1 — an explicit "Name:" label anywhere in the document.
  for (const line of doc.lines) {
    if (!line.label || !line.labelValue) continue;
    if (!NAME_LABEL.test(line.label.trim())) continue;
    const cleaned = cleanCandidate(line.labelValue);
    if (cleaned) add(cleaned, 0.62, ["explicit_label"], line.index, `explicit "${line.label.trim()}" label`);
  }

  // Signal 2 — name-shaped lines in the header block, weighted by how high they sit.
  // When the document has real section headings, trust the boundary: text under
  // OBJECTIVE is prose, not a name. The 6-line floor is only for CVs with no
  // headings at all, where there is no boundary to trust.
  const headerLimit = doc.hasSectionHeadings ? doc.headerEndLine : 6;
  const headerLines = doc.lines.filter((l) => l.index < headerLimit && !l.isHeading);
  for (const line of headerLines) {
    const cleaned = cleanCandidate(stripContactNoise(line.text));
    if (!cleaned) continue;
    // Decay with depth: line 0 is far more likely than line 7.
    const positional = Math.max(0.12, 0.42 - line.index * 0.05);
    add(cleaned, positional, ["header_detection"], line.index, `name-shaped line ${line.index} of the header`);
  }

  // Signal 3 — inside a Personal Details section.
  for (const line of doc.lines) {
    if (line.section !== "personal_details" || line.isHeading) continue;
    const source = line.labelValue && NAME_LABEL.test((line.label ?? "").trim()) ? line.labelValue : line.text;
    const cleaned = cleanCandidate(source);
    if (cleaned) add(cleaned, 0.3, ["contact_section"], line.index, "in the personal details section");
  }

  // Signal 4 — the line adjacent to the email/phone contact line.
  const contactLines = new Set(doc.emails.map((e) => e.line));
  for (const line of doc.lines) {
    if (!contactLines.has(line.index + 1) && !contactLines.has(line.index - 1)) continue;
    if (line.isHeading) continue;
    const cleaned = cleanCandidate(stripContactNoise(line.text));
    if (cleaned) add(cleaned, 0.22, ["contact_section"], line.index, "adjacent to the contact line");
  }

  // Signal 5 (fallback) — an isolated name-shaped line anywhere in the document.
  //
  // Multi-column PDFs are read in visual order, so a sidebar of contact details
  // can precede the main column and push the name well past the header window.
  // Only used when the header yielded nothing, and only for lines that stand
  // alone as a name, so it cannot outrank a properly positioned candidate.
  if (candidates.size === 0) {
    // Only References is excluded outright, because the names in it belong to
    // other people. Every other section stays eligible: reading order in a
    // multi-column PDF can place the candidate's own name under any heading.
    // What keeps this safe is the corroboration requirement below, not the
    // section — "Java, SQL" under SKILLS is name-shaped but matches no email or
    // file-name token, so it is discarded.
    const NEVER_A_NAME_SECTION = new Set(["references"]);
    for (const line of doc.lines) {
      if (line.isHeading || NEVER_A_NAME_SECTION.has(line.section)) continue;
      const text = line.text.trim();
      if (!text || text.length > 40) continue;
      const cleaned = cleanCandidate(text);
      if (!cleaned) continue;
      const words = cleaned.split(" ").filter(Boolean);
      if (words.length < 2 || words.length > 4) continue;
      // Outside the header there is no positional evidence, so demand
      // independent corroboration from the email or the file name. Without it,
      // returning Not Found is the honest answer.
      const lower = words.map((w) => w.toLowerCase());
      const corroborated = lower.some((t) => emailTokens.has(t) || fileTokens.has(t));
      if (!corroborated) continue;
      add(cleaned, 0.2, ["heuristic"], line.index, `isolated name-shaped line ${line.index}, corroborated (header window found nothing)`);
    }
  }

  if (candidates.size === 0) {
    return emptyField("no line in the document matched a person-name shape");
  }

  // Corroboration passes — these do not create candidates, they confirm them.
  for (const c of candidates.values()) {
    const tokens = c.value.toLowerCase().split(" ").filter((t) => t.length >= 3);
    if (tokens.length === 0) continue;

    const emailHits = tokens.filter((t) => emailTokens.has(t)).length;
    if (emailHits > 0) {
      c.score += emailHits >= 2 ? 0.3 : 0.18;
      c.signals.push("email_local_part");
      c.why += `; ${emailHits} token(s) match the email address`;
    }

    const fileHits = tokens.filter((t) => fileTokens.has(t)).length;
    if (fileHits > 0) {
      c.score += fileHits >= 2 ? 0.24 : 0.14;
      c.signals.push("filename");
      c.why += `; ${fileHits} token(s) match the file name`;
    }

    // A bare single token is only credible with corroboration.
    if (c.value.split(" ").length === 1 && emailHits === 0 && fileHits === 0 && !c.signals.includes("explicit_label")) {
      c.score -= 0.25;
      c.why += "; single word with no corroboration";
    }
    // Two or three words is the overwhelmingly common shape.
    const wc = c.value.split(" ").length;
    if (wc === 2 || wc === 3) c.score += 0.08;
  }

  const ranked = [...candidates.values()].filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return emptyField("all name candidates were rejected during scoring");

  const best = ranked[0];
  // OCR confuses visually similar glyphs (I/l, O/0, rn/m), so a scanned CV can
  // yield "Meera Lyer" for "Meera Iyer". When the upload's file name contains a
  // token one edit away, the file name is the more reliable spelling.
  if (opts.fileName && opts.ocrUsed) {
    const corrected = correctFromFileName(best.value, [...fileTokens]);
    if (corrected && corrected !== best.value) {
      best.why += `; spelling corrected from the file name (OCR glyph confusion)`;
      best.value = corrected;
      if (!best.signals.includes("filename")) best.signals.push("filename");
    }
  }
  const runnerUp = ranked[1];
  let confidence = Math.min(0.99, best.score);
  if (runnerUp && best.score - runnerUp.score < 0.1) {
    // Two equally plausible names means we should not claim certainty.
    confidence = Math.min(confidence, 0.7);
  }

  const method: ExtractionSignal = best.signals.includes("explicit_label")
    ? "explicit_label"
    : best.signals.includes("email_local_part")
      ? "email_local_part"
      : (best.signals[0] ?? "heuristic");

  return {
    value: best.value,
    confidence: Number(confidence.toFixed(3)),
    method,
    why: best.why,
    alternatives: ranked.slice(1, 4).map((c) => ({ value: c.value, confidence: Number(Math.min(0.99, c.score).toFixed(3)) })),
  };
}

/** Remove phone numbers, emails and separators so a contact line can still yield a name. */
function stripContactNoise(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ")
    .replace(/(?:\+?\d[\d\s().-]{7,})/g, " ")
    .replace(/\b(https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}


/** Levenshtein distance, bounded: returns max+1 as soon as it is exceeded. */
function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Replace name words that are a single edit away from a file-name token.
 *
 * Deliberately conservative: only distance 1, only tokens of 4+ characters, and
 * only when exactly one file-name token is that close. Anything looser would
 * rewrite correct names to match a badly named upload.
 */
function correctFromFileName(name: string, fileTokens: string[]): string | null {
  if (fileTokens.length === 0) return null;
  const words = name.split(" ");
  let changed = false;
  const fixed = words.map((w) => {
    const lower = w.toLowerCase();
    if (lower.length < 4) return w;
    if (fileTokens.includes(lower)) return w; // already agrees
    const near = fileTokens.filter((t) => t.length >= 4 && editDistance(lower, t, 1) === 1);
    if (near.length !== 1) return w;
    changed = true;
    return near[0].charAt(0).toUpperCase() + near[0].slice(1);
  });
  return changed ? fixed.join(" ") : null;
}
