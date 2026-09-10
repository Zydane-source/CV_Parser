/**
 * Verifies the pre-LLM pipeline stages (storage load -> text extraction -> OCR
 * fallback -> normalisation) against the CVs already stored in the database.
 * Prints only metrics and structural signals, never candidate text/PII.
 *
 *   npx tsx scripts/check-extraction.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { getStorage } from "../services/storage";
import { extractDocumentText, countMeaningfulChars, isImageMime, PDF_MIME } from "../services/text-extraction";
import { getOCRProvider, shutdownOCR } from "../services/ocr";
import { normalizeText } from "../services/cv-parser/normalize";
import { findPhoneCandidates } from "../services/cv-parser/phone";

const prisma = new PrismaClient();

async function main() {
  const files = await prisma.cVFile.findMany({
    where: { sourceType: "MANUAL", storagePath: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, mimeType: true, storagePath: true, status: true },
  });
  console.log(`Checking ${files.length} stored CVs (pre-LLM stages only)\n`);

  for (const f of files) {
    try {
      const buf = await getStorage().get(f.storagePath!);
      const ext = await extractDocumentText(buf, f.mimeType, { minTextChars: Number(process.env.OCR_MIN_TEXT_CHARS ?? 150) });
      let text = ext.text;
      let method: string = ext.method;
      let ocrConf: number | undefined;

      if (ext.needsOcr && (isImageMime(f.mimeType) || f.mimeType === PDF_MIME)) {
        const ocr = getOCRProvider();
        const opts = { languages: process.env.OCR_LANGUAGES || "eng", maxPages: Number(process.env.OCR_MAX_PAGES ?? 5) };
        const r = isImageMime(f.mimeType) ? await ocr.extractFromImage(buf, f.mimeType, opts) : await ocr.extractFromScannedPDF(buf, opts);
        ocrConf = r.confidence;
        if (countMeaningfulChars(r.text) > countMeaningfulChars(text) * 1.2) {
          text = r.text;
          method = isImageMime(f.mimeType) ? "OCR_IMAGE" : "OCR_PDF";
        }
      }

      const norm = normalizeText(text, Number(process.env.MAX_CV_TEXT_CHARS ?? 20000));
      const chars = countMeaningfulChars(norm);
      // Structural signals only – proves the text is real without printing it.
      const phones = findPhoneCandidates(norm).length;
      const hasRoleCue = /(applied\s*for|position\s*applied|job\s*role|applying\s*for|career\s*objective|resume\s*headline|objective|summary)/i.test(norm);
      const ready = chars >= 20;

      console.log(
        `${ready ? "OK  " : "FAIL"} ${f.fileName.padEnd(32).slice(0, 32)} method=${method.padEnd(9)} pages=${ext.pageCount} chars=${String(chars).padStart(5)} phoneCandidates=${phones} roleCue=${hasRoleCue ? "yes" : "no "}${ocrConf !== undefined ? ` ocrConf=${ocrConf.toFixed(2)}` : ""}`,
      );
      if (!ready) console.log(`     -> would fail with NO_TEXT (blank/corrupt/unreadable scan)`);
    } catch (err) {
      console.log(`FAIL ${f.fileName} -> ${(err as Error).message}`);
    }
  }
  console.log("\nAll stages above run without the LLM. Only the LLM extraction step needs LLM_API_KEY.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await shutdownOCR().catch(() => undefined);
    await prisma.$disconnect();
  });
