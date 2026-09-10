/**
 * Generates synthetic CV fixtures covering real-world layout variations:
 * traditional, modern, two-column, tables, embedded image, scanned (image-only)
 * PDF, image CV (PNG/JPG/WEBP), DOCX, no phone, no applied role, multiple phones,
 * references. Names/phones are fictional.
 *
 *   npm run fixtures            → tests/fixtures/generated/
 * Also imported by tests (generateAllFixtures).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface FixtureSpec {
  file: string;
  description: string;
  expected: { name: string | null; phone: string | null; role: string | null };
}

export const FIXTURES: FixtureSpec[] = [
  { file: "traditional.pdf", description: "Traditional single-column CV", expected: { name: "Rahul Sharma", phone: "+919876543210", role: "Java Developer" } },
  { file: "modern.pdf", description: "Modern CV with headline", expected: { name: "Priya Verma", phone: "+919123456780", role: "Data Analyst" } },
  { file: "two-column.pdf", description: "Two-column layout", expected: { name: "Amit Kumar", phone: "+919988776655", role: "Frontend Developer" } },
  { file: "table.pdf", description: "CV with personal-details table", expected: { name: "Sneha Reddy", phone: "+919876501234", role: "HR Executive" } },
  { file: "with-image.pdf", description: "Text CV with embedded photo", expected: { name: "Arjun Patel", phone: "+919845012345", role: "Mechanical Engineer" } },
  { file: "scanned.pdf", description: "Scanned (image-only) PDF → OCR", expected: { name: "Rohan Mehta", phone: "+919000011111", role: "Sales Manager" } },
  { file: "no-phone.pdf", description: "CV without a phone number", expected: { name: "Neha Gupta", phone: null, role: "Content Writer" } },
  { file: "no-role.pdf", description: "CV without an applied role", expected: { name: "Vikram Singh", phone: "+919811223344", role: null } },
  { file: "multi-phone.pdf", description: "Multiple phone numbers (own + alternate + reference)", expected: { name: "Anjali Nair", phone: "+919811122233", role: "Digital Marketing Executive" } },
  { file: "references.pdf", description: "CV with references (other people's names/phones)", expected: { name: "Karan Malhotra", phone: "+919700012345", role: "Civil Engineer" } },
  { file: "image-cv.png", description: "Image CV (PNG) → OCR", expected: { name: "Deepak Joshi", phone: "+919876543211", role: "Accountant" } },
  { file: "image-cv.jpg", description: "Image CV (JPEG) → OCR", expected: { name: "Deepak Joshi", phone: "+919876543211", role: "Accountant" } },
  { file: "image-cv.webp", description: "Image CV (WEBP) → OCR", expected: { name: "Deepak Joshi", phone: "+919876543211", role: "Accountant" } },
  { file: "cv.docx", description: "DOCX CV", expected: { name: "Meera Iyer", phone: "+919988776655", role: "Business Analyst" } },
];

type Line = { text: string; size?: number; bold?: boolean; x?: number; gap?: number };

async function textPdf(blocks: Line[][], opts: { columns?: boolean; imagePng?: Buffer; table?: string[][] } = {}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 800;
  const draw = (l: Line, x: number) => {
    const size = l.size ?? 11;
    page.drawText(l.text, { x, y, size, font: l.bold ? bold : font, color: rgb(0.1, 0.1, 0.1) });
  };
  if (opts.imagePng) {
    const img = await pdf.embedPng(opts.imagePng);
    page.drawImage(img, { x: 470, y: 740, width: 90, height: 90 });
  }
  if (opts.columns) {
    const [left, right] = blocks;
    let ly = y;
    for (const l of left) {
      page.drawText(l.text, { x: 40, y: ly, size: l.size ?? 10, font: l.bold ? bold : font });
      ly -= (l.size ?? 10) + 6;
    }
    let ry = y;
    for (const l of right) {
      page.drawText(l.text, { x: 230, y: ry, size: l.size ?? 11, font: l.bold ? bold : font });
      ry -= (l.size ?? 11) + 7;
    }
    return Buffer.from(await pdf.save());
  }
  for (const block of blocks) {
    for (const l of block) {
      if (y < 60) {
        page = pdf.addPage([595, 842]);
        y = 800;
      }
      draw(l, l.x ?? 50);
      y -= (l.size ?? 11) + (l.gap ?? 6);
    }
    y -= 10;
  }
  if (opts.table) {
    const x0 = 50;
    const colW = [160, 300];
    const rowH = 22;
    for (const row of opts.table) {
      let x = x0;
      row.forEach((cell, i) => {
        page.drawRectangle({ x, y: y - rowH + 6, width: colW[i], height: rowH, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.8 });
        page.drawText(cell, { x: x + 6, y: y - rowH + 12, size: 10, font: i === 0 ? bold : font });
        x += colW[i];
      });
      y -= rowH;
    }
  }
  return Buffer.from(await pdf.save());
}

/** Render a CV as a bitmap (for image / scanned fixtures). */
async function renderImage(lines: Array<{ text: string; size?: number; bold?: boolean }>, format: "png" | "jpeg" | "webp" = "png"): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const W = 1240;
  const H = 1754; // A4 @150dpi
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111111";
  let y = 120;
  for (const l of lines) {
    const size = l.size ?? 30;
    ctx.font = `${l.bold ? "bold " : ""}${size}px Arial, Helvetica, sans-serif`;
    ctx.fillText(l.text, 100, y);
    y += size + 22;
  }
  const png = canvas.toBuffer("image/png");
  if (format === "png") return Buffer.from(png);
  const sharp = (await import("sharp")).default;
  return format === "jpeg" ? sharp(png).jpeg({ quality: 88 }).toBuffer() : sharp(png).webp({ quality: 90 }).toBuffer();
}

async function scannedPdf(image: Buffer): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(image);
  const page = pdf.addPage([595, 842]);
  page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  return Buffer.from(await pdf.save());
}

/** Minimal but valid DOCX (WordprocessingML) built with JSZip (bundled via mammoth). */
async function docx(paragraphs: string[]): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("");
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const EXPERIENCE = [
  { text: "EXPERIENCE", bold: true, size: 12 },
  { text: "Senior Software Engineer, Infosys Ltd, Bengaluru (2021 - Present)" },
  { text: "- Built REST services in Java / Spring Boot; mentored 4 junior engineers." },
  { text: "Software Engineer, Wipro Technologies, Pune (2018 - 2021)" },
  { text: "- Developed microservices and CI pipelines." },
  { text: "EDUCATION", bold: true, size: 12 },
  { text: "B.Tech Computer Science, Visvesvaraya Technological University, 2018" },
  { text: "SKILLS", bold: true, size: 12 },
  { text: "Java, Spring Boot, Microservices, SQL, Docker, AWS" },
];

export async function generateAllFixtures(dir: string): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  const write = async (name: string, data: Buffer) => {
    await fs.writeFile(path.join(dir, name), data);
    written.push(name);
  };

  await write(
    "traditional.pdf",
    await textPdf([
      [
        { text: "RAHUL SHARMA", bold: true, size: 20 },
        { text: "Email: rahul.sharma@example.com | Mobile: +91 98765 43210" },
        { text: "Address: 12 MG Road, Bengaluru, Karnataka 560001" },
        { text: "Applied For: Java Developer", bold: true },
      ],
      [{ text: "CAREER OBJECTIVE", bold: true, size: 12 }, { text: "To work as a Java Developer in a product company where I can apply my backend skills." }],
      EXPERIENCE,
    ]),
  );

  await write(
    "modern.pdf",
    await textPdf([
      [
        { text: "Priya Verma", bold: true, size: 24 },
        { text: "Data Analyst", size: 14 },
        { text: "9123456780  |  priya.verma@example.com  |  Hyderabad" },
      ],
      [
        { text: "PROFILE", bold: true, size: 12 },
        { text: "Data Analyst with 3 years of experience in SQL, Python and Power BI, seeking a Data Analyst position." },
        { text: "EXPERIENCE", bold: true, size: 12 },
        { text: "Data Analyst, Deloitte, Hyderabad (2022 - Present)" },
        { text: "Business Intelligence Intern, ICICI Bank (2021 - 2022)" },
        { text: "EDUCATION", bold: true, size: 12 },
        { text: "B.Sc. Statistics, Osmania University, 2021" },
      ],
    ]),
  );

  await write(
    "two-column.pdf",
    await textPdf(
      [
        [
          { text: "CONTACT", bold: true, size: 11 },
          { text: "Phone: +91-9988776655", size: 9 },
          { text: "Email: amit.kumar@example.com", size: 9 },
          { text: "Location: Noida, UP", size: 9 },
          { text: "SKILLS", bold: true, size: 11 },
          { text: "React, TypeScript, Next.js", size: 9 },
          { text: "HTML, CSS, Tailwind", size: 9 },
          { text: "REST APIs, Git", size: 9 },
        ],
        [
          { text: "AMIT KUMAR", bold: true, size: 22 },
          { text: "OBJECTIVE", bold: true, size: 12 },
          { text: "Seeking a role as Frontend Developer where I can build" },
          { text: "performant web applications with React." },
          { text: "EXPERIENCE", bold: true, size: 12 },
          { text: "UI Developer, Paytm, Noida (2020 - Present)" },
          { text: "Built customer-facing React dashboards." },
          { text: "Web Developer Intern, Zomato (2019)" },
          { text: "EDUCATION", bold: true, size: 12 },
          { text: "B.C.A., Amity University, 2020" },
        ],
      ],
      { columns: true },
    ),
  );

  await write(
    "table.pdf",
    await textPdf(
      [
        [{ text: "CURRICULUM VITAE", bold: true, size: 18 }, { text: "PERSONAL DETAILS", bold: true, size: 12 }],
      ],
      {
        table: [
          ["Name", "Sneha Reddy"],
          ["Mobile", "09876501234"],
          ["Email", "sneha.reddy@example.com"],
          ["Position Applied", "HR Executive"],
          ["Date of Birth", "14/03/1996"],
          ["Languages", "English, Telugu, Hindi"],
        ],
      },
    ),
  );

  const photo = await renderImage([{ text: "PHOTO", size: 40, bold: true }]);
  const sharp = (await import("sharp")).default;
  const smallPhoto = await sharp(photo).resize(200, 200).png().toBuffer();
  await write(
    "with-image.pdf",
    await textPdf(
      [
        [
          { text: "Arjun Patel", bold: true, size: 20 },
          { text: "Contact: +91 98450 12345 | arjun.patel@example.com | Ahmedabad" },
          { text: "Position Applied For: Mechanical Engineer", bold: true },
        ],
        [
          { text: "SUMMARY", bold: true, size: 12 },
          { text: "Mechanical Engineer with 4 years in HVAC design and AutoCAD." },
          { text: "EXPERIENCE", bold: true, size: 12 },
          { text: "Design Engineer, Larsen & Toubro, Vadodara (2020 - Present)" },
        ],
      ],
      { imagePng: smallPhoto },
    ),
  );

  const scannedImg = await renderImage([
    { text: "ROHAN MEHTA", size: 52, bold: true },
    { text: "Mobile: +91 9000011111", size: 32 },
    { text: "Email: rohan.mehta@example.com", size: 32 },
    { text: "Position Applied For: Sales Manager", size: 34, bold: true },
    { text: "", size: 10 },
    { text: "EXPERIENCE", size: 34, bold: true },
    { text: "Area Sales Manager, Hindustan Unilever, Mumbai (2019 - 2024)", size: 28 },
    { text: "Sales Executive, ITC Limited, Nagpur (2016 - 2019)", size: 28 },
    { text: "EDUCATION", size: 34, bold: true },
    { text: "MBA Marketing, Symbiosis Institute, Pune, 2016", size: 28 },
  ]);
  await write("scanned.pdf", await scannedPdf(scannedImg));

  await write(
    "no-phone.pdf",
    await textPdf([
      [
        { text: "Neha Gupta", bold: true, size: 20 },
        { text: "neha.gupta@example.com | Jaipur, Rajasthan" },
        { text: "Applying For: Content Writer", bold: true },
      ],
      [
        { text: "SUMMARY", bold: true, size: 12 },
        { text: "Content writer with 2 years of experience creating blogs, product copy and SEO articles." },
        { text: "EXPERIENCE", bold: true, size: 12 },
        { text: "Content Writer, Byju's, Jaipur (2022 - 2024)" },
      ],
    ]),
  );

  await write(
    "no-role.pdf",
    await textPdf([
      [
        { text: "Vikram Singh", bold: true, size: 20 },
        { text: "Phone: 9811223344 | vikram.singh@example.com | Chandigarh" },
      ],
      [
        { text: "WORK HISTORY", bold: true, size: 12 },
        { text: "Store Supervisor, Reliance Retail (2021 - 2023)" },
        { text: "Delivery Coordinator, Flipkart (2019 - 2021)" },
        { text: "Office Assistant, Punjab National Bank (2017 - 2019)" },
        { text: "EDUCATION", bold: true, size: 12 },
        { text: "B.A., Panjab University, 2017" },
        { text: "HOBBIES", bold: true, size: 12 },
        { text: "Cricket, reading, travelling" },
      ],
    ]),
  );

  await write(
    "multi-phone.pdf",
    await textPdf([
      [
        { text: "ANJALI NAIR", bold: true, size: 20 },
        { text: "Mobile: +91 98111 22233 | Alternate (home): 0484-2345678" },
        { text: "Email: anjali.nair@example.com | Kochi, Kerala" },
        { text: "Resume Headline: Digital Marketing Executive with 3 years of experience", bold: true },
      ],
      [
        { text: "EXPERIENCE", bold: true, size: 12 },
        { text: "Digital Marketing Executive, Muthoot Finance, Kochi (2021 - Present)" },
        { text: "Marketing Intern, Federal Bank (2020)" },
        { text: "REFERENCES", bold: true, size: 12 },
        { text: "Mr. Suresh Menon, Marketing Head, Muthoot Finance - 9899988877" },
        { text: "Ms. Latha Krishnan, Professor, CUSAT - +91 94470 11223" },
      ],
    ]),
  );

  await write(
    "references.pdf",
    await textPdf([
      [
        { text: "Karan Malhotra", bold: true, size: 20 },
        { text: "Contact No.: 97000 12345 | karan.malhotra@example.com | Gurugram" },
        { text: "Job Role: Civil Engineer", bold: true },
      ],
      [
        { text: "EXPERIENCE", bold: true, size: 12 },
        { text: "Site Engineer, DLF Limited, Gurugram (2019 - Present)" },
        { text: "Junior Engineer, NBCC (2017 - 2019)" },
        { text: "REFERENCES", bold: true, size: 12 },
        { text: "1. Mr. Rajesh Khanna, Project Manager, DLF Limited, Mobile: 9810098100" },
        { text: "2. Dr. Pooja Bhatt, HOD Civil Engineering, DTU, Phone: 011-27871018" },
        { text: "DECLARATION", bold: true, size: 12 },
        { text: "I hereby declare that the above information is true to the best of my knowledge. - Karan Malhotra" },
      ],
    ]),
  );

  const imageCvLines = [
    { text: "DEEPAK JOSHI", size: 56, bold: true },
    { text: "Mobile: 9876543211", size: 34 },
    { text: "Email: deepak.joshi@example.com", size: 34 },
    { text: "Applying for: Accountant", size: 36, bold: true },
    { text: "", size: 10 },
    { text: "EXPERIENCE", size: 34, bold: true },
    { text: "Junior Accountant, Tata Motors, Pune (2020 - 2024)", size: 28 },
    { text: "Accounts Trainee, Bajaj Finserv (2019 - 2020)", size: 28 },
    { text: "EDUCATION", size: 34, bold: true },
    { text: "B.Com, University of Pune, 2019", size: 28 },
    { text: "SKILLS", size: 34, bold: true },
    { text: "Tally ERP, GST filing, MS Excel, Bank reconciliation", size: 28 },
  ];
  await write("image-cv.png", await renderImage(imageCvLines, "png"));
  await write("image-cv.jpg", await renderImage(imageCvLines, "jpeg"));
  await write("image-cv.webp", await renderImage(imageCvLines, "webp"));

  await write(
    "cv.docx",
    await docx([
      "Meera Iyer",
      "Phone: +91 99887 76655",
      "Email: meera.iyer@example.com",
      "Chennai, Tamil Nadu",
      "Position Applied: Business Analyst",
      "",
      "SUMMARY",
      "Business Analyst with 5 years of experience in requirement gathering, UAT and stakeholder management.",
      "EXPERIENCE",
      "Business Analyst, Cognizant, Chennai (2021 - Present)",
      "Associate Analyst, TCS, Chennai (2019 - 2021)",
      "EDUCATION",
      "MBA, Loyola Institute of Business Administration, 2019",
    ]),
  );

  return written;
}

const isMain = process.argv[1] && /generate-fixtures\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const dir = path.resolve(process.argv[2] ?? "tests/fixtures/generated");
  generateAllFixtures(dir)
    .then((files) => {
      console.log(`Generated ${files.length} fixtures in ${dir}:`);
      for (const f of files) console.log("  -", f);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
