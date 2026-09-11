import { describe, it, expect } from "vitest";
import { buildDocument } from "@/services/cv-engine/document";
import { extractPhone } from "@/services/cv-engine/phone";

const doc = (text: string) => buildDocument(text);
const phoneOf = (text: string) => extractPhone(doc(text));

describe("local engine: phone extraction", () => {
  it("reads the common Indian formats", () => {
    const formats = [
      "Mobile: 9876543210",
      "Mobile: +91 9876543210",
      "Mobile: +91-9876543210",
      "Mobile: +91 98765 43210",
      "Mobile: 09876543210",
      "Mobile: 0091 9876543210",
      "Mobile: (+91) 98765-43210",
    ];
    for (const line of formats) {
      const r = phoneOf(`Rahul Sharma\n${line}\nrahul@example.com`);
      expect(r.value, line).toBe("+919876543210");
      expect(r.confidence, line).toBeGreaterThan(0.75);
    }
  });

  it("prefers the candidate's mobile over an alternate office number", () => {
    const r = phoneOf(
      ["Rahul Sharma", "Mobile: +91 98765 43210", "Alternate Contact (Office): 011-23456789", "rahul@example.com"].join("\n"),
    );
    expect(r.value).toBe("+919876543210");
  });

  it("ignores a referee's number in the references section", () => {
    const r = phoneOf(
      [
        "Rahul Sharma",
        "Mobile: +91 98765 43210",
        "REFERENCES",
        "Mr. Suresh Menon, Manager, Infosys - 9899988877",
      ].join("\n"),
    );
    expect(r.value).toBe("+919876543210");
  });

  it("returns Not Found when the only number belongs to somebody else", () => {
    // Presenting a referee's number as the candidate's is worse than admitting
    // there isn't one.
    const r = phoneOf(["Deepak Joshi", "deepak@example.com", "Mr. Suresh Menon, Manager, Infosys - 9899988877"].join("\n"));
    expect(r.value).toBe("Not Found");
    expect(r.confidence).toBe(0);
  });

  it("rejects PIN codes, employee ids, Aadhaar fragments and salary figures", () => {
    const r = phoneOf(
      [
        "Rahul Sharma",
        "rahul@example.com",
        "PIN Code: 560001",
        "Employee ID: 100233445",
        "Aadhaar: 1234 5678 9012",
        "Current CTC: 1200000 per annum",
      ].join("\n"),
    );
    expect(r.value).toBe("Not Found");
  });

  it("does not read a year range as a phone number", () => {
    const r = phoneOf(["Rahul Sharma", "rahul@example.com", "Infosys, Bengaluru (2018 - 2021)"].join("\n"));
    expect(r.value).toBe("Not Found");
  });

  it("rejects placeholder runs of repeated digits", () => {
    expect(phoneOf("Rahul Sharma\nMobile: 0000000000").value).toBe("Not Found");
    expect(phoneOf("Rahul Sharma\nMobile: 1234567890").value).toBe("Not Found");
  });

  it("reports where it found the number", () => {
    const r = phoneOf(["Rahul Sharma", "Mobile: +91 98765 43210"].join("\n"));
    expect(r.evidence?.line).toBe(1);
    expect(r.method).toBe("explicit_label");
  });

  it("lowers confidence when two numbers compete without labels", () => {
    const labelled = phoneOf("Rahul Sharma\nMobile: +91 98765 43210\nrahul@example.com");
    const ambiguous = phoneOf("Rahul Sharma\n9876543210\n9123456780\nrahul@example.com");
    expect(ambiguous.confidence).toBeLessThan(labelled.confidence);
  });

  it("keeps an international number in E.164 form", () => {
    const r = phoneOf("John Smith\nPhone: +1 (415) 555-0123\njohn@example.com");
    expect(r.value).toBe("+14155550123");
  });
});
