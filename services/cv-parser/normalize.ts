/**
 * Text normalisation applied before LLM extraction.
 * Goal: reduce OCR/extraction noise without destroying the signals we need
 * (names at the top, phone digits, "Applied for:" lines).
 */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
  [/[‘’‚]/g, "'"],
  [/[“”„]/g, '"'],
  [/[–—−]/g, "-"],
  [/ /g, " "],
];

// Control chars except \t \n \r
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Box-drawing / block elements produced by OCR of table borders
const BOX_DRAWING = /[\u2500-\u257F\u2580-\u259F]/g;

export function normalizeText(input: string, maxChars: number): string {
  if (!input) return "";
  let text = input.normalize("NFKC");
  for (const [re, rep] of REPLACEMENTS) text = text.replace(re, rep);
  text = text.replace(CONTROL_CHARS, "");
  text = text.replace(BOX_DRAWING, " ");
  text = text.replace(/[ \t]+/g, " ");

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const collapsed: string[] = [];
  let blank = 0;
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line) {
      blank++;
      if (blank <= 1) collapsed.push("");
      continue;
    }
    blank = 0;
    // Drop exact duplicate long lines (repeated headers/footers across pages).
    if (line.length > 25) {
      if (seen.has(line)) continue;
      seen.add(line);
    }
    collapsed.push(line);
  }
  text = collapsed.join("\n").trim();

  if (text.length > maxChars) {
    // Keep the start (name/contact/objective) and the end (declaration often
    // repeats the name) – the middle is least informative for our three fields.
    const head = Math.floor(maxChars * 0.8);
    const tail = maxChars - head;
    text = `${text.slice(0, head)}\n\n[... truncated ...]\n\n${text.slice(-tail)}`;
  }
  return text;
}
