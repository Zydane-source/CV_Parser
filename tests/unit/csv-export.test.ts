import { describe, it, expect } from "vitest";
import { csvCell, csvRow, toCsv, csvFileName, isDangerousCell, UTF8_BOM } from "@/services/export/csv";

/**
 * Cell values originate in CV documents, so the escaping is a security control,
 * not just formatting.
 */
describe("csvCell", () => {
  it("passes ordinary values through unchanged", () => {
    expect(csvCell("Rahul Sharma")).toBe("Rahul Sharma");
    expect(csvCell("Java Developer")).toBe("Java Developer");
    expect(csvCell("Not Found")).toBe("Not Found");
  });

  it("leaves normalised phone numbers intact", () => {
    // A leading + would be escaped by a naive rule, writing an apostrophe into
    // the file and corrupting the number for any downstream parser.
    expect(csvCell("+919876543210")).toBe("+919876543210");
    expect(csvCell("+91 98765 43210")).toBe("+91 98765 43210");
    expect(csvCell("+1 (415) 555-0123")).toBe("+1 (415) 555-0123");
    expect(isDangerousCell("+919876543210")).toBe(false);
  });

  it("quotes values containing commas, quotes or newlines", () => {
    expect(csvCell("Sharma, Rahul")).toBe('"Sharma, Rahul"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("neutralises spreadsheet formula injection", () => {
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell("@SUM(A1:A9)")).toBe("'@SUM(A1:A9)");
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("\tmalicious")).toBe("'\tmalicious");
    // +/- followed by anything non-numeric is still escaped.
    expect(csvCell("+cmd|'/c calc'!A1")).toBe("'+cmd|'/c calc'!A1");
    expect(csvCell("-2+3+cmd|'/c calc'!A1")).toBe("'-2+3+cmd|'/c calc'!A1");
    for (const payload of ["=HYPERLINK(x)", "@x", "=x", "+x", "-x"]) {
      expect(isDangerousCell(payload), payload).toBe(true);
    }
  });

  it("escapes a formula that also needs quoting", () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
  });

  it("renders null and undefined as empty cells", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("csvRow / toCsv", () => {
  it("uses CRLF line endings per RFC 4180", () => {
    expect(csvRow(["a", "b"])).toBe("a,b\r\n");
  });

  it("starts the document with a UTF-8 BOM so Excel reads accents correctly", () => {
    const csv = toCsv(["Candidate Name"], [["Ananya Krishnamurthy"]]);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain("Ananya Krishnamurthy");
  });

  it("produces the three requested columns in order and unmangled", () => {
    const csv = toCsv(
      ["Candidate Name", "Phone Number", "Job Role Applied For"],
      [
        ["Rahul Sharma", "+919876543210", "Java Developer"],
        ["Neha Gupta", "Not Found", "Content Writer"],
      ],
    );
    const lines = csv.replace(UTF8_BOM, "").trim().split("\r\n");
    expect(lines[0]).toBe("Candidate Name,Phone Number,Job Role Applied For");
    expect(lines[1]).toBe("Rahul Sharma,+919876543210,Java Developer");
    expect(lines[2]).toBe("Neha Gupta,Not Found,Content Writer");
  });

  it("round-trips through a strict RFC 4180 parser", () => {
    const rows = [
      ["Sharma, Rahul", "+919876543210", 'Senior "Java" Developer'],
      ["=evil()", "Not Found", "Line1\nLine2"],
    ];
    const csv = toCsv(["a", "b", "c"], rows);
    expect(parseCsv(csv.replace(UTF8_BOM, ""))).toEqual([
      ["a", "b", "c"],
      ["Sharma, Rahul", "+919876543210", 'Senior "Java" Developer'],
      ["'=evil()", "Not Found", "Line1\nLine2"],
    ]);
  });
});

describe("csvFileName", () => {
  it("is timestamped and filesystem-safe", () => {
    const n = csvFileName();
    expect(n).toMatch(/^candidates-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
    expect(n).not.toMatch(/[:/\\]/);
  });
});

/** Minimal RFC 4180 reader used to prove the writer is parseable. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
