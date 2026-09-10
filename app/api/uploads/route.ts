import { z } from "zod";
import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { RateLimitError, ValidationError, errorMessage } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { getStorage, buildObjectKey } from "@/services/storage";
import { validateUploadedFile } from "@/services/cv-parser/file-validation";
import { enqueueCVFile } from "@/services/processing/enqueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/uploads  (multipart/form-data)
 *   files[]  – one or more CV files
 *   batchId  – optional client-generated id grouping this upload session
 *
 * Each file is validated, hashed (SHA-256) for duplicate detection, stored in
 * object storage and queued for background processing. One bad file never
 * blocks the others: per-file outcomes are returned.
 */
const batchSchema = z.string().regex(/^[a-zA-Z0-9_-]{6,64}$/).optional();

type UploadOutcome =
  | { fileName: string; status: "queued"; cvFileId: string; jobId: string }
  | { fileName: string; status: "duplicate"; cvFileId: string; candidateId: string | null; existingStatus: string }
  | { fileName: string; status: "rejected"; error: string };

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const settings = await getSettings();

  const rl = await rateLimit(`uploads:${user.id}`, 60, 60);
  if (!rl.allowed) throw new RateLimitError("Upload rate limit reached. Please wait a minute.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ValidationError("Expected multipart/form-data");
  }
  const batchId = batchSchema.parse(form.get("batchId")?.toString() || undefined);
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new ValidationError("No files provided (use the 'files' field)");
  if (files.length > settings.maxFilesPerRequest) {
    throw new ValidationError(`Too many files in one request (max ${settings.maxFilesPerRequest}). Upload in smaller batches.`);
  }

  const maxBytes = settings.maxFileSizeMb * 1024 * 1024;
  const storage = getStorage();
  const results: UploadOutcome[] = [];

  for (const file of files) {
    const originalName = file.name || "cv";
    try {
      if (file.size > maxBytes) throw new ValidationError(`File too large (max ${settings.maxFileSizeMb} MB)`);
      const buffer = Buffer.from(await file.arrayBuffer());
      const valid = await validateUploadedFile(buffer, originalName, maxBytes);
      const hash = sha256Hex(buffer);

      // Duplicate detection (content hash across all sources).
      const existing = await prisma.cVFile.findFirst({
        where: { fileHash: hash },
        select: { id: true, status: true, candidate: { select: { id: true } } },
        orderBy: { createdAt: "asc" },
      });
      if (existing) {
        results.push({ fileName: valid.fileName, status: "duplicate", cvFileId: existing.id, candidateId: existing.candidate?.id ?? null, existingStatus: existing.status });
        continue;
      }

      const key = buildObjectKey(valid.fileName);
      await storage.put(key, buffer, valid.mimeType);
      const cvFile = await prisma.cVFile.create({
        data: {
          sourceType: "MANUAL",
          fileName: valid.fileName,
          mimeType: valid.mimeType,
          fileHash: hash,
          fileSize: valid.size,
          storagePath: key,
          uploadedById: user.id,
          status: "PENDING",
        },
      });
      const job = await enqueueCVFile(cvFile, { batchId });
      results.push({ fileName: valid.fileName, status: "queued", cvFileId: cvFile.id, jobId: job.id });
    } catch (err) {
      results.push({ fileName: originalName, status: "rejected", error: errorMessage(err) });
    }
  }

  return ok({ batchId: batchId ?? null, results, queued: results.filter((r) => r.status === "queued").length });
});
