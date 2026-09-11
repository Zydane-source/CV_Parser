/**
 * Scores an extraction engine against the labelled benchmark corpus.
 *
 *   npm run benchmark              # local engine
 *   npm run benchmark -- --engine=legacy   # the LLM, for comparison
 *   npm run benchmark -- --limit=30        # quick pass
 *
 * Reports per-field precision/recall/F1, accuracy sliced by trait, latency
 * percentiles and memory, and writes machine-readable results next to the corpus
 * so two runs can be diffed.
 *
 * A field whose ground truth is `null` is scored on whether the engine correctly
 * answered "Not Found" — inventing a value there is a false positive, which is
 * the failure mode that matters most for candidate data.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { extractDocumentText, isImageMime, PDF_MIME, countMeaningfulChars } from "../services/text-extraction";
import { getOCRProvider, shutdownOCR } from "../services/ocr";
import { normalizeText } from "../services/cv-parser/normalize";
import { extractLocally } from "../services/cv-engine";
import { getTaxonomy } from "../services/cv-engine/taxonomy";
import { validateExtraction } from "../services/cv-parser/validate";
import { extractWithLLM } from "../services/llm";
import type { CorpusEntry } from "./generate-benchmark-corpus";

type Engine = "local" | "legacy";

interface FieldScore {
  /** Ground truth present, engine right. */
  truePositive: number;
  /** Ground truth present, engine produced a different value. */
  wrongValue: number;
  /** Ground truth present, engine said Not Found. */
  falseNegative: number;
  /** Ground truth absent, engine invented a value. */
  falsePositive: number;
  /** Ground truth absent, engine correctly said Not Found. */
  trueNegative: number;
}

const emptyScore = (): FieldScore => ({ truePositive: 0, wrongValue: 0, falseNegative: 0, falsePositive: 0, trueNegative: 0 });

const NOT_FOUND = "not found";
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Role comparison is taxonomy-aware for BOTH engines.
 *
 * The LLM has no role taxonomy, so it answers "Back End Developer" or "ML
 * Engineer" where the ground truth is canonicalised. Marking those wrong would
 * measure spelling, not comprehension, and would flatter the local engine for a
 * capability the comparison is not about. Both sides are therefore resolved
 * through the same taxonomy before comparing.
 */
function rolesMatch(expected: string, actual: string): boolean {
  const a = norm(actual), e = norm(expected);
  if (a === e || a.endsWith(e) || a.includes(e)) return true;
  const tax = getTaxonomy();
  const ma = tax.match(actual);
  const me = tax.match(expected);
  return Boolean(ma && me && norm(ma.canonical) === norm(me.canonical));
}

function scoreField(kind: "name" | "phone" | "role", expected: string | null, actual: string): keyof FieldScore {
  const isNotFound = norm(actual) === NOT_FOUND || !actual;
  if (expected === null) return isNotFound ? "trueNegative" : "falsePositive";
  if (isNotFound) return "falseNegative";
  if (kind === "phone") return digits(actual).endsWith(digits(expected).slice(-10)) ? "truePositive" : "wrongValue";
  if (kind === "role") return rolesMatch(expected, actual) ? "truePositive" : "wrongValue";
  return norm(actual) === norm(expected) ? "truePositive" : "wrongValue";
}

/** Precision/recall/F1 over "produced a correct value when one existed". */
function prf(s: FieldScore) {
  const produced = s.truePositive + s.wrongValue + s.falsePositive;
  const shouldHave = s.truePositive + s.wrongValue + s.falseNegative;
  const precision = produced ? s.truePositive / produced : 1;
  const recall = shouldHave ? s.truePositive / shouldHave : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const total = shouldHave + s.trueNegative + s.falsePositive - (s.falsePositive ? 0 : 0);
  const correct = s.truePositive + s.trueNegative;
  const accuracy = total ? correct / (s.truePositive + s.wrongValue + s.falseNegative + s.trueNegative + s.falsePositive) : 0;
  return { precision, recall, f1, accuracy };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

interface PerCv {
  file: string;
  traits: string[];
  ok: { name: boolean; phone: boolean; role: boolean };
  totalMs: number;
  textMs: number;
  ocrMs: number;
  extractMs: number;
  ocrUsed: boolean;
  failed?: string;
  got: { name: string; phone: string; role: string };
  want: { name: string | null; phone: string | null; role: string | null };
  confidence: { name: number; phone: number; role: number };
  needsReview: boolean;
}

async function main() {
  const args = process.argv.slice(2);
  const engine: Engine = (args.find((a) => a.startsWith("--engine="))?.split("=")[1] as Engine) ?? "local";
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0");
  const corpusDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? "tests/fixtures/benchmark");

  const gt = JSON.parse(await fs.readFile(path.join(corpusDir, "ground-truth.json"), "utf8")) as { entries: CorpusEntry[] };
  const entries = limit ? gt.entries.slice(0, limit) : gt.entries;

  console.log(`\nBenchmark: engine=${engine}  corpus=${entries.length} CVs  dir=${path.basename(corpusDir)}\n`);

  const scores = { name: emptyScore(), phone: emptyScore(), role: emptyScore() };
  const rows: PerCv[] = [];
  const rssStart = process.memoryUsage().rss;
  let peakRss = rssStart;
  const ocr = getOCRProvider();

  for (const entry of entries) {
    const buf = await fs.readFile(path.join(corpusDir, entry.file));
    const mime = mimeOf(entry.file);
    const t0 = performance.now();
    let textMs = 0, ocrMs = 0, extractMs = 0, ocrUsed = false;

    try {
      const tText0 = performance.now();
      const ext = await extractDocumentText(buf, mime, { minTextChars: 150 });
      textMs = performance.now() - tText0;

      let text = ext.text;
      let ocrConfidence: number | undefined;
      if (ext.needsOcr && (isImageMime(mime) || mime === PDF_MIME)) {
        const tOcr0 = performance.now();
        const r = isImageMime(mime)
          ? await ocr.extractFromImage(buf, mime, { languages: "eng", maxPages: 3 })
          : await ocr.extractFromScannedPDF(buf, { languages: "eng", maxPages: 3 });
        ocrMs = performance.now() - tOcr0;
        ocrUsed = true;
        ocrConfidence = r.confidence;
        if (countMeaningfulChars(r.text) > countMeaningfulChars(text) * 1.2) text = r.text;
      }

      const normalized = normalizeText(text, 20000);
      const tEx0 = performance.now();
      const raw =
        engine === "local"
          ? extractLocally(normalized, { fileName: entry.file, ocrConfidence })
          : (await extractWithLLM({ cvText: normalized, model: process.env.LLM_MODEL || "gpt-4o-mini", temperature: 0, timeoutMs: 60000, promptVersion: "v1" })).extraction;
      extractMs = performance.now() - tEx0;

      const validated = validateExtraction(raw, { threshold: 0.75, cvText: normalized });
      const got = { name: validated.candidateName, phone: validated.phoneNumber, role: validated.jobRoleAppliedFor };

      const nk = scoreField("name", entry.expected.name, got.name);
      const pk = scoreField("phone", entry.expected.phone, got.phone);
      const rk = scoreField("role", entry.expected.role, got.role);
      scores.name[nk]++; scores.phone[pk]++; scores.role[rk]++;

      rows.push({
        file: entry.file,
        traits: entry.traits,
        ok: { name: nk === "truePositive" || nk === "trueNegative", phone: pk === "truePositive" || pk === "trueNegative", role: rk === "truePositive" || rk === "trueNegative" },
        totalMs: performance.now() - t0,
        textMs, ocrMs, extractMs, ocrUsed,
        got, want: entry.expected,
        confidence: { name: validated.nameConfidence, phone: validated.phoneConfidence, role: validated.roleConfidence },
        needsReview: validated.needsReview,
      });
    } catch (err) {
      scores.name.falseNegative++; scores.phone.falseNegative++; scores.role.falseNegative++;
      rows.push({
        file: entry.file, traits: entry.traits,
        ok: { name: false, phone: false, role: false },
        totalMs: performance.now() - t0, textMs, ocrMs, extractMs, ocrUsed,
        failed: err instanceof Error ? err.message.slice(0, 120) : String(err),
        got: { name: "", phone: "", role: "" }, want: entry.expected,
        confidence: { name: 0, phone: 0, role: 0 }, needsReview: true,
      });
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }

  await shutdownOCR().catch(() => undefined);

  // ── Accuracy ──────────────────────────────────────────────────────────────
  console.log("FIELD ACCURACY");
  console.log("  field   accuracy  precision  recall     F1     correct/total   wrong  missed  invented");
  const summary: Record<string, ReturnType<typeof prf>> = {};
  for (const [field, s] of Object.entries(scores) as Array<["name" | "phone" | "role", FieldScore]>) {
    const m = prf(s);
    summary[field] = m;
    const total = s.truePositive + s.wrongValue + s.falseNegative + s.trueNegative + s.falsePositive;
    console.log(
      `  ${field.padEnd(6)}  ${pct(m.accuracy).padStart(7)}  ${pct(m.precision).padStart(8)}  ${pct(m.recall).padStart(7)}  ${pct(m.f1).padStart(6)}   ${String(s.truePositive + s.trueNegative).padStart(3)}/${String(total).padEnd(3)}       ${String(s.wrongValue).padStart(3)}    ${String(s.falseNegative).padStart(3)}     ${String(s.falsePositive).padStart(3)}`,
    );
  }

  const allThree = rows.filter((r) => r.ok.name && r.ok.phone && r.ok.role).length;
  console.log(`\n  all three fields correct: ${allThree}/${rows.length} (${pct(allThree / rows.length)})`);
  console.log(`  flagged for human review: ${rows.filter((r) => r.needsReview).length}/${rows.length}`);
  console.log(`  hard failures:            ${rows.filter((r) => r.failed).length}`);

  // ── Accuracy by trait ─────────────────────────────────────────────────────
  console.log("\nACCURACY BY TRAIT (all three fields correct)");
  const traitSet = [...new Set(rows.flatMap((r) => r.traits))].sort();
  for (const trait of traitSet) {
    const subset = rows.filter((r) => r.traits.includes(trait));
    if (subset.length < 3) continue;
    const ok = subset.filter((r) => r.ok.name && r.ok.phone && r.ok.role).length;
    const bar = "█".repeat(Math.round((ok / subset.length) * 20)).padEnd(20, "·");
    console.log(`  ${trait.padEnd(28)} ${bar} ${String(ok).padStart(3)}/${String(subset.length).padEnd(3)} ${pct(ok / subset.length)}`);
  }

  // ── Performance ───────────────────────────────────────────────────────────
  const totals = rows.map((r) => r.totalMs).sort((a, b) => a - b);
  const extracts = rows.map((r) => r.extractMs).sort((a, b) => a - b);
  const ocrRows = rows.filter((r) => r.ocrUsed);
  console.log("\nPERFORMANCE (ms per CV)");
  console.log(`  end-to-end   mean ${mean(totals).toFixed(1)}   p50 ${percentile(totals, 50).toFixed(1)}   p95 ${percentile(totals, 95).toFixed(1)}   p99 ${percentile(totals, 99).toFixed(1)}   max ${Math.max(...totals).toFixed(1)}`);
  console.log(`  extraction   mean ${mean(extracts).toFixed(1)}   p50 ${percentile(extracts, 50).toFixed(1)}   p95 ${percentile(extracts, 95).toFixed(1)}   p99 ${percentile(extracts, 99).toFixed(1)}   max ${Math.max(...extracts).toFixed(1)}`);
  console.log(`  text layer   mean ${mean(rows.map((r) => r.textMs)).toFixed(1)}`);
  if (ocrRows.length) console.log(`  OCR          mean ${mean(ocrRows.map((r) => r.ocrMs)).toFixed(1)}  over ${ocrRows.length} CVs`);
  console.log(`  peak RSS     ${(peakRss / 1024 / 1024).toFixed(0)} MB  (start ${(rssStart / 1024 / 1024).toFixed(0)} MB)`);

  // ── Failures worth reading ────────────────────────────────────────────────
  const misses = rows.filter((r) => !r.ok.name || !r.ok.phone || !r.ok.role).slice(0, 15);
  if (misses.length) {
    console.log("\nSAMPLE MISSES (first 15)");
    for (const m of misses) {
      const bad = [!m.ok.name && "name", !m.ok.phone && "phone", !m.ok.role && "role"].filter(Boolean).join(",");
      console.log(`  ${m.file.slice(0, 42).padEnd(44)} [${bad}]`);
      if (!m.ok.name) console.log(`      name  want=${JSON.stringify(m.want.name)} got=${JSON.stringify(m.got.name)}`);
      if (!m.ok.phone) console.log(`      phone want=${JSON.stringify(m.want.phone)} got=${JSON.stringify(m.got.phone)}`);
      if (!m.ok.role) console.log(`      role  want=${JSON.stringify(m.want.role)} got=${JSON.stringify(m.got.role)}`);
      if (m.failed) console.log(`      FAILED: ${m.failed}`);
    }
  }

  const out = path.join(corpusDir, `results-${engine}.json`);
  await fs.writeFile(out, JSON.stringify({ engine, at: new Date().toISOString(), summary, allThree, count: rows.length, rows }, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), out)}\n`);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".doc": "application/msword", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[ext] ?? "application/octet-stream";
}

main().catch((e) => { console.error(e); process.exit(1); });
