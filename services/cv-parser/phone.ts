/**
 * Phone number normalisation with first-class support for Indian formats.
 *
 * Accepted Indian inputs (normalised to +91XXXXXXXXXX):
 *   9876543210, +91 9876543210, +91-9876543210, +91 98765 43210, 09876543210,
 *   0091 9876543210, (+91) 98765-43210, 91 98765 43210
 * Other international numbers (with +CC) are kept in E.164-ish form.
 */
export interface NormalizedPhone {
  normalized: string;
  valid: boolean;
  country: "IN" | "INTL" | "UNKNOWN";
  reason?: string;
}

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

export function normalizePhone(raw: string | null | undefined): NormalizedPhone {
  if (!raw) return { normalized: "Not Found", valid: false, country: "UNKNOWN", reason: "empty" };
  const trimmed = raw.trim();
  if (!trimmed || /^not\s*found$/i.test(trimmed) || /^n\/?a$/i.test(trimmed)) {
    return { normalized: "Not Found", valid: false, country: "UNKNOWN", reason: "empty" };
  }

  // Keep only digits and a leading plus.
  const hasPlus = /^\s*\(?\+/.test(trimmed);
  let digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return { normalized: "Not Found", valid: false, country: "UNKNOWN", reason: "no digits" };

  // Strip international dialing prefix 00.
  if (!hasPlus && digits.startsWith("00")) digits = digits.slice(2);

  // Indian forms.
  if (digits.length === 10 && INDIAN_MOBILE.test(digits)) {
    return { normalized: `+91${digits}`, valid: true, country: "IN" };
  }
  if (digits.length === 11 && digits.startsWith("0") && INDIAN_MOBILE.test(digits.slice(1))) {
    return { normalized: `+91${digits.slice(1)}`, valid: true, country: "IN" };
  }
  if (digits.length === 12 && digits.startsWith("91") && INDIAN_MOBILE.test(digits.slice(2))) {
    return { normalized: `+91${digits.slice(2)}`, valid: true, country: "IN" };
  }
  if (digits.length === 13 && (digits.startsWith("091") || digits.startsWith("910")) && INDIAN_MOBILE.test(digits.slice(3))) {
    // 0091XXXXXXXXXX (00 stripped above) or +91 (0) XXXXXXXXXX (trunk zero after country code)
    return { normalized: `+91${digits.slice(3)}`, valid: true, country: "IN" };
  }

  // Indian landline with STD code (e.g. 011-23456789, 022 2345 6789): 10–11 digits starting with 0.
  if ((digits.length === 10 || digits.length === 11) && digits.startsWith("0")) {
    return { normalized: `+91${digits.slice(1)}`, valid: true, country: "IN", reason: "landline" };
  }

  // Generic international (E.164: 8–15 digits with explicit +CC).
  if (hasPlus && digits.length >= 8 && digits.length <= 15) {
    return { normalized: `+${digits}`, valid: true, country: "INTL" };
  }

  // 10-digit non-Indian-mobile pattern without country code – ambiguous.
  if (digits.length >= 8 && digits.length <= 15) {
    return { normalized: digits, valid: false, country: "UNKNOWN", reason: "ambiguous format" };
  }

  return { normalized: "Not Found", valid: false, country: "UNKNOWN", reason: "invalid length" };
}

/** Find all candidate phone numbers in free text (used for cross-checking LLM output). */
export function findPhoneCandidates(text: string): string[] {
  const re = /(?:\+?\d{1,3}[\s-]?)?(?:\(\d{2,5}\)[\s-]?)?\d[\d\s-]{7,13}\d/g;
  const found = new Set<string>();
  for (const m of text.matchAll(re)) {
    const n = normalizePhone(m[0]);
    if (n.valid) found.add(n.normalized);
  }
  return [...found];
}
