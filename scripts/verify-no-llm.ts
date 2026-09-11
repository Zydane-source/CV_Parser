/**
 * Acceptance check for the LLM -> local migration.
 *
 * The migration's whole claim is that CV extraction no longer depends on any
 * hosted model. Asserting that in a unit test is weak, because a test can stub
 * the very seam it is meant to be testing. This script proves it against the
 * real production path instead:
 *
 *   1. every LLM-shaped environment variable is deleted before a single
 *      application module is imported, so nothing can read one even by accident;
 *   2. global fetch is wrapped so a request to any known model-provider host
 *      throws — if some forgotten code path still reached for one, the run fails
 *      loudly instead of quietly succeeding;
 *   3. a real CVFile row is created, real bytes are written to storage, and the
 *      real worker entry point (`processCVJob`) runs it end to end into Postgres.
 *
 * Run:  npm run verify:no-llm  [--keep] [path/to/cv.pdf]
 */
import "dotenv/config";
import path from "node:path";
import { promises as fs } from "node:fs";

// ---------------------------------------------------------------------------
// 1. Scrub the environment, before any application import.
// ---------------------------------------------------------------------------
const LLM_ENV =
  /^(LLM_|OPENAI|ANTHROPIC|GEMINI|GOOGLE_GENERATIVE|GOOGLE_GENAI|OPENROUTER|AI_GATEWAY|VERCEL_AI|MISTRAL|GROQ|COHERE|TOGETHER|AZURE_OPENAI|HUGGINGFACE|REPLICATE|PERPLEXITY)/i;
const scrubbed = Object.keys(process.env).filter((k) => LLM_ENV.test(k));
for (const k of scrubbed) delete process.env[k];
// Unset the engine selector too: the default must already be the local engine.
delete process.env.EXTRACTION_ENGINE;

// ---------------------------------------------------------------------------
// 2. Make any call to a model provider fatal.
// ---------------------------------------------------------------------------
const MODEL_HOSTS =
  /(openai|anthropic|openrouter|generativelanguage|mistral|groq|cohere|together\.xyz|perplexity|huggingface|replicate)/i;
let blockedCall: string | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (MODEL_HOSTS.test(url)) {
    blockedCall = url;
    throw new Error(`LLM call attempted during a no-LLM run: ${url}`);
  }
  return realFetch(input, init);
}) as typeof fetch;

const keep = process.argv.includes("--keep");
const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));

const ok = (label: string, detail = "") => console.log(`  ok   ${label}${detail ? `  ${detail}` : ""}`);
/**
 * Throws rather than exiting, so the caller's cleanup still runs. An early
 * `process.exit` here would leave the CVFile row behind, and the next run would
 * then trip the duplicate-content guard instead of testing anything.
 */
function fail(label: string, detail = ""): never {
  throw new Error(`${label}${detail ? `  ${detail}` : ""}`);
}
/** Phone numbers are candidate data; show only enough to confirm extraction worked. */
const maskPhone = (p: string) => p.replace(/\d(?=\d{4})/g, "*");

async function main() {
  console.log("\nAcceptance: CV extraction with no LLM configuration at all\n");
  console.log(`  scrubbed ${scrubbed.length} LLM environment variable(s): ${scrubbed.join(", ") || "(none were set)"}`);

  // Imported only now, so they observe the scrubbed environment. Configuration
  // is resolved immediately, before anything else loads, because
  // `@prisma/client` auto-loads `.env` from the working directory when it is
  // imported and will happily put the variables back. `env()` memoises on first
  // call, so reading it here pins the scrubbed view for the rest of the run.
  const { env } = await import("@/lib/config");
  const e = env();

  const { prisma } = await import("@/lib/db");
  // Prisma has now re-read `.env`. Scrub again so the *runtime* environment is
  // clean too, not only the configuration snapshot.
  for (const k of Object.keys(process.env)) if (LLM_ENV.test(k)) delete process.env[k];

  const { getStorage, buildObjectKey } = await import("@/services/storage");
  const { processCVJob } = await import("@/services/processing/processor");
  const { sha256Hex } = await import("@/lib/crypto");

  // --- configuration ------------------------------------------------------
  if (e.EXTRACTION_ENGINE !== "local") fail("default engine is not local", e.EXTRACTION_ENGINE);
  ok("EXTRACTION_ENGINE defaults to", '"local"');
  if (e.LLM_API_KEY) fail("an LLM API key is still present in the environment");
  ok("no LLM API key present");

  // --- input --------------------------------------------------------------
  let source = fileArg;
  if (!source) {
    const dir = path.resolve("tests/fixtures/generated");
    source = path.join(dir, "modern.pdf");
    const exists = await fs.access(source).then(() => true).catch(() => false);
    if (!exists) {
      const { generateAllFixtures } = await import("@/scripts/generate-fixtures");
      await generateAllFixtures(dir);
    }
  }
  const buffer = await fs.readFile(source);
  const fileName = path.basename(source);
  ok("input CV", `${fileName} (${buffer.length} bytes)`);

  // --- set up exactly the rows an upload would create ---------------------
  const key = buildObjectKey(fileName);
  await getStorage().put(key, buffer, "application/pdf");
  const cvFile = await prisma.cVFile.create({
    data: {
      sourceType: "MANUAL",
      fileName,
      mimeType: "application/pdf",
      fileHash: sha256Hex(buffer),
      fileSize: buffer.length,
      storagePath: key,
      status: "PENDING",
    },
  });
  const job = await prisma.processingJob.create({ data: { cvFileId: cvFile.id, status: "PENDING" } });

  try {
    await runAndAssert();
  } finally {
    if (keep) {
      console.log(`\n  kept CVFile ${cvFile.id} for inspection\n`);
    } else {
      await prisma.cVFile.delete({ where: { id: cvFile.id } }).catch(() => {});
      await getStorage().delete(key).catch(() => {});
      console.log("\n  cleaned up\n");
    }
    await prisma.$disconnect();
  }
  console.log("PASS  the extraction pipeline runs with no LLM configuration.\n");

  // --- the real worker path ------------------------------------------------
  async function runAndAssert() {
    const started = Date.now();
    await processCVJob({ processingJobId: job.id, cvFileId: cvFile.id }, 1, 3);
    const elapsed = Date.now() - started;

    const candidate = await prisma.candidate.findUnique({ where: { cvFileId: cvFile.id } });
    const finished = await prisma.processingJob.findUnique({ where: { id: job.id } });

    if (blockedCall) fail("a model provider was contacted", blockedCall);
    ok("no model provider was contacted");
    if (!candidate) fail("no candidate row was written");
    if (finished?.status !== "PROCESSED" && finished?.status !== "NEEDS_REVIEW") {
      fail("job did not complete", `${finished?.status} ${finished?.errorMessage ?? ""}`);
    }
    ok("job status", finished.status);
    if (candidate.extractionEngine !== "local") fail("result was not produced by the local engine");
    ok("stored by engine", `${candidate.extractionEngine} v${candidate.extractionVersion}`);
    ok("candidate name", `${candidate.candidateName}  (conf ${candidate.nameConfidence})`);
    ok("phone number", `${maskPhone(candidate.phoneNumber)}  (conf ${candidate.phoneConfidence})`);
    ok("job role", `${candidate.jobRoleAppliedFor}  (conf ${candidate.roleConfidence})`);
    ok("field extraction", `${candidate.extractionMs} ms`);
    ok("end to end", `${elapsed} ms`);
    if (candidate.llmModel) fail("an LLM model was recorded on the row", candidate.llmModel);
    ok("no LLM model recorded on the row");
  }
}

main().catch((err) => {
  console.error("\nFAIL", err);
  process.exit(1);
});
