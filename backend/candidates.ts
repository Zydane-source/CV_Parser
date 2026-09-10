import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { normalizePhone } from "@/services/cv-parser/phone";
import { validateName, validateRole } from "@/services/cv-parser/validate";

/**
 * Candidate domain logic shared by the API routes and the Sheets export:
 * database-backed search, filtering, pagination and manual corrections.
 */
export const candidateFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  source: z.enum(["MANUAL", "GOOGLE_DRIVE"]).optional(),
  status: z.enum(["PENDING", "PROCESSING", "PROCESSED", "NEEDS_REVIEW", "FAILED", "SKIPPED"]).optional(),
  role: z.string().trim().max(200).optional(),
  from: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  to: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(["processedAt", "createdAt", "candidateName", "overallConfidence"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export type CandidateFilters = z.infer<typeof candidateFiltersSchema>;

export function buildCandidateWhere(f: Partial<CandidateFilters>): Prisma.CVFileWhereInput {
  const where: Prisma.CVFileWhereInput = {};
  if (f.source) where.sourceType = f.source;
  if (f.status) where.status = f.status;
  if (f.role) where.candidate = { ...(where.candidate as object), jobRoleAppliedFor: { contains: f.role, mode: "insensitive" } };
  if (f.from || f.to) {
    where.createdAt = {};
    if (f.from) where.createdAt.gte = new Date(f.from);
    if (f.to) {
      const to = new Date(f.to);
      if (/^\d{4}-\d{2}-\d{2}$/.test(f.to)) to.setUTCHours(23, 59, 59, 999);
      where.createdAt.lte = to;
    }
  }
  if (f.q) {
    const q = f.q;
    const phoneDigits = q.replace(/\D/g, "");
    const or: Prisma.CVFileWhereInput[] = [
      { fileName: { contains: q, mode: "insensitive" } },
      { candidate: { candidateName: { contains: q, mode: "insensitive" } } },
      { candidate: { jobRoleAppliedFor: { contains: q, mode: "insensitive" } } },
    ];
    if (phoneDigits.length >= 4) {
      const n = normalizePhone(q);
      or.push({ candidate: { phoneNumber: { contains: n.valid ? n.normalized : phoneDigits } } });
    }
    where.OR = or;
  }
  return where;
}

export const candidateSelect = {
  id: true,
  sourceType: true,
  sourceFileId: true,
  fileName: true,
  mimeType: true,
  fileSize: true,
  driveUrl: true,
  status: true,
  statusMessage: true,
  createdAt: true,
  updatedAt: true,
  candidate: {
    select: {
      id: true,
      candidateName: true,
      phoneNumber: true,
      jobRoleAppliedFor: true,
      nameConfidence: true,
      phoneConfidence: true,
      roleConfidence: true,
      overallConfidence: true,
      isManuallyCorrected: true,
      correctedFields: true,
      reviewReasons: true,
      extractionMethod: true,
      llmModel: true,
      promptVersion: true,
      processedAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.CVFileSelect;

export type CandidateRow = Prisma.CVFileGetPayload<{ select: typeof candidateSelect }>;

export async function listCandidates(f: CandidateFilters) {
  const where = buildCandidateWhere(f);
  const nullsLast: Prisma.SortOrderInput = { sort: f.order, nulls: "last" };
  const orderBy: Prisma.CVFileOrderByWithRelationInput =
    f.sort === "createdAt"
      ? { createdAt: f.order }
      : f.sort === "processedAt"
        ? { candidate: { processedAt: nullsLast } }
        : f.sort === "candidateName"
          ? { candidate: { candidateName: f.order } }
          : { candidate: { overallConfidence: f.order } };

  const [total, items] = await Promise.all([
    prisma.cVFile.count({ where }),
    prisma.cVFile.findMany({
      where,
      select: candidateSelect,
      orderBy,
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
  ]);
  return { items, total, page: f.page, pageSize: f.pageSize, pages: Math.max(1, Math.ceil(total / f.pageSize)) };
}

/** Iterate all matching rows in pages (for exports) without loading everything at once. */
export async function* iterateCandidates(f: Omit<CandidateFilters, "page" | "pageSize">, pageSize = 500) {
  let page = 1;
  for (;;) {
    const res = await listCandidates({ ...f, page, pageSize });
    for (const row of res.items) yield row;
    if (page >= res.pages) break;
    page++;
  }
}

export async function getCandidateDetail(cvFileId: string) {
  const row = await prisma.cVFile.findUnique({
    where: { id: cvFileId },
    select: {
      ...candidateSelect,
      driveCreatedTime: true,
      driveModifiedTime: true,
      storagePath: true,
      jobs: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          status: true,
          stage: true,
          attempts: true,
          maxAttempts: true,
          errorMessage: true,
          errorCode: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          batchId: true,
        },
      },
    },
  });
  if (!row) throw new NotFoundError("Candidate not found");
  const { storagePath, ...rest } = row;
  return { ...rest, hasStoredFile: Boolean(storagePath) };
}

export const candidateUpdateSchema = z
  .object({
    candidateName: z.string().trim().min(1).max(120).optional(),
    phoneNumber: z.string().trim().min(1).max(40).optional(),
    jobRoleAppliedFor: z.string().trim().min(1).max(150).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export type CandidateUpdate = z.infer<typeof candidateUpdateSchema>;

/** Apply a manual correction. Marks the record corrected and clears review flags for corrected fields. */
export async function updateCandidate(cvFileId: string, patch: CandidateUpdate) {
  const cvFile = await prisma.cVFile.findUnique({ where: { id: cvFileId }, include: { candidate: true } });
  if (!cvFile) throw new NotFoundError("Candidate not found");

  const data: Prisma.CandidateUncheckedUpdateInput = {};
  const corrected = new Set(cvFile.candidate?.correctedFields ?? []);
  const notFound = (v: string) => /^not\s*found$/i.test(v.trim());

  if (patch.candidateName !== undefined) {
    if (!notFound(patch.candidateName)) {
      const v = validateName(patch.candidateName);
      if (!v.ok) throw new ValidationError(v.reason ?? "Invalid candidate name");
      data.candidateName = v.value;
    } else data.candidateName = "Not Found";
    data.nameConfidence = 1;
    corrected.add("candidateName");
  }
  if (patch.phoneNumber !== undefined) {
    if (!notFound(patch.phoneNumber)) {
      const n = normalizePhone(patch.phoneNumber);
      if (!n.valid) throw new ValidationError(`Invalid phone number: ${patch.phoneNumber}`);
      data.phoneNumber = n.normalized;
    } else data.phoneNumber = "Not Found";
    data.phoneConfidence = 1;
    corrected.add("phoneNumber");
  }
  if (patch.jobRoleAppliedFor !== undefined) {
    if (!notFound(patch.jobRoleAppliedFor)) {
      const v = validateRole(patch.jobRoleAppliedFor);
      if (!v.ok) throw new ValidationError(v.reason ?? "Invalid job role");
      data.jobRoleAppliedFor = v.value;
    } else data.jobRoleAppliedFor = "Not Found";
    data.roleConfidence = 1;
    corrected.add("jobRoleAppliedFor");
  }

  const existing = cvFile.candidate;
  const nameC = (data.nameConfidence as number | undefined) ?? existing?.nameConfidence ?? 0;
  const phoneC = (data.phoneConfidence as number | undefined) ?? existing?.phoneConfidence ?? 0;
  const roleC = (data.roleConfidence as number | undefined) ?? existing?.roleConfidence ?? 0;
  data.overallConfidence = Number((nameC * 0.4 + phoneC * 0.35 + roleC * 0.25).toFixed(3));
  data.isManuallyCorrected = true;
  data.correctedFields = [...corrected];

  const remainingReasons = (existing?.reviewReasons ?? []).filter((r) => {
    const lower = r.toLowerCase();
    if (corrected.has("candidateName") && lower.includes("name")) return false;
    if (corrected.has("phoneNumber") && lower.includes("phone")) return false;
    if (corrected.has("jobRoleAppliedFor") && lower.includes("role")) return false;
    return true;
  });
  data.reviewReasons = remainingReasons;

  const wasTerminal = ["PROCESSED", "NEEDS_REVIEW"].includes(cvFile.status);
  const newStatus = wasTerminal ? (remainingReasons.length ? "NEEDS_REVIEW" : "PROCESSED") : cvFile.status;

  const [candidate] = await prisma.$transaction([
    prisma.candidate.upsert({
      where: { cvFileId },
      create: {
        cvFileId,
        candidateName: (data.candidateName as string) ?? "Not Found",
        phoneNumber: (data.phoneNumber as string) ?? "Not Found",
        jobRoleAppliedFor: (data.jobRoleAppliedFor as string) ?? "Not Found",
        nameConfidence: nameC,
        phoneConfidence: phoneC,
        roleConfidence: roleC,
        overallConfidence: data.overallConfidence as number,
        isManuallyCorrected: true,
        correctedFields: [...corrected],
        reviewReasons: remainingReasons,
      },
      update: data,
    }),
    prisma.cVFile.update({ where: { id: cvFileId }, data: { status: newStatus } }),
  ]);
  return candidate;
}

/** Distinct job roles for the filter dropdown (top N by frequency). */
export async function topJobRoles(limit = 50) {
  const rows = await prisma.candidate.groupBy({
    by: ["jobRoleAppliedFor"],
    _count: { _all: true },
    where: { jobRoleAppliedFor: { not: "Not Found" } },
    orderBy: { _count: { jobRoleAppliedFor: "desc" } },
    take: limit,
  });
  return rows.map((r) => ({ role: r.jobRoleAppliedFor, count: r._count._all }));
}
