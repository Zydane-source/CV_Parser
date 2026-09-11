/**
 * Turns normalised CV text into a light structural model.
 *
 * Deterministic extraction depends on *where* text sits, not only what it says:
 * a phone number under "References" belongs to somebody else, and a line inside
 * "Work Experience" is a past job rather than the role being applied for. The
 * LLM inferred this from context; here it has to be modelled explicitly.
 *
 * The raw text is never modified — `StructuredDocument` only annotates it.
 */

export type SectionKind =
  | "header"
  | "objective"
  | "summary"
  | "personal_details"
  | "experience"
  | "education"
  | "skills"
  | "projects"
  | "certifications"
  | "references"
  | "declaration"
  | "other";

export interface DocLine {
  index: number;
  text: string;
  section: SectionKind;
  /** True when the line is itself a section heading. */
  isHeading: boolean;
  /** Line looks like a label/value pair, e.g. "Name : Rahul Sharma". */
  label?: string;
  labelValue?: string;
}

export interface StructuredDocument {
  raw: string;
  lines: DocLine[];
  /** Index of the first line after the contact block, used to bound "top of CV". */
  headerEndLine: number;
  /** True when an actual section heading was found, so headerEndLine is real. */
  hasSectionHeadings: boolean;
  emails: Array<{ value: string; line: number }>;
  urls: Array<{ value: string; line: number }>;
}

/**
 * Section headings seen across Indian and international CV formats. Matched on a
 * whole line, case-insensitively, allowing the decorative punctuation CVs use.
 */
const SECTION_PATTERNS: Array<[SectionKind, RegExp]> = [
  ["objective", /^(career\s+)?(objective|career\s+goal|professional\s+objective|job\s+objective)s?$/i],
  ["summary", /^(professional\s+)?(summary|profile|about\s+me|profile\s+summary|executive\s+summary|career\s+summary|synopsis|overview|resume\s+headline|headline)$/i],
  ["personal_details", /^(personal\s+(details|information|profile|data)|bio\s*-?\s*data|candidate\s+details)$/i],
  ["experience", /^(work\s+)?(experience|employment(\s+history)?|professional\s+experience|work\s+history|career\s+history|職務|internships?)$/i],
  ["education", /^(education(al)?(\s+qualification(s)?)?|academic(\s+(qualification|record|details))?s?|qualifications?)$/i],
  ["skills", /^((technical|key|core|professional|it)\s+)?(skills?|competenc(y|ies)|expertise|technologies|tech\s+stack)$/i],
  ["projects", /^(projects?|academic\s+projects?|major\s+projects?|project\s+(details|work|experience))$/i],
  ["certifications", /^(certifications?|courses?|training|achievements?|awards?|accomplishments?)$/i],
  ["references", /^(references?|referees?|reference\s+details)$/i],
  ["declaration", /^(declaration|i\s+hereby\s+declare)/i],
];

/** Label/value lines: "Name : X", "Mobile - X", "Position Applied For: X". */
const LABEL_LINE = /^\s*([A-Za-z][A-Za-z /&.'()-]{1,40}?)\s*[:\-–—]\s*(.+?)\s*$/;

/**
 * Bordered tables — the standard Indian bio-data layout — put the label and the
 * value in adjacent cells. A PDF stores them as separate text runs on one line,
 * so the extracted text is "Name Sneha Reddy" with no separator at all.
 *
 * Splitting on whitespace alone would turn "Senior Associate Infosys" into
 * label "Senior", so this only fires for a closed vocabulary of CV label terms.
 */
const BARE_LABEL_LINE =
  /^\s*((?:candidate\s+name|full\s+name|father'?s?\s+name|name|mobile(?:\s+no\.?)?|phone(?:\s+no\.?)?|contact(?:\s+no\.?)?|tele?phone|email(?:\s+id)?|e-?mail|position\s+applied(?:\s+for)?|post\s+applied(?:\s+for)?|applied\s+for|job\s+role|designation|current\s+designation|date\s+of\s+birth|dob|address|nationality|gender|marital\s+status|languages?\s+known|qualification)\s+)(\S.*?)\s*$/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s,;]+/gi;

function stripDecoration(line: string): string {
  // "*** EDUCATION ***", "— Skills —", "1. Experience"
  return line
    .replace(/^[\s*#|>~=_·•▪◦\-–—]+/, "")
    .replace(/[\s*#|<~=_·•▪◦\-–—:]+$/, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim();
}

function detectSection(line: string): SectionKind | null {
  const bare = stripDecoration(line);
  // A heading is short. "Experience in managing teams" is prose, not a heading.
  if (!bare || bare.length > 45) return null;
  for (const [kind, re] of SECTION_PATTERNS) {
    if (re.test(bare)) return kind;
  }
  return null;
}

/**
 * The header is the contact block at the top: everything before the first real
 * section heading, capped so a CV with no headings does not treat itself as all
 * header.
 */
const MAX_HEADER_LINES = 18;

export function buildDocument(normalizedText: string): StructuredDocument {
  const rawLines = normalizedText.split("\n");
  const lines: DocLine[] = [];
  let current: SectionKind = "header";
  let headerEndLine = Math.min(rawLines.length, MAX_HEADER_LINES);
  let sawFirstSection = false;

  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i];
    const detected = detectSection(text);
    if (detected) {
      if (!sawFirstSection) {
        headerEndLine = Math.min(i, MAX_HEADER_LINES);
        sawFirstSection = true;
      }
      current = detected;
      lines.push({ index: i, text, section: detected, isHeading: true });
      continue;
    }

    const entry: DocLine = { index: i, text, section: current, isHeading: false };
    const m = text.match(LABEL_LINE) ?? text.match(BARE_LABEL_LINE);
    if (m) {
      entry.label = m[1].trim();
      entry.labelValue = m[2].trim();
    }
    lines.push(entry);
  }

  const emails: StructuredDocument["emails"] = [];
  const urls: StructuredDocument["urls"] = [];
  for (const l of lines) {
    for (const m of l.text.matchAll(EMAIL_RE)) emails.push({ value: m[0], line: l.index });
    for (const m of l.text.matchAll(URL_RE)) urls.push({ value: m[0], line: l.index });
  }

  return { raw: normalizedText, lines, headerEndLine, hasSectionHeadings: sawFirstSection, emails, urls };
}

/** Lines belonging to a section, in document order. */
export function linesInSection(doc: StructuredDocument, kind: SectionKind): DocLine[] {
  return doc.lines.filter((l) => l.section === kind && !l.isHeading);
}

/**
 * True when a line sits in a section whose contents describe somebody other than
 * the candidate, or a past role rather than a desired one.
 */
export function isThirdPartySection(kind: SectionKind): boolean {
  return kind === "references";
}

/** Find the first line index of a section, or -1. */
export function sectionStart(doc: StructuredDocument, kind: SectionKind): number {
  const hit = doc.lines.find((l) => l.section === kind);
  return hit ? hit.index : -1;
}
