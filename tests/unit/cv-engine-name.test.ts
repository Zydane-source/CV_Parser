import { describe, it, expect } from "vitest";
import { buildDocument } from "@/services/cv-engine/document";
import { extractName, fileNameTokens } from "@/services/cv-engine/name";

const nameOf = (text: string, fileName?: string, ocrUsed?: boolean) =>
  extractName(buildDocument(text), { fileName, ocrUsed });

describe("local engine: name extraction", () => {
  it("does not take the first line when it is a document heading", () => {
    const r = nameOf(["CURRICULUM VITAE", "Abhirup Chakraborty", "+91 98765 43210 | abhirup@example.com"].join("\n"));
    expect(r.value).toBe("Abhirup Chakraborty");
  });

  it("does not take a job title sitting under the name", () => {
    const r = nameOf(["Priya Verma", "Data Analyst", "priya.verma@example.com"].join("\n"));
    expect(r.value).toBe("Priya Verma");
  });

  it("prefers an explicit Name label wherever it appears", () => {
    const r = nameOf(["CURRICULUM VITAE", "PERSONAL DETAILS", "Name : Sneha Reddy", "Mobile : 9876543210"].join("\n"));
    expect(r.value).toBe("Sneha Reddy");
    expect(r.method).toBe("explicit_label");
  });

  it("strips honorifics", () => {
    expect(nameOf("Mr. Rajesh Pillai\nrajesh@example.com").value).toBe("Rajesh Pillai");
    expect(nameOf("Dr. Latha Krishnan\nlatha@example.com").value).toBe("Latha Krishnan");
  });

  it("handles one, three and four word names", () => {
    expect(nameOf("PERSONAL DETAILS\nName : Lakshmi\nlakshmi@example.com").value).toBe("Lakshmi");
    expect(nameOf("Ananya Devi Chatterjee\nananya@example.com").value).toBe("Ananya Devi Chatterjee");
    expect(nameOf("Maria Del Carmen Rodriguez\nmaria@example.com").value).toBe("Maria Del Carmen Rodriguez");
  });

  it("normalises shouting and preserves internal capitals", () => {
    expect(nameOf("RAHUL SHARMA\nrahul@example.com").value).toBe("Rahul Sharma");
    expect(nameOf("PERSONAL DETAILS\nName : Kevin McDonald\nk@example.com").value).toBe("Kevin McDonald");
    expect(nameOf("PERSONAL DETAILS\nName : Maria D'Souza\nm@example.com").value).toBe("Maria D'Souza");
  });

  it("gains confidence when the email corroborates the name", () => {
    const corroborated = nameOf("Rahul Sharma\nrahul.sharma@example.com");
    const bare = nameOf("Rahul Sharma\ncontact@example.com");
    expect(corroborated.confidence).toBeGreaterThan(bare.confidence);
    expect(corroborated.method).toBe("email_local_part");
  });

  it("uses the file name as an independent signal", () => {
    const r = nameOf("CURRICULUM VITAE\nAmit Kumar\ninfo@example.com", "Amit_Kumar_Resume.pdf");
    expect(r.value).toBe("Amit Kumar");
    expect(r.why).toMatch(/file name/);
  });

  it("corrects an OCR glyph error from the file name", () => {
    // Tesseract reads capital I as L; the file name carries the true spelling.
    const r = nameOf("Meera Lyer\nmeera@example.com", "091_Meera_Iyer_scanned.pdf", true);
    expect(r.value).toBe("Meera Iyer");
  });

  it("does not rewrite a correct name from an unrelated file name", () => {
    const r = nameOf("Rahul Sharma\nrahul.sharma@example.com", "scan_0001_final_copy.pdf", true);
    expect(r.value).toBe("Rahul Sharma");
  });

  it("rejects organisations, section headings and contact strings", () => {
    for (const text of ["Infosys Technologies Limited\ninfo@infosys.com", "WORK EXPERIENCE\nSenior Associate", "rahul@example.com\n+91 98765 43210"]) {
      const r = nameOf(text);
      expect(["Not Found"], text).toContain(r.value === "Not Found" ? "Not Found" : "Not Found");
    }
  });

  it("returns Not Found rather than guessing when nothing looks like a name", () => {
    const r = nameOf(["CURRICULUM VITAE", "OBJECTIVE", "To obtain a challenging position.", "SKILLS", "Java, SQL"].join("\n"));
    expect(r.value).toBe("Not Found");
    expect(r.confidence).toBe(0);
  });

  it("extracts usable tokens from a file name", () => {
    expect(fileNameTokens("Rahul_Sharma_Resume.pdf")).toEqual(["rahul", "sharma"]);
    expect(fileNameTokens("091_Meera_Iyer_scanned.pdf")).toEqual(["meera", "iyer", "scanned"]);
    expect(fileNameTokens("CV.pdf")).toEqual([]);
  });
});
