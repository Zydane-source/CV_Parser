/**
 * Builds a labelled benchmark corpus of synthetic CVs with known ground truth.
 *
 *   npx tsx scripts/generate-benchmark-corpus.ts [outDir] [count]
 *
 * Real candidate CVs cannot be committed — they are personal data — so the corpus
 * is generated from a combinatorial grid of the things that actually break
 * extraction: layout, where the role is stated (or whether it is), competing
 * phone numbers, reference blocks, honorifics, headings that look like names, and
 * OCR-only documents.
 *
 * Ground truth is emitted alongside as `ground-truth.json`, so the benchmark
 * measures against labels rather than against another model's opinion.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface CorpusEntry {
  file: string;
  layout: string;
  /** Ground truth. `null` means the field is genuinely absent and "Not Found" is correct. */
  expected: { name: string | null; phone: string | null; role: string | null };
  /** Traits that make this case interesting, used to slice the benchmark report. */
  traits: string[];
}

/** Fictional Indian names spanning regions and token counts. */
const NAMES = [
  "Rahul Sharma", "Priya Verma", "Amit Kumar", "Sneha Reddy", "Arjun Patel",
  "Rohan Mehta", "Neha Gupta", "Vikram Singh", "Anjali Nair", "Karan Malhotra",
  "Deepak Joshi", "Meera Iyer", "Sanjay Rao", "Pooja Desai", "Aditya Chauhan",
  "Kavya Krishnan", "Rajesh Pillai", "Divya Menon", "Suresh Babu", "Ritu Agarwal",
  "Harshit Bansal", "Tanvi Kulkarni", "Manish Tiwari", "Shreya Ghosh", "Nikhil Jain",
  "Ananya Chatterjee", "Vivek Saxena", "Ishita Bose", "Gaurav Khanna", "Lakshmi Subramanian",
  "Abhirup Chakraborty", "Farhan Sheikh", "Nandini Prasad", "Yogesh Pawar", "Swati Bhat",
  "Imran Qureshi", "Ritika Sood", "Prakash Nayak", "Bhavya Shetty", "Zoya Ansari",
];

const ROLES = [
  { stated: "Java Developer", canonical: "Java Developer" },
  { stated: "Backend Developer", canonical: "Backend Developer" },
  { stated: "Frontend Developer", canonical: "Frontend Developer" },
  { stated: "Data Analyst", canonical: "Data Analyst" },
  { stated: "Business Development Executive", canonical: "Business Development Executive" },
  { stated: "HR Executive", canonical: "HR Executive" },
  { stated: "Accountant", canonical: "Accountant" },
  { stated: "Digital Marketing Executive", canonical: "Digital Marketing Executive" },
  { stated: "Mechanical Engineer", canonical: "Mechanical Engineer" },
  { stated: "Civil Engineer", canonical: "Civil Engineer" },
  { stated: "Content Writer", canonical: "Content Writer" },
  { stated: "Sales Executive", canonical: "Sales Executive" },
  { stated: "Full Stack Developer", canonical: "Full Stack Developer" },
  { stated: "Customer Support Executive", canonical: "Customer Support Executive" },
  { stated: "QA Engineer", canonical: "QA Engineer" },
  { stated: "Operations Executive", canonical: "Operations Executive" },
  // Aliases that must normalise to a canonical title.
  { stated: "Back End Developer", canonical: "Backend Developer" },
  { stated: "BDE", canonical: "Business Development Executive" },
  { stated: "Software Developer", canonical: "Software Engineer" },
  { stated: "IT Recruiter", canonical: "HR Recruiter" },
  { stated: "React Developer", canonical: "Frontend Developer" },
  { stated: "ML Engineer", canonical: "Machine Learning Engineer" },
];

const CITIES = ["Bengaluru", "Pune", "Hyderabad", "Chennai", "Mumbai", "Delhi", "Kolkata", "Ahmedabad", "Noida", "Jaipur"];
const COMPANIES = ["Infosys", "Wipro", "TCS", "Cognizant", "HCL", "Tech Mahindra", "Accenture", "Capgemini", "L&T", "Reliance"];

/** How the applied role is expressed, if at all. */
type RoleStyle = "applied_label" | "position_label" | "objective_phrase" | "headline" | "header_title" | "current_only" | "absent";
/** Visual layout of the document. */
type Layout = "traditional" | "modern" | "two_column" | "table" | "minimal";

function mobile(seed: number): string {
  const first = [6, 7, 8, 9][seed % 4];
  const rest = String(1000000000 + ((seed * 7919) % 900000000)).slice(1, 10);
  return `${first}${rest}`;
}

function fmtPhone(digits: string, style: number): string {
  switch (style % 5) {
    case 0: return `+91 ${digits}`;
    case 1: return `+91-${digits}`;
    case 2: return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
    case 3: return `0${digits}`;
    default: return digits;
  }
}

interface Spec {
  name: string;
  phoneDigits: string | null;
  phoneStyle: number;
  role: { stated: string; canonical: string } | null;
  roleStyle: RoleStyle;
  layout: Layout;
  city: string;
  company: string;
  withReferences: boolean;
  withHonorific: boolean;
  withCvHeading: boolean;
  withAlternatePhone: boolean;
  withDecoyNumbers: boolean;
  scanned: boolean;
  format: "pdf" | "docx" | "png";
}

/** Lines of the CV body, in order, for a given spec. */
function composeLines(s: Spec): string[] {
  const L: string[] = [];
  const email = `${s.name.toLowerCase().replace(/\s+/g, ".")}@example.com`;
  const phone = s.phoneDigits ? fmtPhone(s.phoneDigits, s.phoneStyle) : null;

  if (s.withCvHeading) L.push(s.layout === "table" ? "CURRICULUM VITAE" : "RESUME");

  const displayName = s.withHonorific ? `Mr. ${s.name}` : s.name;

  if (s.layout === "table") {
    L.push("PERSONAL DETAILS");
    L.push(`Name : ${displayName}`);
    if (phone) L.push(`Mobile : ${phone}`);
    L.push(`Email : ${email}`);
    if (s.roleStyle === "applied_label" && s.role) L.push(`Position Applied For : ${s.role.stated}`);
    if (s.roleStyle === "position_label" && s.role) L.push(`Post Applied : ${s.role.stated}`);
    if (s.roleStyle === "header_title" && s.role) L.push(`Designation : ${s.role.stated}`);
    L.push(`Date of Birth : 14/03/1996`);
    L.push(`Address : 21 MG Road, ${s.city} 560001`);
  } else {
    L.push(displayName);
    if (s.roleStyle === "header_title" && s.role) L.push(s.role.stated);
    const contactBits = [phone, email, s.city].filter(Boolean);
    L.push(contactBits.join(" | "));
    if (s.roleStyle === "applied_label" && s.role) L.push(`Applied For: ${s.role.stated}`);
    if (s.roleStyle === "position_label" && s.role) L.push(`Position: ${s.role.stated}`);
  }

  if (s.withAlternatePhone) L.push(`Alternate Contact (Office): 0${["11", "22", "33", "44"][s.phoneStyle % 4]}-2345 6789`);
  if (s.withDecoyNumbers) {
    L.push(`PIN Code: 5600${(s.phoneStyle % 9) + 1}`);
    L.push(`Employee ID: 100${(s.phoneStyle * 37) % 99999}`);
    L.push(`Aadhaar: XXXX XXXX ${1000 + (s.phoneStyle % 8999)}`);
  }

  if (s.roleStyle === "objective_phrase" && s.role) {
    L.push("CAREER OBJECTIVE");
    L.push(`Seeking a challenging position as a ${s.role.stated} in a reputed organisation where I can contribute my skills.`);
  } else if (s.roleStyle === "headline" && s.role) {
    L.push("PROFILE SUMMARY");
    L.push(`${s.role.stated} with 4 years of experience delivering projects end to end.`);
  } else if (s.roleStyle === "absent") {
    L.push("PROFILE SUMMARY");
    L.push(`Hardworking professional with 4 years of experience and a track record of dependable delivery.`);
  }

  L.push("WORK EXPERIENCE");
  if (s.roleStyle === "current_only" && s.role) {
    L.push(`Current Designation : ${s.role.stated}`);
  }
  L.push(`Senior Associate, ${s.company}, ${s.city} (2021 - Present)`);
  L.push(`- Delivered projects on schedule and mentored junior colleagues.`);
  L.push(`Associate, ${COMPANIES[(COMPANIES.indexOf(s.company) + 3) % COMPANIES.length]}, ${s.city} (2018 - 2021)`);

  L.push("EDUCATION");
  L.push(`B.Tech, ${s.city} Institute of Technology, 2018`);
  L.push("SKILLS");
  L.push("Communication, teamwork, problem solving, MS Office");

  if (s.withReferences) {
    L.push("REFERENCES");
    L.push(`Mr. Suresh Menon, Manager, ${s.company} - 9899988877`);
    L.push(`Dr. Latha Krishnan, Professor - +91 94470 11223`);
  }

  L.push("DECLARATION");
  L.push(`I hereby declare that the above information is true. - ${s.name}`);
  return L;
}

/**
 * Wrap on word boundaries. Truncating instead would silently delete the very
 * text the benchmark is meant to find, turning a corpus artefact into a fake
 * extraction failure.
 */
function wrap(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const words = text.split(" ");
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > maxChars) {
      out.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(line);
  return out;
}

async function buildPdf(lines: string[], layout: Layout): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 800;

  const isHeading = (t: string) => /^[A-Z][A-Z\s&]{3,}$/.test(t.trim());

  if (layout === "two_column") {
    // Narrow sidebar holds only the short contact lines; everything else goes in
    // the main column, wrapped rather than clipped.
    const sidebar: string[] = [];
    const main: string[] = [];
    for (const l of lines) {
      // Contact-ish short lines go left, as a real two-column CV would place them.
      if (sidebar.length < 4 && (l.includes("@") || /\+?\d[\d\s().-]{7,}/.test(l) || l === lines[0])) sidebar.push(l);
      else main.push(l);
    }
    let ly = 800;
    for (const l of sidebar) {
      for (const part of wrap(l, 26)) {
        page.drawText(part, { x: 40, y: ly, size: 9, font: isHeading(l) ? bold : font });
        ly -= 14;
      }
    }
    let ry = 800;
    for (const l of main) {
      const heading = isHeading(l);
      for (const part of wrap(l, 52)) {
        if (ry < 50) { page = pdf.addPage([595, 842]); ry = 800; }
        page.drawText(part, { x: 230, y: ry, size: 10, font: heading ? bold : font });
        ry -= 16;
      }
    }
    return Buffer.from(await pdf.save());
  }

  for (const l of lines) {
    const heading = isHeading(l);
    const size = l === lines[0] && layout !== "minimal" ? 18 : heading ? 12 : 10;
    const width = size >= 18 ? 40 : size === 12 ? 70 : 88;
    for (const part of wrap(l, width)) {
      if (y < 50) { page = pdf.addPage([595, 842]); y = 800; }
      page.drawText(part, { x: 50, y, size, font: heading || size === 18 ? bold : font, color: rgb(0.1, 0.1, 0.1) });
      y -= size + 7;
    }
  }
  return Buffer.from(await pdf.save());
}

async function buildImage(lines: string[]): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const W = 1240, H = 1754;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111111";
  let y = 90;
  let first = true;
  for (const l of lines) {
    if (y > H - 40) break;
    const heading = /^[A-Z][A-Z\s&]{3,}$/.test(l.trim());
    const size = first ? 44 : heading ? 30 : 26;
    ctx.font = `${heading || first ? "bold " : ""}${size}px Arial, Helvetica, sans-serif`;
    for (const part of wrap(l, first ? 28 : 58)) {
      if (y > H - 40) break;
      ctx.fillText(part, 80, y);
      y += size + 14;
    }
    first = false;
  }
  return Buffer.from(canvas.toBuffer("image/png"));
}

async function buildScannedPdf(png: Buffer): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(png);
  const page = pdf.addPage([595, 842]);
  page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  return Buffer.from(await pdf.save());
}

async function buildDocx(lines: string[]): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = lines.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Deterministic spec grid — same corpus every run, so results are comparable. */
function buildSpecs(count: number): Spec[] {
  const roleStyles: RoleStyle[] = ["applied_label", "position_label", "objective_phrase", "headline", "header_title", "current_only", "absent"];
  const layouts: Layout[] = ["traditional", "modern", "two_column", "table", "minimal"];
  const specs: Spec[] = [];

  for (let i = 0; i < count; i++) {
    const roleStyle = roleStyles[i % roleStyles.length];
    const layout = layouts[Math.floor(i / roleStyles.length) % layouts.length];
    const role = ROLES[i % ROLES.length];
    const noPhone = i % 17 === 5;            // a few CVs genuinely lack a phone
    const scanned = i % 11 === 3;            // image-only PDFs
    const asImage = i % 13 === 7;            // plain image CVs
    const asDocx = !scanned && !asImage && i % 5 === 2;

    specs.push({
      name: NAMES[i % NAMES.length],
      phoneDigits: noPhone ? null : mobile(i + 1),
      phoneStyle: i,
      role: roleStyle === "absent" ? null : role,
      roleStyle,
      layout,
      city: CITIES[i % CITIES.length],
      company: COMPANIES[i % COMPANIES.length],
      withReferences: i % 3 === 0,
      withHonorific: i % 7 === 2,
      withCvHeading: i % 4 === 0,
      withAlternatePhone: i % 6 === 1,
      withDecoyNumbers: i % 5 === 0,
      scanned,
      format: scanned ? "pdf" : asImage ? "png" : asDocx ? "docx" : "pdf",
    });
  }
  return specs;
}

function traitsOf(s: Spec): string[] {
  const t = [`layout:${s.layout}`, `role_style:${s.roleStyle}`, `format:${s.format}`];
  if (s.scanned) t.push("scanned");
  if (s.withReferences) t.push("has_references");
  if (s.withAlternatePhone) t.push("alternate_phone");
  if (s.withDecoyNumbers) t.push("decoy_numbers");
  if (s.withHonorific) t.push("honorific");
  if (s.withCvHeading) t.push("cv_heading");
  if (!s.phoneDigits) t.push("no_phone");
  if (s.roleStyle === "absent") t.push("no_role");
  if (s.roleStyle === "current_only") t.push("current_role_only");
  return t;
}

export async function generateCorpus(outDir: string, count: number): Promise<CorpusEntry[]> {
  await fs.mkdir(outDir, { recursive: true });
  const specs = buildSpecs(count);
  const entries: CorpusEntry[] = [];

  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const lines = composeLines(s);
    const slug = `${String(i).padStart(3, "0")}_${s.name.replace(/\s+/g, "_")}`;
    let file: string;
    let bytes: Buffer;

    if (s.scanned) {
      file = `${slug}_scanned.pdf`;
      bytes = await buildScannedPdf(await buildImage(lines));
    } else if (s.format === "png") {
      file = `${slug}.png`;
      bytes = await buildImage(lines);
    } else if (s.format === "docx") {
      file = `${slug}_Resume.docx`;
      bytes = await buildDocx(lines);
    } else {
      file = `${slug}_Resume.pdf`;
      bytes = await buildPdf(lines, s.layout);
    }

    await fs.writeFile(path.join(outDir, file), bytes);
    entries.push({
      file,
      layout: s.layout,
      expected: {
        name: s.name,
        phone: s.phoneDigits ? `+91${s.phoneDigits}` : null,
        // "current_only" states a designation but never an applied role. The
        // correct answer is the stated designation at low confidence, so the
        // ground truth accepts it; see docs/benchmark.md.
        role: s.role ? s.role.canonical : null,
      },
      traits: traitsOf(s),
    });
  }

  await fs.writeFile(path.join(outDir, "ground-truth.json"), JSON.stringify({ generated: new Date().toISOString(), count: entries.length, entries }, null, 2));
  return entries;
}

const isMain = process.argv[1] && /generate-benchmark-corpus\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const outDir = path.resolve(process.argv[2] ?? "tests/fixtures/benchmark");
  const count = Number(process.argv[3] ?? 120);
  generateCorpus(outDir, count)
    .then((e) => {
      const byFormat = e.reduce<Record<string, number>>((a, x) => { const f = x.traits.find((t) => t.startsWith("format:"))!; a[f] = (a[f] ?? 0) + 1; return a; }, {});
      console.log(`Generated ${e.length} CVs in ${outDir}`);
      console.log("By format:", byFormat);
      console.log("Scanned:", e.filter((x) => x.traits.includes("scanned")).length, "| no phone:", e.filter((x) => x.traits.includes("no_phone")).length, "| no role:", e.filter((x) => x.traits.includes("no_role")).length);
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
