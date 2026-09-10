import { prisma } from "@/lib/db";

export interface DashboardStats {
  total: number;
  processed: number;
  needsReview: number;
  failed: number;
  pending: number;
  processing: number;
  skipped: number;
  bySource: { manual: number; googleDrive: number };
  last24h: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [byStatus, bySource, last24h] = await Promise.all([
    prisma.cVFile.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.cVFile.groupBy({ by: ["sourceType"], _count: { _all: true } }),
    prisma.cVFile.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
  ]);
  const count = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  const src = (s: string) => bySource.find((r) => r.sourceType === s)?._count._all ?? 0;
  const total = byStatus.reduce((a, r) => a + r._count._all, 0);
  return {
    total,
    processed: count("PROCESSED"),
    needsReview: count("NEEDS_REVIEW"),
    failed: count("FAILED"),
    pending: count("PENDING"),
    processing: count("PROCESSING"),
    skipped: count("SKIPPED"),
    bySource: { manual: src("MANUAL"), googleDrive: src("GOOGLE_DRIVE") },
    last24h,
  };
}
