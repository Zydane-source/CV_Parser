"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { UploadCloud, X, FileText, CheckCircle2, AlertCircle, Copy } from "lucide-react";
import { api } from "@/lib/client/api";
import { formatBytes } from "@/lib/client/format";
import { useJobStream } from "@/lib/client/useJobStream";
import { StatusBadge } from "./StatusBadge";

const ACCEPT = ".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp";
const ALLOWED_EXT = ["pdf", "doc", "docx", "jpg", "jpeg", "png", "webp"];

type LocalStatus = "ready" | "invalid" | "uploading" | "queued" | "duplicate" | "rejected";

interface LocalFile {
  key: string;
  file: File;
  status: LocalStatus;
  message?: string;
  cvFileId?: string;
  jobId?: string;
}

function makeBatchId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `up_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function UploadDropzone({ maxFileSizeMb, maxFilesPerRequest }: { maxFileSizeMb: number; maxFilesPerRequest: number }) {
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: live } = useJobStream({ batchId: batchId ?? undefined, enabled: Boolean(batchId), pageSize: 100 });
  const jobByCvFile = useMemo(() => new Map((live?.jobs ?? []).map((j) => [j.cvFileId, j])), [live]);

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      const next: LocalFile[] = [];
      for (const f of Array.from(list)) {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        const key = `${f.name}-${f.size}-${f.lastModified}`;
        let status: LocalStatus = "ready";
        let message: string | undefined;
        if (!ALLOWED_EXT.includes(ext)) {
          status = "invalid";
          message = "Unsupported type";
        } else if (f.size > maxFileSizeMb * 1024 * 1024) {
          status = "invalid";
          message = `Larger than ${maxFileSizeMb} MB`;
        }
        next.push({ key, file: f, status, message });
      }
      setFiles((prev) => {
        const seen = new Set(prev.map((p) => p.key));
        return [...prev, ...next.filter((n) => !seen.has(n.key))];
      });
    },
    [maxFileSizeMb],
  );

  const removeFile = (key: string) => setFiles((prev) => prev.filter((f) => f.key !== key));
  const clearAll = () => {
    setFiles([]);
    setBatchId(null);
    setUploadedCount(0);
  };

  const startParsing = async () => {
    const ready = files.filter((f) => f.status === "ready");
    if (!ready.length) return;
    const id = batchId ?? makeBatchId();
    setBatchId(id);
    setUploading(true);
    // Upload in chunks so 500+ files never hit one giant request.
    const chunkSize = Math.max(1, Math.min(maxFilesPerRequest, 10));
    for (let i = 0; i < ready.length; i += chunkSize) {
      const chunk = ready.slice(i, i + chunkSize);
      setFiles((prev) => prev.map((f) => (chunk.some((c) => c.key === f.key) ? { ...f, status: "uploading" } : f)));
      const form = new FormData();
      form.set("batchId", id);
      for (const c of chunk) form.append("files", c.file, c.file.name);
      try {
        const res = await api<{ results: Array<{ fileName: string; status: string; cvFileId?: string; jobId?: string; error?: string; candidateId?: string | null }> }>("/api/uploads", {
          method: "POST",
          body: form,
        });
        setFiles((prev) =>
          prev.map((f) => {
            const c = chunk.find((x) => x.key === f.key);
            if (!c) return f;
            // Match by sanitized name order within the chunk (server preserves order).
            const idx = chunk.indexOf(c);
            const r = res.results[idx];
            if (!r) return { ...f, status: "rejected", message: "No response for file" };
            if (r.status === "queued") return { ...f, status: "queued", cvFileId: r.cvFileId, jobId: r.jobId };
            if (r.status === "duplicate") return { ...f, status: "duplicate", cvFileId: r.cvFileId, message: "Already processed" };
            return { ...f, status: "rejected", message: r.error ?? "Rejected" };
          }),
        );
        setUploadedCount((n) => n + res.results.filter((r) => r.status === "queued").length);
      } catch (err) {
        setFiles((prev) => prev.map((f) => (chunk.some((c) => c.key === f.key) ? { ...f, status: "rejected", message: (err as Error).message } : f)));
      }
    }
    setUploading(false);
  };

  const readyCount = files.filter((f) => f.status === "ready").length;
  const progress = live?.progress;

  return (
    <div className="space-y-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        aria-label="Drop CV files here, or activate to browse"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          // The whole zone is the target for a mouse; it has to be reachable
          // without one too.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={clsx(
          "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center",
          "transition-colors duration-150",
          dragging
            ? "border-brand-500 bg-brand-50"
            : "border-[var(--border-strong)] bg-white hover:border-brand-300 hover:bg-brand-50/30",
        )}
      >
        <span
          className={clsx(
            "flex h-12 w-12 items-center justify-center rounded-xl transition-colors duration-150",
            dragging ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-600",
          )}
          aria-hidden
        >
          <UploadCloud size={24} />
        </span>
        <h2 className="mt-4 text-base font-semibold text-ink-900">{dragging ? "Drop to upload" : "Drop CVs here"}</h2>
        <p className="mt-1 text-sm text-ink-500">
          or{" "}
          <span className="font-medium text-brand-600 underline underline-offset-2">browse your files</span>
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <p className="mt-5 text-xs text-ink-400">
          PDF · DOC · DOCX · JPG · PNG · WEBP — up to {maxFileSizeMb} MB each, {maxFilesPerRequest} per batch
        </p>
      </div>

      {files.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
            <div className="text-sm text-gray-700">
              <span className="font-semibold">{files.length}</span> file{files.length === 1 ? "" : "s"} selected
              {readyCount > 0 && <span className="text-gray-500"> · {readyCount} ready</span>}
              {batchId && progress && (
                <span className="ml-3 text-brand-700">
                  Processing: {progress.done} / {progress.total}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {batchId && (
                <Link href={`/jobs?batchId=${batchId}`} className="btn-secondary btn-sm">
                  Open in Processing
                </Link>
              )}
              <button className="btn-secondary btn-sm" onClick={clearAll} disabled={uploading}>
                Clear
              </button>
              <button className="btn-primary btn-sm" onClick={startParsing} disabled={uploading || readyCount === 0}>
                {uploading ? "Uploading…" : `Start Parsing${readyCount ? ` (${readyCount})` : ""}`}
              </button>
            </div>
          </div>
          {progress && progress.total > 0 && (
            <div className="h-1.5 w-full bg-gray-100">
              <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
            </div>
          )}
          <div className="max-h-[480px] overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>File Name</th>
                  <th className="w-24">Size</th>
                  <th className="w-56">Status</th>
                  <th className="w-40 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const job = f.cvFileId ? jobByCvFile.get(f.cvFileId) : undefined;
                  const liveStatus = job?.cvFile.status ?? job?.status;
                  return (
                    <tr key={f.key}>
                      <td className="max-w-[360px]">
                        <div className="flex items-center gap-2">
                          <FileText size={15} className="shrink-0 text-gray-400" />
                          <span className="truncate" title={f.file.name}>
                            {f.file.name}
                          </span>
                        </div>
                      </td>
                      <td className="text-gray-500">{formatBytes(f.file.size)}</td>
                      <td>
                        {f.status === "ready" && <span className="text-xs font-medium text-gray-600">Ready</span>}
                        {f.status === "invalid" && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
                            <AlertCircle size={13} /> {f.message}
                          </span>
                        )}
                        {f.status === "uploading" && <span className="text-xs font-medium text-blue-600">Uploading…</span>}
                        {f.status === "rejected" && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600" title={f.message}>
                            <AlertCircle size={13} /> {f.message}
                          </span>
                        )}
                        {f.status === "duplicate" && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                            <Copy size={13} /> Already Processed
                          </span>
                        )}
                        {f.status === "queued" && (
                          <div className="flex flex-col gap-0.5">
                            <StatusBadge status={liveStatus ?? "PENDING"} />
                            {job?.stage && liveStatus === "PROCESSING" && <span className="text-[11px] text-gray-500">{job.stage.replace(/_/g, " ").toLowerCase()}</span>}
                            {job?.status === "FAILED" && job.errorMessage && (
                              <span className="line-clamp-1 text-[11px] text-red-600" title={job.errorMessage}>
                                {job.errorMessage}
                              </span>
                            )}
                            {job?.cvFile.candidate && liveStatus !== "PROCESSING" && liveStatus !== "PENDING" && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-gray-600">
                                <CheckCircle2 size={11} className="text-emerald-600" /> {job.cvFile.candidate.candidateName}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="text-right">
                        {(f.status === "ready" || f.status === "invalid") && (
                          <button className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" onClick={() => removeFile(f.key)} title="Remove">
                            <X size={15} />
                          </button>
                        )}
                        {f.status === "duplicate" && f.cvFileId && (
                          <div className="flex justify-end gap-2">
                            <Link href={`/candidates/${f.cvFileId}`} className="text-xs font-medium text-brand-700 hover:underline">
                              View Existing Result
                            </Link>
                            <button
                              className="text-xs font-medium text-gray-600 hover:underline"
                              onClick={async () => {
                                await api(`/api/candidates/${f.cvFileId}/reprocess`, { method: "POST" });
                                setFiles((prev) => prev.map((x) => (x.key === f.key ? { ...x, status: "queued", message: undefined } : x)));
                                if (!batchId) setBatchId(makeBatchId());
                              }}
                            >
                              Reprocess
                            </button>
                          </div>
                        )}
                        {f.status === "queued" && f.cvFileId && (liveStatus === "PROCESSED" || liveStatus === "NEEDS_REVIEW" || liveStatus === "FAILED") && (
                          <Link href={`/candidates/${f.cvFileId}`} className="text-xs font-medium text-brand-700 hover:underline">
                            View
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {uploadedCount > 0 && (
            <div className="border-t border-gray-200 px-4 py-2 text-xs text-gray-500">
              {uploadedCount} CV{uploadedCount === 1 ? "" : "s"} queued for background processing. You can leave this page; results appear under Candidates.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
