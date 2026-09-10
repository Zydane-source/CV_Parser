import Link from "next/link";
import { Files, CheckCircle2, AlertTriangle, XCircle, Clock, Upload, Cloud, Activity } from "lucide-react";
import { getDashboardStats } from "@/backend/stats";
import { prisma } from "@/lib/db";
import { StatCard } from "@/components/StatCard";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, SOURCE_LABEL } from "@/lib/client/format";
import { DashboardLive } from "@/components/DashboardLive";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [stats, recent] = await Promise.all([
    getDashboardStats(),
    prisma.cVFile.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, fileName: true, sourceType: true, status: true, createdAt: true, candidate: { select: { candidateName: true, jobRoleAppliedFor: true, phoneNumber: true } } },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">CV Parser</h1>
          <p className="text-sm text-gray-500">Recruitment intake overview</p>
        </div>
        <div className="flex gap-2">
          <Link href="/upload" className="btn-primary">
            <Upload size={15} /> Upload CVs
          </Link>
          <Link href="/google-drive" className="btn-secondary">
            <Cloud size={15} /> Google Drive
          </Link>
        </div>
      </div>

      <DashboardLive initial={stats} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <StatCard label="Total CVs" value={stats.total} icon={Files} hint={`${stats.bySource.manual} manual · ${stats.bySource.googleDrive} Drive`} />
        <StatCard label="Processed" value={stats.processed} icon={CheckCircle2} tone="success" />
        <StatCard label="Needs Review" value={stats.needsReview} icon={AlertTriangle} tone="warning" />
        <StatCard label="Failed" value={stats.failed} icon={XCircle} tone="danger" />
        <StatCard label="Pending" value={stats.pending + stats.processing} icon={Clock} tone="info" hint={stats.processing ? `${stats.processing} processing now` : undefined} />
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Recent CVs</h2>
          <Link href="/jobs" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
            <Activity size={13} /> Processing monitor
          </Link>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>File</th>
              <th>Candidate</th>
              <th>Job Role</th>
              <th>Source</th>
              <th>Status</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.id}>
                <td className="max-w-[260px] truncate">
                  <Link href={`/candidates/${r.id}`} className="font-medium text-gray-900 hover:text-brand-700">
                    {r.fileName}
                  </Link>
                </td>
                <td>{r.candidate?.candidateName ?? "—"}</td>
                <td className="max-w-[200px] truncate">{r.candidate?.jobRoleAppliedFor ?? "—"}</td>
                <td className="text-gray-600">{SOURCE_LABEL[r.sourceType]}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="whitespace-nowrap text-gray-600">{formatDate(r.createdAt)}</td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td colSpan={6} className="py-10 text-center text-sm text-gray-500">
                  No CVs yet. Upload some or connect Google Drive.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
