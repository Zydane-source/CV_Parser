import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Worker } from "bullmq";
import { prisma } from "@/lib/db";
import { redisHealthy, createRedisConnection } from "@/lib/redis";
import { sha256Hex } from "@/lib/crypto";
import { getStorage, buildObjectKey } from "@/services/storage";
import { setLLMProvider } from "@/services/llm";
import { setOCRProvider } from "@/services/ocr";
import { TesseractOCRProvider } from "@/services/ocr/tesseract-provider";
import { enqueueCVFile, reprocessCVFile, retryFailed } from "@/services/processing/enqueue";
import { CV_QUEUE_NAME, getCVQueue, type CVJobData } from "@/services/processing/queue";
import { processCVJob } from "@/services/processing/processor";
import { updateCandidate } from "@/backend/candidates";
import { batchProgress } from "@/backend/jobs";
import { ensureFixtures, fixture, mimeFor } from "../helpers/fixtures";
import { HeuristicLLM, ScriptedLLM } from "../helpers/fake-llm";

/**
 * End-to-end: upload → storage → DB record → queue → worker → pipeline → DB,
 * plus duplicate detection, reprocess (preserving manual corrections), failed
 * retry and live progress. Uses the real Postgres, Redis, storage, text
 * extraction and OCR; the LLM is the deterministic test provider.
 * Skipped when Postgres or Redis is unavailable.
 */
let infra = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  infra = await redisHealthy(2000);
} catch {
  infra = false;
}
const d = infra ? describe : describe.skip;

const TAG = `e2e_${Date.now()}`;
const batchId = `up_${TAG}`;
const ocr = new TesseractOCRProvider(process.env.OCR_CACHE_PATH || "./.tesseract-cache");

async function uploadLike(file: string, name = file) {
  // Mirrors app/api/uploads/route.ts without HTTP.
  const buffer = await fixture(file);
  const hash = sha256Hex(buffer);
  const existing = await prisma.cVFile.findFirst({ where: { fileHash: hash } });
  if (existing) return { duplicate: true, cvFile: existing };
  const key = buildObjectKey(name);
  await getStorage().put(key, buffer, mimeFor(file));
  const cvFile = await prisma.cVFile.create({
    data: { sourceType: "MANUAL", fileName: `${TAG}_${name}`, mimeType: mimeFor(file), fileHash: hash, fileSize: buffer.length, storagePath: key, status: "PENDING" },
  });
  const job = await enqueueCVFile(cvFile, { batchId });
  return { duplicate: false, cvFile, job };
}

async function waitFor(pred: () => Promise<boolean>, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timeout waiting for condition");
}

let worker: Worker<CVJobData> | null = null;

d("end-to-end processing flow", () => {
  beforeAll(async () => {
    await ensureFixtures();
    await prisma.cVFile.deleteMany({ where: { fileName: { startsWith: "e2e_" } } });
    await prisma.cVFile.deleteMany({ where: { fileHash: { in: await Promise.all(["traditional.pdf", "scanned.pdf", "no-phone.pdf", "cv.docx", "image-cv.png"].map(async (f) => sha256Hex(await fixture(f)))) } } });
    setLLMProvider(new HeuristicLLM());
    setOCRProvider(ocr);
    worker = new Worker<CVJobData>(CV_QUEUE_NAME, async (job) => processCVJob(job.data, job.attemptsMade + 1, job.opts.attempts ?? 3), { connection: createRedisConnection(), concurrency: 3 });
  });

  afterAll(async () => {
    await worker?.close();
    await ocr.terminate();
    setLLMProvider(null);
    setOCRProvider(null);
    await prisma.cVFile.deleteMany({ where: { fileName: { startsWith: TAG } } });
    await getCVQueue().close().catch(() => undefined);
    await prisma.$disconnect();
  });

  it("bulk-processes PDF, scanned PDF, DOCX and image CVs through the queue", async () => {
    const files = ["traditional.pdf", "scanned.pdf", "no-phone.pdf", "cv.docx", "image-cv.png"];
    const uploaded = [];
    for (const f of files) uploaded.push(await uploadLike(f));
    expect(uploaded.every((u) => !u.duplicate)).toBe(true);

    await waitFor(async () => (await batchProgress(batchId)).done >= files.length);
    const progress = await batchProgress(batchId);
    expect(progress.total).toBe(files.length);
    expect(progress.failed).toBe(0);

    const rows = await prisma.cVFile.findMany({ where: { fileName: { startsWith: TAG } }, include: { candidate: true, jobs: true } });
    const byName = Object.fromEntries(rows.map((r) => [r.fileName.replace(`${TAG}_`, ""), r]));

    expect(byName["traditional.pdf"].status).toBe("PROCESSED");
    expect(byName["traditional.pdf"].candidate?.candidateName).toBe("Rahul Sharma");
    expect(byName["traditional.pdf"].candidate?.phoneNumber).toBe("+919876543210");
    expect(byName["traditional.pdf"].candidate?.jobRoleAppliedFor).toBe("Java Developer");
    expect(byName["traditional.pdf"].candidate?.extractionMethod).toBe("PDF_TEXT");

    expect(byName["scanned.pdf"].candidate?.extractionMethod).toBe("OCR_PDF");
    expect(byName["scanned.pdf"].candidate?.phoneNumber).toBe("+919000011111");
    expect(byName["image-cv.png"].candidate?.extractionMethod).toBe("OCR_IMAGE");
    expect(byName["image-cv.png"].candidate?.candidateName).toBe("Deepak Joshi");
    expect(byName["cv.docx"].candidate?.extractionMethod).toBe("DOCX");
    expect(byName["cv.docx"].candidate?.jobRoleAppliedFor).toBe("Business Analyst");

    // Missing phone → Not Found + NEEDS_REVIEW (never invented).
    expect(byName["no-phone.pdf"].status).toBe("NEEDS_REVIEW");
    expect(byName["no-phone.pdf"].candidate?.phoneNumber).toBe("Not Found");
    expect(byName["no-phone.pdf"].candidate?.reviewReasons.join(" ")).toMatch(/Phone number not found/);

    for (const r of rows) {
      expect(r.jobs[0].status).toBe(r.status);
      expect(r.jobs[0].completedAt).not.toBeNull();
      expect(r.candidate?.processedAt).not.toBeNull();
    }
  });

  it("detects a duplicate upload by content hash and does not create a second record", async () => {
    const again = await uploadLike("traditional.pdf", "Rahul_copy.pdf");
    expect(again.duplicate).toBe(true);
    expect(again.cvFile.fileName).toBe(`${TAG}_traditional.pdf`);
    expect(await prisma.cVFile.count({ where: { fileHash: again.cvFile.fileHash } })).toBe(1);
  });

  it("reprocess preserves manual corrections", async () => {
    const cv = await prisma.cVFile.findFirstOrThrow({ where: { fileName: `${TAG}_traditional.pdf` } });
    await updateCandidate(cv.id, { jobRoleAppliedFor: "Senior Java Developer" });
    const job = await reprocessCVFile(cv.id, batchId);
    await waitFor(async () => (await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } })).completedAt !== null);
    const c = await prisma.candidate.findUniqueOrThrow({ where: { cvFileId: cv.id } });
    expect(c.jobRoleAppliedFor).toBe("Senior Java Developer"); // not overwritten
    expect(c.isManuallyCorrected).toBe(true);
    expect(c.candidateName).toBe("Rahul Sharma"); // re-extracted
    expect(c.roleConfidence).toBe(1);
    expect(await prisma.processingJob.count({ where: { cvFileId: cv.id } })).toBe(2);
  });

  it("marks permanent failures FAILED, and retry-failed re-queues them", async () => {
    // Permanent LLM failure (e.g. bad API key) → FAILED without endless retries.
    const { ProcessingError } = await import("@/lib/errors");
    setLLMProvider(new ScriptedLLM([new ProcessingError("LLM API key rejected", "LLM_AUTH", false)]));
    const up = await uploadLike("modern.pdf");
    expect(up.duplicate).toBe(false);
    const cvId = up.cvFile.id;
    await waitFor(async () => (await prisma.cVFile.findUniqueOrThrow({ where: { id: cvId } })).status === "FAILED");
    const failedJob = await prisma.processingJob.findFirstOrThrow({ where: { cvFileId: cvId } });
    expect(failedJob.errorCode).toBe("LLM_AUTH");
    expect(failedJob.attempts).toBe(1);
    expect(failedJob.errorMessage).toMatch(/API key rejected/);

    // Fix the "LLM" and retry all failed.
    setLLMProvider(new HeuristicLLM());
    const n = await retryFailed(batchId);
    expect(n).toBeGreaterThanOrEqual(1);
    // modern.pdf only has a headline role (inferred, confidence 0.7) → NEEDS_REVIEW is the correct terminal state.
    await waitFor(async () => ["PROCESSED", "NEEDS_REVIEW"].includes((await prisma.cVFile.findUniqueOrThrow({ where: { id: cvId } })).status));
    const c = await prisma.candidate.findUniqueOrThrow({ where: { cvFileId: cvId } });
    expect(c.candidateName).toBe("Priya Verma");
    expect(c.phoneNumber).toBe("+919123456780");
    expect(await prisma.processingJob.count({ where: { cvFileId: cvId } })).toBe(2);
  });

  it("retries transient failures automatically with backoff", async () => {
    const { ProcessingError } = await import("@/lib/errors");
    setLLMProvider(new ScriptedLLM([new ProcessingError("rate limit", "LLM_TRANSIENT", true), { candidate_name: "Sneha Reddy", phone_number: "09876501234", job_role_applied_for: "HR Executive", confidence: { candidate_name: 0.95, phone_number: 0.95, job_role_applied_for: 0.95 } }]));
    const up = await uploadLike("table.pdf");
    const cvId = up.cvFile.id;
    await waitFor(async () => (await prisma.cVFile.findUniqueOrThrow({ where: { id: cvId } })).status === "PROCESSED", 60_000);
    const job = await prisma.processingJob.findFirstOrThrow({ where: { cvFileId: cvId } });
    expect(job.attempts).toBe(2);
    expect(job.status).toBe("PROCESSED");
    const c = await prisma.candidate.findUniqueOrThrow({ where: { cvFileId: cvId } });
    expect(c.phoneNumber).toBe("+919876501234");
    setLLMProvider(new HeuristicLLM());
  });
});
