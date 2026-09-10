"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Search, RefreshCw, ExternalLink, Pencil, Eye, ChevronLeft, ChevronRight, Trash2, Plus } from "lucide-react";
import { api, fetcher } from "@/lib/client/api";
import { formatDate, SOURCE_LABEL } from "@/lib/client/format";
import { StatusBadge } from "./StatusBadge";
import { ConfidenceBar } from "./Confidence";
import { ExportButton } from "./ExportButton";
import { DownloadCsvButton } from "./DownloadCsvButton";
import { DeleteCvDialog, type DeleteTarget } from "./DeleteCvDialog";

export interface CandidateRowDto {
  id: string;
  sourceType: string;
  fileName: string;
  driveUrl: string | null;
  status: string;
  statusMessage: string | null;
  createdAt: string;
  candidate: {
    id: string;
    candidateName: string;
    phoneNumber: string;
    jobRoleAppliedFor: string;
    overallConfidence: number;
    isManuallyCorrected: boolean;
    processedAt: string | null;
  } | null;
}

interface ListResponse {
  items: CandidateRowDto[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

const STATUSES = ["PENDING", "PROCESSING", "PROCESSED", "NEEDS_REVIEW", "FAILED", "SKIPPED"];

export function CandidatesTable({ threshold, initialStatus }: { threshold: number; initialStatus?: string }) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState(initialStatus ?? "");
  const [role, setRole] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [debouncedQ, source, status, role, from, to]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set("q", debouncedQ);
    if (source) p.set("source", source);
    if (status) p.set("status", status);
    if (role) p.set("role", role);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    p.set("page", String(page));
    p.set("pageSize", "25");
    return p.toString();
  }, [debouncedQ, source, status, role, from, to, page]);

  const { data, mutate, isLoading } = useSWR<ListResponse>(`/api/candidates?${query}`, fetcher, { refreshInterval: 5000, keepPreviousData: true });
  const { data: roles } = useSWR<{ roles: Array<{ role: string; count: number }> }>("/api/candidates/roles", fetcher);

  const reprocess = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/candidates/${id}/reprocess`, { method: "POST" });
      await mutate();
    } finally {
      setBusy(null);
    }
  };

  const filters = { q: debouncedQ || undefined, source: source || undefined, status: status || undefined, role: role || undefined, from: from || undefined, to: to || undefined };

  const rows = data?.items ?? [];
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const askDeleteSelected = () =>
    setDeleteTarget({ ids: [...selected], hasDriveFiles: selectedRows.some((r) => r.sourceType === "GOOGLE_DRIVE") });

  return (
    <div className="space-y-4">
      <DeleteCvDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(n) => {
          setSelected(new Set());
          setNotice(`Deleted ${n} CV${n === 1 ? "" : "s"}.`);
          setTimeout(() => setNotice(null), 4000);
          void mutate();
        }}
      />
      <div className="card p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
          <div className="relative md:col-span-2">
            <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-gray-400" />
            <input className="input pl-9" placeholder="Search name, phone, job role or file name…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            <option value="MANUAL">Manual Upload</option>
            <option value="GOOGLE_DRIVE">Google Drive</option>
          </select>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">All job roles</option>
            {(roles?.roles ?? []).map((r) => (
              <option key={r.role} value={r.role}>
                {r.role} ({r.count})
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} title="From date" />
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} title="To date" />
          </div>
        </div>
      </div>

      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</div>}

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <div className="text-sm text-gray-600">
            {selected.size > 0 ? (
              <span className="inline-flex items-center gap-3">
                <span className="font-semibold text-gray-900">{selected.size} selected</span>
                <button className="text-xs font-medium text-gray-500 hover:text-gray-900 hover:underline" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </span>
            ) : data ? (
              <>
                <span className="font-semibold text-gray-900">{data.total.toLocaleString("en-IN")}</span> candidate{data.total === 1 ? "" : "s"}
              </>
            ) : (
              "Loading…"
            )}
          </div>
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <button className="btn btn-sm border border-red-200 bg-white text-red-700 hover:bg-red-50" onClick={askDeleteSelected}>
                <Trash2 size={13} /> Delete {selected.size}
              </button>
            )}
            <Link href="/upload" className="btn-secondary btn-sm">
              <Plus size={13} /> Add CVs
            </Link>
            <button className="btn-secondary btn-sm" onClick={() => mutate()} disabled={isLoading}>
              <RefreshCw size={13} className={isLoading ? "animate-spin" : ""} /> Refresh
            </button>
            <DownloadCsvButton filters={filters} total={data?.total} />
            <ExportButton filters={filters} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="w-9 pr-0">
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={allOnPageSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allOnPageSelected && rows.some((r) => selected.has(r.id));
                    }}
                    onChange={togglePage}
                    aria-label="Select all on this page"
                  />
                </th>
                <th>Candidate Name</th>
                <th>Phone Number</th>
                <th>Job Role</th>
                <th>Source</th>
                <th>Confidence</th>
                <th>Status</th>
                <th>Processed At</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={selected.has(row.id) ? "bg-brand-50/40" : undefined}>
                  <td className="pr-0">
                    <input
                      type="checkbox"
                      className="cursor-pointer"
                      checked={selected.has(row.id)}
                      onChange={() => toggleRow(row.id)}
                      aria-label={`Select ${row.fileName}`}
                    />
                  </td>
                  <td>
                    <Link href={`/candidates/${row.id}`} className="font-medium text-gray-900 hover:text-brand-700">
                      {row.candidate?.candidateName ?? <span className="text-gray-400">—</span>}
                    </Link>
                    <div className="max-w-[220px] truncate text-[11px] text-gray-500" title={row.fileName}>
                      {row.fileName}
                    </div>
                  </td>
                  <td className="tabular-nums">{row.candidate?.phoneNumber ?? "—"}</td>
                  <td className="max-w-[200px] truncate" title={row.candidate?.jobRoleAppliedFor}>
                    {row.candidate?.jobRoleAppliedFor ?? "—"}
                  </td>
                  <td className="text-gray-600">{SOURCE_LABEL[row.sourceType] ?? row.sourceType}</td>
                  <td>{row.candidate ? <ConfidenceBar value={row.candidate.overallConfidence} threshold={threshold} /> : <span className="text-gray-400">—</span>}</td>
                  <td>
                    <StatusBadge status={row.status} />
                    {row.candidate?.isManuallyCorrected && <div className="mt-0.5 text-[10px] text-gray-500">edited</div>}
                  </td>
                  <td className="whitespace-nowrap text-gray-600">{formatDate(row.candidate?.processedAt ?? null)}</td>
                  <td>
                    <div className="flex items-center justify-end gap-1">
                      <Link href={`/candidates/${row.id}`} className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900" title="View">
                        <Eye size={15} />
                      </Link>
                      <Link href={`/candidates/${row.id}?edit=1`} className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900" title="Edit">
                        <Pencil size={15} />
                      </Link>
                      <button
                        onClick={() => reprocess(row.id)}
                        disabled={busy === row.id || row.status === "PROCESSING" || row.status === "PENDING"}
                        className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40"
                        title="Reprocess"
                      >
                        <RefreshCw size={15} className={busy === row.id ? "animate-spin" : ""} />
                      </button>
                      <a
                        href={row.sourceType === "GOOGLE_DRIVE" && row.driveUrl ? row.driveUrl : `/api/cv-files/${row.id}/download?inline=1`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                        title="Open CV"
                      >
                        <ExternalLink size={15} />
                      </a>
                      <button
                        onClick={() => setDeleteTarget({ ids: [row.id], label: row.fileName, hasDriveFiles: row.sourceType === "GOOGLE_DRIVE" })}
                        className="rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-700"
                        title="Delete CV"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-sm text-gray-500">
                    No candidates match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 text-sm text-gray-600">
            <span>
              Page {data.page} of {data.pages}
            </span>
            <div className="flex gap-2">
              <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft size={14} /> Prev
              </button>
              <button className="btn-secondary btn-sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
