/**
 * CSV serialisation for candidate exports.
 *
 * Two hazards worth being explicit about:
 *
 * 1. Formula injection. Cell values come from CV documents, i.e. from outside
 *    the system. A value starting with =, +, -, @ or a control character can be
 *    executed as a formula by Excel, LibreOffice and Google Sheets, which is a
 *    remote-code-execution vector (=cmd|'/c calc'!A1). Such values are prefixed
 *    with a single quote so they are read as text.
 *
 *    The exception is a plain phone number: "+919876543210" begins with a
 *    formula character but can only ever evaluate to a harmless number, so it is
 *    left untouched. Escaping it would write a literal apostrophe into the file
 *    and corrupt the value for any downstream parser.
 *
 * 2. Encoding. Candidate names are frequently non-ASCII. Excel only detects
 *    UTF-8 reliably when the file opens with a byte order mark, so exports
 *    start with one.
 */
export const UTF8_BOM = "﻿";

const NEEDS_QUOTING = /[",\r\n]/;
/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A leading +/- on a purely numeric value (phone number, signed number) cannot execute. */
const SAFE_NUMERIC = /^[+-][\d\s().-]+$/;

export function isDangerousCell(s: string): boolean {
  if (!FORMULA_START.test(s)) return false;
  if (SAFE_NUMERIC.test(s)) return false;
  return true;
}

/** Escape one cell: neutralise formulas, then apply RFC 4180 quoting. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (isDangerousCell(s)) s = `'${s}`;
  if (NEEDS_QUOTING.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}

/** Build a complete CSV document (small exports / tests). */
export function toCsv(headers: string[], rows: unknown[][]): string {
  return UTF8_BOM + csvRow(headers) + rows.map(csvRow).join("");
}

/** Timestamped, filesystem-safe download name. */
export function csvFileName(prefix = "candidates"): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `${prefix}-${stamp}.csv`;
}
