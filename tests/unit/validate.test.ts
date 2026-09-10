import { describe, it, expect } from "vitest";
import { validateName, validateRole, validatePhone, validateExtraction, NOT_FOUND } from "@/services/cv-parser/validate";

describe("validateName", () => {
  it("accepts ordinary names and title-cases shouting", () => {
    expect(validateName("Rahul Sharma")).toEqual({ value: "Rahul Sharma", ok: true });
    expect(validateName("RAHUL SHARMA").value).toBe("Rahul Sharma");
    expect(validateName("Mr. Amit Kumar").value).toBe("Amit Kumar");
    expect(validateName("Sneha Reddy").ok).toBe(true);
  });
  it("rejects labels, companies, organisations and recruiters", () => {
    for (const bad of ["Resume", "Curriculum Vitae", "CV", "Infosys Ltd", "Wipro Technologies", "Delhi University", "HR Manager", "Talent Acquisition Team", "Tata Consultancy Services", "Reference", "rahul@example.com", "Rahul 9876543210"]) {
      const r = validateName(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.value).toBe(NOT_FOUND);
    }
  });
  it("returns Not Found for empty/Not Found input", () => {
    expect(validateName("Not Found").ok).toBe(false);
    expect(validateName("").ok).toBe(false);
    expect(validateName(null).ok).toBe(false);
  });
});

describe("validateRole", () => {
  it("accepts specific roles", () => {
    expect(validateRole("Java Developer").value).toBe("Java Developer");
    expect(validateRole("HR Executive.").value).toBe("HR Executive");
  });
  it("rejects generic values", () => {
    for (const bad of ["Job Seeker", "Candidate", "Professional", "Employee", "Looking for a job", "Any suitable position", "Fresher", "N/A", "A challenging position"]) {
      expect(validateRole(bad).ok, bad).toBe(false);
    }
  });
});

describe("validatePhone", () => {
  it("normalises and verifies against CV text", () => {
    const r = validatePhone("+91 98765 43210", "Contact: +91 98765 43210");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("+919876543210");
    expect(r.inText).toBe(true);
  });
  it("detects hallucinated numbers not present in the text", () => {
    const r = validatePhone("9876543210", "Contact: 9111111111 only");
    expect(r.ok).toBe(true);
    expect(r.inText).toBe(false);
  });
});

describe("validateExtraction", () => {
  const good = {
    candidate_name: "Rahul Sharma",
    phone_number: "+91 98765 43210",
    job_role_applied_for: "Java Developer",
    confidence: { candidate_name: 0.98, phone_number: 0.96, job_role_applied_for: 0.9 },
  };
  const cv = "RAHUL SHARMA\nMobile: +91 98765 43210\nApplied For: Java Developer";

  it("passes a clean extraction", () => {
    const v = validateExtraction(good, { threshold: 0.75, cvText: cv });
    expect(v.needsReview).toBe(false);
    expect(v.candidateName).toBe("Rahul Sharma");
    expect(v.phoneNumber).toBe("+919876543210");
    expect(v.jobRoleAppliedFor).toBe("Java Developer");
    expect(v.overallConfidence).toBeGreaterThan(0.9);
  });

  it("flags NEEDS_REVIEW when any confidence is below threshold", () => {
    const v = validateExtraction({ ...good, confidence: { ...good.confidence, job_role_applied_for: 0.61 } }, { threshold: 0.75, cvText: cv });
    expect(v.needsReview).toBe(true);
    expect(v.reviewReasons.join(" ")).toMatch(/job role confidence 0.61/);
  });

  it("rejects a company name as candidate and zeroes its confidence", () => {
    const v = validateExtraction({ ...good, candidate_name: "Infosys Ltd" }, { threshold: 0.75, cvText: cv });
    expect(v.candidateName).toBe(NOT_FOUND);
    expect(v.nameConfidence).toBe(0);
    expect(v.needsReview).toBe(true);
  });

  it("caps phone confidence when the number is not in the CV text (anti-hallucination)", () => {
    const v = validateExtraction({ ...good, phone_number: "9000000000" }, { threshold: 0.75, cvText: cv });
    expect(v.phoneConfidence).toBeLessThanOrEqual(0.4);
    expect(v.needsReview).toBe(true);
  });

  it("handles missing fields with Not Found and zero confidence", () => {
    const v = validateExtraction(
      { candidate_name: "Neha Gupta", phone_number: "Not Found", job_role_applied_for: "Not Found", confidence: { candidate_name: 0.9, phone_number: 0, job_role_applied_for: 0 } },
      { threshold: 0.75 },
    );
    expect(v.phoneNumber).toBe(NOT_FOUND);
    expect(v.jobRoleAppliedFor).toBe(NOT_FOUND);
    expect(v.needsReview).toBe(true);
  });

  it("clamps out-of-range confidences", () => {
    const v = validateExtraction({ ...good, confidence: { candidate_name: 7, phone_number: -1, job_role_applied_for: 0.9 } }, { threshold: 0.75, cvText: cv });
    expect(v.nameConfidence).toBe(1);
    expect(v.phoneConfidence).toBe(0);
  });
});
