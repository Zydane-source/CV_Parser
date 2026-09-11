import { describe, it, expect } from "vitest";
import { buildDocument } from "@/services/cv-engine/document";
import { extractRole } from "@/services/cv-engine/role";
import { RoleTaxonomy, getTaxonomy, canonicalKey } from "@/services/cv-engine/taxonomy";

const roleOf = (text: string) => extractRole(buildDocument(text));
const header = ["Rahul Sharma", "+91 98765 43210 | rahul@example.com"].join("\n");

describe("local engine: role taxonomy", () => {
  const tax = getTaxonomy();

  it("resolves canonical titles and aliases to one canonical form", () => {
    expect(tax.match("Backend Developer")?.canonical).toBe("Backend Developer");
    expect(tax.match("Back End Developer")?.canonical).toBe("Backend Developer");
    expect(tax.match("Node.js Developer")?.canonical).toBe("Backend Developer");
    expect(tax.match("BDE")?.canonical).toBe("Business Development Executive");
    expect(tax.match("ML Engineer")?.canonical).toBe("Machine Learning Engineer");
  });

  it("is insensitive to case, spacing and separators", () => {
    expect(canonicalKey("Back-End  DEVELOPER")).toBe("back end developer");
    expect(tax.match("back-end developer")?.canonical).toBe("Backend Developer");
    expect(tax.match("FULL STACK DEVELOPER")?.canonical).toBe("Full Stack Developer");
  });

  it("keeps the stated seniority alongside the canonical title", () => {
    const m = tax.match("Senior Backend Engineer");
    expect(m?.canonical).toBe("Backend Developer");
    expect(m?.seniority).toBe("Senior");
  });

  it("rejects generic placeholders", () => {
    for (const g of ["Job Seeker", "Candidate", "Professional", "Any Position", "Fresher"]) {
      expect(tax.isGeneric(g), g).toBe(true);
      expect(tax.match(g), g).toBeNull();
    }
  });

  it("is configurable without code changes", () => {
    const custom = new RoleTaxonomy({
      version: "test",
      families: [{ family: "Aviation", roles: [{ canonical: "Flight Dispatcher", aliases: ["Ops Dispatcher"] }] }],
      seniorityPrefixes: ["Senior"],
      genericRejects: [],
    });
    expect(custom.match("Ops Dispatcher")?.canonical).toBe("Flight Dispatcher");
    expect(custom.allCanonical()).toEqual(["Flight Dispatcher"]);
  });
});

describe("local engine: role extraction", () => {
  it("reads explicit applied labels with high confidence", () => {
    for (const label of ["Applied For", "Position Applied For", "Post Applied", "Job Role", "Desired Position"]) {
      const r = roleOf(`${header}\n${label}: Java Developer`);
      expect(r.value, label).toBe("Java Developer");
      expect(r.confidence, label).toBeGreaterThanOrEqual(0.8);
      expect(r.method, label).toBe("explicit_label");
    }
  });

  it("reads intent phrases from an objective", () => {
    const cases: Array<[string, string]> = [
      ["Seeking a challenging position as a Data Analyst in a reputed organisation.", "Data Analyst"],
      ["Looking for a role as a Backend Developer where I can grow.", "Backend Developer"],
      ["To work as a Content Writer with a leading firm.", "Content Writer"],
      ["Applying for the post of Sales Executive.", "Sales Executive"],
    ];
    for (const [sentence, expected] of cases) {
      const r = roleOf(`${header}\nCAREER OBJECTIVE\n${sentence}`);
      expect(r.value, sentence).toBe(expected);
    }
  });

  it("recovers a title split across wrapped lines", () => {
    // pdf.js returns wrapped prose as separate lines; the title straddles them.
    const r = roleOf([header, "CAREER OBJECTIVE", "Seeking a challenging position as a Digital Marketing", "Executive in a reputed organisation."].join("\n"));
    expect(r.value).toBe("Digital Marketing Executive");
  });

  it("prefers the applied role over the current designation", () => {
    const r = roleOf([header, "Applied For: Data Analyst", "WORK EXPERIENCE", "Current Designation : Senior Software Engineer"].join("\n"));
    expect(r.value).toBe("Data Analyst");
  });

  it("reports a current designation only at low confidence when nothing else exists", () => {
    const r = roleOf([header, "WORK EXPERIENCE", "Current Designation : Senior Software Engineer"].join("\n"));
    expect(r.value).toMatch(/Software Engineer/);
    // Below the 0.75 review threshold: inferring intent from history is a guess.
    expect(r.confidence).toBeLessThan(0.75);
    expect(r.why).toMatch(/history, not intent/);
  });

  it("returns Not Found rather than inventing a role", () => {
    const r = roleOf([header, "PROFILE SUMMARY", "Hardworking professional with a track record of dependable delivery.", "SKILLS", "MS Office"].join("\n"));
    expect(r.value).toBe("Not Found");
    expect(r.confidence).toBe(0);
  });

  it("rejects a generic aspiration as a role", () => {
    const r = roleOf([header, "OBJECTIVE", "Looking for a job in a good company."].join("\n"));
    expect(r.value).toBe("Not Found");
  });

  it("normalises an alias stated in a headline", () => {
    const r = roleOf([header, "PROFILE SUMMARY", "BDE with 4 years of experience delivering projects."].join("\n"));
    expect(r.value).toBe("Business Development Executive");
  });

  it("trims trailing qualifiers from a captured title", () => {
    const r = roleOf([header, "OBJECTIVE", "Seeking a position as a Java Developer in a reputed organisation where I can apply my skills."].join("\n"));
    expect(r.value).toBe("Java Developer");
  });

  it("explains which evidence tier it used", () => {
    const r = roleOf(`${header}\nApplied For: Java Developer`);
    expect(r.why).toMatch(/^tier 1/);
  });
});
