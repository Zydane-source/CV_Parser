"use client";

import { useState } from "react";
import Link from "next/link";
import { RefreshCw, Wifi, WifiOff, RotateCcw, Activity, Upload } from "lucide-react";
import { api } from "@/lib/client/api";
import { formatRelative, SOURCE_LABEL } from "@/lib/client/format";
import { useJobStream } from "@/lib/client/useJobStream";
import { StatusBadge } from "./StatusBadge";
import { WorkerPill } from "./SystemAlerts";
import { WorkerBanner } from "./WorkerBanner";
import { EmptyState } from "@/components/ui";

const STATUSES = ["", "PENDING", "PROCESSING", "PROCESSED", "NEEDS_REVIEW", "FAILED", "SKIPPED"];

export function JobsMonitor({ initialBatchId }: { initialBatchId?: string }) {
  const [batchId, setBatchId] = useState(initialBatchId ?? "");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const { data, connected, error } = useJobStream({ batchId: batchId || undefined, status: status || undefined, pageSize: 100 });

  const retryOne = async (jobId: string) => {
    setBusy(jobId);
    try {
      await api(`/api/jobs/${jobId}/retry`, { method: "POST" });
    } finally {
      setBusy(null);
    }
  };
  const retryAllFailed = async () => {
    setBusy("all");
    try {
      await api("/api/jobs/retry-failed", { method: "POST", body: JSON.stringify({ batchId: batchId || undefined }) });
    } finally {
      setBusy(null);
    }
  };

  const p = data?.progress;
  const pctDone = p && p.total ? Math.round((p.done / p.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <WorkerBanner />
      <div className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <label className="label">Batch ID (optional)</label>
            <input className="input font-mono text-xs" placeholder="e.g. up_3f9a… or drive_…" value={batchId} onChange={(e) => setBatchId(e.target.value.trim())} />
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s ? s.replace("_", " ") : "All"}
                </option>
              ))}
            </select>
          </div>
          <button className="btn-secondary" onClick={retryAllFailed} disabled={busy === "all" || !p?.failed}>
            <RotateCcw size={14} /> Retry all failed{p?.failed ? ` (${p.failed})` : ""}
          </button>
          <div className="ml-auto inline-flex items-center gap-2">
            <WorkerPill worker={data?.worker} />
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
              {connected ? <Wifi size={13} className="text-emerald-600" /> : <WifiOff size={13} className="text-gray-400" />}
              {connected ? "Live" : error ? "Polling" : "Connecting…"}
            </span>
          </div>
        </div>
      </div>

      {p && (
        <div className="card p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <div className="text-sm font-semibold text-gray-900">
              Processing: {p.done} / {p.total}
              <span className="ml-2 text-xs font-normal text-gray-500">{batchId ? "in this batch" : "last 24 hours"}</span>
            </div>
            <div className="text-xs text-gray-500">{pctDone}%</div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div className="h-full bg-brand-600 transition-all" style={{ width: `${pctDone}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
            <Mini label="Pending" v={p.pending} />
            <Mini label="Processing" v={p.processing} />
            <Mini label="Processed" v={p.processed} cls="text-emerald-700" />
            <Mini label="Needs Review" v={p.needsReview} cls="text-amber-700" />
            <Mini label="Failed" v={p.failed} cls="text-red-700" />
            <Mini label="Skipped" v={p.skipped} />
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>File</th>
              <th>Source</th>
              <th>Status</th>
              <th>Stage / Error</th>
              <th>Attempts</th>
              <th>Updated</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.jobs ?? []).map((j) => (
              <tr key={j.id}>
                <td className="max-w-[300px]">
                  <Link href={`/candidates/${j.cvFileId}`} className="block truncate font-medium text-gray-900 hover:text-brand-700" title={j.cvFile.fileName}>
                    {j.cvFile.fileName}
                  </Link>
                  {j.cvFile.candidate && <div className="text-[11px] text-gray-500">{j.cvFile.candidate.candidateName}</div>}
                </td>
                <td className="text-gray-600">{SOURCE_LABEL[j.cvFile.sourceType]}</td>
                <td>
                  <StatusBadge status={j.status} />
                </td>
                <td className="max-w-[360px]">
                  {j.status === "PROCESSING" && j.stage && <span className="text-xs text-blue-700">{j.stage.replace(/_/g, " ").toLowerCase()}</span>}
                  {j.status === "PENDING" && j.stage === "RETRY_SCHEDULED" && <span className="text-xs text-gray-600">retry scheduled (backoff)</span>}
                  {j.errorMessage && (
                    <span className="line-clamp-2 text-xs text-red-600" title={j.errorMessage}>
                      {j.errorCode ? `[${j.errorCode}] ` : ""}
                      {j.errorMessage}
                    </span>
                  )}
                </td>
                <td className="tabular-nums text-gray-600">
                  {j.attempts}/{j.maxAttempts}
                </td>
                <td className="whitespace-nowrap text-gray-600">{formatRelative(j.completedAt ?? j.startedAt ?? j.createdAt)}</td>
                <td className="text-right">
                  {j.status === "FAILED" && (
                    <button className="btn-secondary btn-sm" onClick={() => retryOne(j.id)} disabled={busy === j.id}>
                      <RefreshCw size={12} className={busy === j.id ? "animate-spin" : ""} /> Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data && data.jobs.length === 0 && (
              <tr>
                <td colSpan={7} className="p-0">
                  <EmptyState
                    icon={<Activity size={20} />}
                    title="No processing jobs yet"
                    description="Jobs appear here as soon as a CV is uploaded or a Drive folder is synced."
                    action={
                      <Link href="/upload" className="btn-primary">
                        <Upload size={15} /> Upload CVs
                      </Link>
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Mini({ label, v, cls }: { label: string; v: number; cls?: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${cls ?? "text-gray-900"}`}>{v}</div>
    </div>
  );
}
