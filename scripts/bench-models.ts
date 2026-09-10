/**
 * Benchmarks candidate LLM models against the real extraction prompt and the
 * generated CV fixtures, so the configured model is chosen from measured
 * accuracy rather than guesswork.
 *
 *   npx tsx scripts/bench-models.ts "model-a,model-b"
 */
import "dotenv/config";
import { extractDocumentText } from "../services/text-extraction";
import { normalizeText } from "../services/cv-parser/normalize";
import { validateExtraction } from "../services/cv-parser/validate";
import { OpenAICompatibleProvider } from "../services/llm/openai-provider";
import { extractWithLLM } from "../services/llm";
import { generateAllFixtures, FIXTURES } from "./generate-fixtures";
import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = path.resolve("tests/fixtures/generated");
// Text-layer PDFs only: this measures the model, not OCR.
const CASES = ["traditional.pdf", "modern.pdf", "two-column.pdf", "table.pdf", "multi-phone.pdf", "no-phone.pdf", "no-role.pdf", "references.pdf"];

async function cvText(file: string): Promise<string> {
  const buf = await fs.readFile(path.join(DIR, file));
  const ext = await extractDocumentText(buf, "application/pdf", { minTextChars: 150 });
  return normalizeText(ext.text, 20000);
}

function expectedFor(file: string) {
  return FIXTURES.find((f) => f.file === file)!.expected;
}

async function benchModel(model: string, texts: Map<string, string>) {
  const provider = new OpenAICompatibleProvider(process.env.LLM_API_KEY!, process.env.LLM_BASE_URL || undefined);
  let name = 0;
  let phone = 0;
  let role = 0;
  let errors = 0;
  let ms = 0;

  for (const file of CASES) {
    const exp = expectedFor(file);
    const started = Date.now();
    try {
      const res = await extractWithLLM({
        cvText: texts.get(file)!,
        model,
        temperature: 0,
        timeoutMs: 90_000,
        promptVersion: "v1",
        provider,
      });
      ms += Date.now() - started;
      const v = validateExtraction(res.extraction, { threshold: 0.75, cvText: texts.get(file)! });
      if (exp.name && v.candidateName.toLowerCase() === exp.name.toLowerCase()) name++;
      if (exp.phone === null ? v.phoneNumber === "Not Found" : v.phoneNumber === exp.phone) phone++;
      if (exp.role === null ? v.jobRoleAppliedFor === "Not Found" : v.jobRoleAppliedFor.toLowerCase() === exp.role.toLowerCase()) role++;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    ! ${file}: ${msg.slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 1200)); // stay under free-tier rate limits
  }

  const n = CASES.length;
  const total = name + phone + role;
  console.log(
    `  ${model.padEnd(46)} name ${name}/${n}  phone ${phone}/${n}  role ${role}/${n}  => ${total}/${n * 3}  errors=${errors}  avg=${Math.round(ms / Math.max(1, n - errors))}ms`,
  );
  return { model, score: total, errors, avgMs: ms / Math.max(1, n - errors) };
}

async function main() {
  await generateAllFixtures(DIR).catch(() => undefined);
  const models = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!models.length) {
    console.error('Usage: npx tsx scripts/bench-models.ts "model-a,model-b"');
    process.exit(1);
  }
  const texts = new Map<string, string>();
  for (const f of CASES) texts.set(f, await cvText(f));

  console.log(`Benchmarking ${models.length} model(s) over ${CASES.length} CVs (3 fields each)\n`);
  const results = [];
  for (const m of models) results.push(await benchModel(m, texts));

  results.sort((a, b) => b.score - a.score || a.avgMs - b.avgMs);
  console.log(`\nBest: ${results[0].model} (${results[0].score}/${CASES.length * 3})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
