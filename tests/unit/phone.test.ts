import { describe, it, expect } from "vitest";
import { normalizePhone, findPhoneCandidates } from "@/services/cv-parser/phone";

describe("normalizePhone – Indian formats", () => {
  const cases: Array<[string, string]> = [
    ["9876543210", "+919876543210"],
    ["+91 9876543210", "+919876543210"],
    ["+91-9876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["0091 9876543210", "+919876543210"],
    ["(+91) 98765-43210", "+919876543210"],
    ["91 98765 43210", "+919876543210"],
    ["+91 (0) 98765 43210", "+919876543210"],
  ];
  for (const [input, expected] of cases) {
    it(`normalises "${input}" → ${expected}`, () => {
      const r = normalizePhone(input);
      expect(r.valid).toBe(true);
      expect(r.normalized).toBe(expected);
      expect(r.country).toBe("IN");
    });
  }

  it("handles landlines with STD code", () => {
    const r = normalizePhone("011-23456789");
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe("+911123456789");
  });

  it("keeps international numbers with explicit country code", () => {
    const r = normalizePhone("+1 (415) 555-0123");
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe("+14155550123");
    expect(r.country).toBe("INTL");
  });

  it("rejects Not Found / empty / garbage", () => {
    expect(normalizePhone("Not Found").valid).toBe(false);
    expect(normalizePhone("").valid).toBe(false);
    expect(normalizePhone("N/A").valid).toBe(false);
    expect(normalizePhone("abc").valid).toBe(false);
    expect(normalizePhone("12345").valid).toBe(false);
    expect(normalizePhone("Not Found").normalized).toBe("Not Found");
  });

  it("flags ambiguous 10-digit numbers not matching Indian mobile pattern", () => {
    const r = normalizePhone("1234567890");
    expect(r.valid).toBe(false);
  });
});

describe("findPhoneCandidates", () => {
  it("finds all valid numbers in free text", () => {
    const text = "Mobile: +91 98111 22233 | Alternate: 0484-2345678\nRef: Mr Suresh 9899988877";
    const found = findPhoneCandidates(text);
    expect(found).toContain("+919811122233");
    expect(found).toContain("+919899988877");
    expect(found.length).toBeGreaterThanOrEqual(2);
  });
});
