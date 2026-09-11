import { UnrecoverableError } from "bullmq";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sha256Hex } from "@/lib/crypto";
import { errorMessage, isTransientError, AppError } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { env } from "@/lib/config";
import { getStorage } from "@/services/storage";
import { parseCV, type PipelineStage } from "@/services/cv-parser/pipeline";
import { getLLMProvider } from "@/services/llm";
import { downloadDriveFile } from "@/services/google-drive/files";
import type { CVJobData } from "./queue";

/**
 * Worker-side job processor: loads the file bytes (object storage or Google
 * Drive), runs the unified pipeline, and persists the result.
 *
 * Retry semantics: transient errors are re-thrown so BullMQ retries with
 * exponential backoff; permanent errors throw UnrecoverableError so the job
 * fails immediately. One failed CV never affects other CVs.
 */
export async function processCVJob(data: CVJobData, attempt: number, maxAttempts: number): Promise<void> {
  const job = await prisma.processingJob.findUnique({
    where: { id: data.processingJobId },
    include: { cvFile: { include: { candidate: true } } },
  });
  if (!job) throw new UnrecoverableError(`Processing job ${data.processingJobId} not found`);
  const cvFile = job.cvFile;
  const log = logger.child({ cvFileId: cvFile.id, jobId: job.id, attempt });

  const setStage = async (stage: PipelineStage | "LOADING_FILE" | "PERSISTING") => {
    await prisma.processingJob.update({ where: { id: job.id }, data: { stage } });
  };

  await prisma.$transaction([
    prisma.processingJob.update({
      where: { id: job.id },
      data: { status: "PROCESSING", attempts: attempt, startedAt: new Date(), stage: "LOADING_FILE", errorMessage: null, errorCode: null },
    }),
    prisma.cVFile.update({ where: { id: cvFile.id }, data: { status: "PROCESSING", statusMessage: null } }),
  ]);

  try {
    const settings = await getSettings();
    // Fail fast (before downloading / OCR) only when an LLM will actually be
    // called. The local engine needs no credentials.
    if (env().EXTRACTION_ENGINE !== "local") getLLMProvider();

    // 1. Load bytes
    let buffer: Buffer;
    if (cvFile.sourceType === "MANUAL") {
      if (!cvFile.storagePath) throw new AppError("Manual upload has no storage path", { code: "NO_STORAGE_PATH" });
      buffer = await getStorage().get(cvFile.storagePath);
    } else {
      if (!cvFile.sourceFileId) throw new AppError("Drive file has no source file id", { code: "NO_SOURCE_ID" });
      buffer = await downloadDriveFile(cvFile.driveConnectionId, cvFile.sourceFileId);
    }

    // 2. Content hash + cross-source duplicate detection (Drive files only – manual
    //    uploads are checked at upload time and are never auto-duplicated).
    const hash = sha256Hex(buffer);
    if (hash !== cvFile.fileHash) {
      await prisma.cVFile.update({ where: { id: cvFile.id }, data: { fileHash: hash, fileSize: buffer.length } });
    }
    if (cvFile.sourceType === "GOOGLE_DRIVE" && !data.reprocess) {
      const dup = await prisma.cVFile.findFirst({
        where: { fileHash: hash, id: { not: cvFile.id }, candidate: { isNot: null } },
        select: { id: true, fileName: true },
      });
      if (dup) {
        const msg = `Duplicate content of "${dup.fileName}" (${dup.id}) – skipped`;
        await prisma.$transaction([
          prisma.processingJob.update({ where: { id: job.id }, data: { status: "SKIPPED", stage: null, completedAt: new Date(), errorMessage: msg, errorCode: "DUPLICATE" } }),
          prisma.cVFile.update({ where: { id: cvFile.id }, data: { status: "SKIPPED", statusMessage: msg } }),
        ]);
        log.info({ duplicateOf: dup.id }, "Skipped duplicate Drive file");
        return;
      }
    }

    // 3. Pipeline
    const result = await parseCV(buffer, cvFile.mimeType, {
      ocrMinTextChars: settings.ocrMinTextChars,
      ocrMaxPages: settings.ocrMaxPages,
      ocrLanguages: settings.ocrLanguages,
      maxCvTextChars: settings.maxCvTextChars,
      confidenceThreshold: settings.confidenceThreshold,
      llmModel: settings.llmModel,
      llmTemperature: settings.llmTemperature,
      llmTimeoutMs: settings.llmTimeoutMs,
      promptVersion: settings.llmPromptVersion,
      fileName: cvFile.fileName,
      onStage: setStage,
    });

    // 4. Persist – never overwrite manually corrected fields.
    await setStage("PERSISTING");
    const existing = cvFile.candidate;
    const corrected = new Set(existing?.correctedFields ?? []);
    const candidateData: Prisma.CandidateUncheckedCreateInput = {
      cvFileId: cvFile.id,
      candidateName: corrected.has("candidateName") ? existing!.candidateName : result.candidateName,
      phoneNumber: corrected.has("phoneNumber") ? existing!.phoneNumber : result.phoneNumber,
      jobRoleAppliedFor: corrected.has("jobRoleAppliedFor") ? existing!.jobRoleAppliedFor : result.jobRoleAppliedFor,
      nameConfidence: corrected.has("candidateName") ? 1 : result.nameConfidence,
      phoneConfidence: corrected.has("phoneNumber") ? 1 : result.phoneConfidence,
      roleConfidence: corrected.has("jobRoleAppliedFor") ? 1 : result.roleConfidence,
      overallConfidence: result.overallConfidence,
      isManuallyCorrected: corrected.size > 0,
      correctedFields: [...corrected],
      reviewReasons: result.reviewReasons,
      extractionMethod: result.extractionMethod,
      llmModel: result.llmModel,
      promptVersion: result.promptVersion,
      extractionEngine: result.engine,
      extractionVersion: result.engineVersion,
      fieldMethods: result.fieldMethods ?? undefined,
      extractionMs: Math.round(result.extractionMs),
      ocrUsed: result.ocrConfidence !== undefined,
      reviewRequired: result.needsReview,
      processedAt: new Date(),
    };
    // Manually corrected fields are trusted; drop review reasons that only concern them.
    if (corrected.size > 0) {
      candidateData.reviewReasons = result.reviewReasons.filter((r) => {
        const lower = r.toLowerCase();
        if (corrected.has("candidateName") && lower.includes("name")) return false;
        if (corrected.has("phoneNumber") && lower.includes("phone")) return false;
        if (corrected.has("jobRoleAppliedFor") && lower.includes("role")) return false;
        return true;
      });
      const na = candidateData.nameConfidence as number;
      const pa = candidateData.phoneConfidence as number;
      const ra = candidateData.roleConfidence as number;
      candidateData.overallConfidence = Number((na * 0.4 + pa * 0.35 + ra * 0.25).toFixed(3));
    }
    const finalStatus = (candidateData.reviewReasons as string[]).length > 0 ? "NEEDS_REVIEW" : "PROCESSED";
    // Keep the denormalised flag consistent with the reasons after manual
    // corrections have been subtracted, not with the raw engine output.
    candidateData.reviewRequired = finalStatus === "NEEDS_REVIEW";

    await prisma.$transaction([
      prisma.candidate.upsert({
        where: { cvFileId: cvFile.id },
        create: candidateData,
        update: candidateData,
      }),
      prisma.processingJob.update({
        where: { id: job.id },
        data: { status: finalStatus, stage: null, completedAt: new Date(), errorMessage: null, errorCode: null },
      }),
      prisma.cVFile.update({ where: { id: cvFile.id }, data: { status: finalStatus, statusMessage: null } }),
    ]);

    log.info(
      { status: finalStatus, method: result.extractionMethod, overall: result.overallConfidence, tokens: result.usage },
      "CV processed",
    );
  } catch (err) {
    const transient = isTransientError(err);
    const message = errorMessage(err).slice(0, 1000);
    const code = err instanceof AppError ? err.code : "PROCESSING_ERROR";
    const willRetry = transient && attempt < maxAttempts;
    log.warn({ code, transient, willRetry, message }, "CV processing failed");

    await prisma.$transaction([
      prisma.processingJob.update({
        where: { id: job.id },
        data: {
          status: willRetry ? "PENDING" : "FAILED",
          stage: willRetry ? "RETRY_SCHEDULED" : null,
          errorMessage: message,
          errorCode: code,
          completedAt: willRetry ? null : new Date(),
        },
      }),
      prisma.cVFile.update({
        where: { id: cvFile.id },
        data: { status: willRetry ? "PENDING" : "FAILED", statusMessage: message },
      }),
    ]);

    if (willRetry) throw err; // BullMQ retries with backoff
    throw new UnrecoverableError(message);
  }
}
