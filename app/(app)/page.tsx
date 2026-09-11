import Link from "next/link";
import { Activity, AlertTriangle, CheckCircle2, Clock, Cloud, FileText, Files, Upload, XCircle } from "lucide-react";
import { getDashboardStats } from "@/backend/stats";
import { prisma } from "@/lib/db";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, SOURCE_LABEL } from "@/lib/client/format";
import { DashboardLive } from "@/components/DashboardLive";
import { WorkerBanner } from "@/components/WorkerBanner";
import { Avatar, EmptyState, PageHeader, Section } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [stats, recent] = await Promise.all([
    getDashboardStats(),
    prisma.cVFile.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        fileName: true,
        sourceType: true,
        status: true,
        createdAt: true,
        candidate: { select: { candidateName: true, jobRoleAppliedFor: true, phoneNumber: true } },
      },
    }),
  ]);

  const inFlight = stats.pending + stats.processing;

  return (
    <div className="space-y-6">
      {/* The page is Dashboard. The product is CV Parser, and it is already named
          in the sidebar — repeating it here wasted the one line with the most
          attention on it. */}
      <PageHeader
        title="Dashboard"
        description="Intake at a glance: what has been processed, what needs a human, and what is still in the queue."
        actions={
          <>
            <Link href="/google-drive" className="btn-secondary">
              <Cloud size={15} /> Google Drive
            </Link>
            <Link href="/upload" className="btn-primary">
              <Upload size={15} /> Upload CVs
            </Link>
          </>
        }
      />

      <DashboardLive initial={stats} />
      <WorkerBanner />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <MetricCard
          label="Total CVs"
          value={stats.total}
          icon={Files}
          hint={`${stats.bySource.manual} manual · ${stats.bySource.googleDrive} Drive`}
          href="/candidates"
        />
        <MetricCard label="Processed" value={stats.processed} icon={CheckCircle2} tone="success" href="/candidates?status=PROCESSED" />
        <MetricCard
          label="Needs review"
          value={stats.needsReview}
          icon={AlertTriangle}
          tone="warning"
          hint={stats.needsReview ? "Low confidence on a field" : undefined}
          href="/candidates?status=NEEDS_REVIEW"
        />
        <MetricCard label="Failed" value={stats.failed} icon={XCircle} tone="danger" href="/candidates?status=FAILED" />
        <MetricCard
          label="In queue"
          value={inFlight}
          icon={Clock}
          tone="info"
          hint={stats.processing ? `${stats.processing} processing now` : undefined}
          href="/jobs"
        />
      </div>

      <Section
        title="Recent CVs"
        description="The last eight files to arrive, from either source."
        actions={
          <Link href="/jobs" className="btn-tertiary btn-sm">
            <Activity size={13} /> Processing monitor
          </Link>
        }
      >
        {recent.length === 0 ? (
          <EmptyState
            icon={<FileText size={20} />}
            title="No CVs yet"
            description="Upload your first CV to start building the candidate database, or connect Google Drive to import a folder automatically."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/upload" className="btn-primary">
                  <Upload size={15} /> Upload CVs
                </Link>
                <Link href="/google-drive" className="btn-secondary">
                  <Cloud size={15} /> Connect Drive
                </Link>
              </div>
            }
          />
        ) : (
          /* The table scrolls inside its own container rather than pushing the
             page sideways — a horizontally scrolling page is the fastest way to
             make a desktop product feel broken on a laptop. */
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Job role</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th className="text-right">Added</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const name = r.candidate?.candidateName;
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/candidates/${r.id}`} className="flex items-center gap-3 group/row">
                          <Avatar name={name || r.fileName} size="sm" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-ink-900 group-hover/row:text-brand-700">
                              {name || "Not extracted"}
                            </span>
                            <span className="block max-w-[16rem] truncate text-[0.6875rem] text-ink-500">{r.fileName}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="max-w-[14rem] truncate">{r.candidate?.jobRoleAppliedFor ?? "—"}</td>
                      <td className="whitespace-nowrap text-ink-600">{SOURCE_LABEL[r.sourceType]}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="whitespace-nowrap text-right text-ink-500 numeric">{formatDate(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
