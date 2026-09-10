"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { ArrowLeft, ExternalLink, Pencil, RefreshCw, Save, X, AlertTriangle, Trash2 } from "lucide-react";
import { api, fetcher } from "@/lib/client/api";
import { formatBytes, formatDate, SOURCE_LABEL } from "@/lib/client/format";
import { StatusBadge } from "./StatusBadge";
import { ConfidenceBar } from "./Confidence";
import { DeleteCvDialog, type DeleteTarget } from "./DeleteCvDialog";

interface Detail {
  id: string;
  sourceType: string;
  sourceFileId: string | null;
  fileName: string;
  mimeType: string;
  fileSize: number;
  driveUrl: string | null;
  status: string;
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
  driveCreatedTime: string | null;
  driveModifiedTime: string | null;
  hasStoredFile: boolean;
  candidate: {
    id: string;
    candidateName: string;
    phoneNumber: string;
    jobRoleAppliedFor: string;
    nameConfidence: number;
    phoneConfidence: number;
    roleConfidence: number;
    overallConfidence: number;
    isManuallyCorrected: boolean;
    correctedFields: string[];
    reviewReasons: string[];
    extractionMethod: string;
    llmModel: string | null;
    promptVersion: string | null;
    processedAt: string | null;
    updatedAt: string;
  } | null;
  jobs: Array<{
    id: string;
    status: string;
    stage: string | null;
    attempts: number;
    maxAttempts: number;
    errorMessage: string | null;
    errorCode: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
  }>;
}

const METHOD_LABEL: Record<string, string> = {
  PDF_TEXT: "PDF text layer",
  DOCX: "DOCX text",
  DOC: "DOC text",
  OCR_IMAGE: "OCR (image)",
  OCR_PDF: "OCR (scanned PDF)",
  NONE: "—",
};

export function CandidateDetail({ id, threshold, startEditing }: { id: string; threshold: number; startEditing?: boolean }) {
  const { data, mutate, error } = useSWR<Detail>(`/api/candidates/${id}`, fetcher, {
    refreshInterval: (d) => (d && (d.status === "PENDING" || d.status === "PROCESSING") ? 2000 : 0),
  });
  const [editing, setEditing] = useState(Boolean(startEditing));
  const [form, setForm] = useState({ candidateName: "", phoneNumber: "", jobRoleAppliedFor: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (data?.candidate && !editing) {
      setForm({ candidateName: data.candidate.candidateName, phoneNumber: data.candidate.phoneNumber, jobRoleAppliedFor: data.candidate.jobRoleAppliedFor });
    } else if (data && !data.candidate && !editing) {
      setForm({ candidateName: "Not Found", phoneNumber: "Not Found", jobRoleAppliedFor: "Not Found" });
    }
  }, [data, editing]);

  if (error) return <div className="card p-6 text-sm text-red-600">{(error as Error).message}</div>;
  if (!data) return <div className="card p-6 text-sm text-gray-500">Loading…</div>;

  const c = data.candidate;
  const openUrl = data.sourceType === "GOOGLE_DRIVE" && data.driveUrl ? data.driveUrl : `/api/cv-files/${data.id}/download?inline=1`;
  const inFlight = data.status === "PENDING" || data.status === "PROCESSING";

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const patch: Record<string, string> = {};
      if (!c || form.candidateName !== c.candidateName) patch.candidateName = form.candidateName;
      if (!c || form.phoneNumber !== c.phoneNumber) patch.phoneNumber = form.phoneNumber;
      if (!c || form.jobRoleAppliedFor !== c.jobRoleAppliedFor) patch.jobRoleAppliedFor = form.jobRoleAppliedFor;
      if (Object.keys(patch).length) await api(`/api/candidates/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      setEditing(false);
      await mutate();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reprocess = async () => {
    setReprocessing(true);
    try {
      await api(`/api/candidates/${id}/reprocess`, { method: "POST" });
      await mutate();
    } finally {
      setReprocessing(false);
    }
  };

  const Field = ({ label, name, value, confidence }: { label: string; name: keyof typeof form; value: string; confidence?: number }) => (
    <div>
      <div className="label">{label}</div>
      {editing ? (
        <input className="input" value={form[name]} onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.value }))} />
      ) : (
        <div className="text-base font-medium text-gray-900">
          {value}
          {c?.correctedFields.includes(name) && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">manually corrected</span>}
        </div>
      )}
      {confidence !== undefined && !editing && (
        <div className="mt-1.5 max-w-xs">
          <ConfidenceBar value={confidence} threshold={threshold} />
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <DeleteCvDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={() => router.push("/candidates")} />
      <div className="flex items-center justify-between">
        <Link href="/candidates" className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900">
          <ArrowLeft size={15} /> Back to candidates
        </Link>
        <div className="flex items-center gap-2">
          {!editing ? (
            <button className="btn-secondary btn-sm" onClick={() => setEditing(true)} disabled={inFlight}>
              <Pencil size={13} /> Edit
            </button>
          ) : (
            <>
              <button className="btn-secondary btn-sm" onClick={() => setEditing(false)} disabled={saving}>
                <X size={13} /> Cancel
              </button>
              <button className="btn-primary btn-sm" onClick={save} disabled={saving}>
                <Save size={13} /> {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
          <button className="btn-secondary btn-sm" onClick={reprocess} disabled={reprocessing || inFlight}>
            <RefreshCw size={13} className={reprocessing || inFlight ? "animate-spin" : ""} /> Reprocess
          </button>
          <a href={openUrl} target="_blank" rel="noreferrer" className="btn-primary btn-sm">
            <ExternalLink size={13} /> Open Original CV
          </a>
          <button
            className="btn btn-sm border border-red-200 bg-white text-red-700 hover:bg-red-50"
            onClick={() => setDeleteTarget({ ids: [data.id], label: data.fileName, hasDriveFiles: data.sourceType === "GOOGLE_DRIVE" })}
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>

      {saveError && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{saveError}</div>}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="card space-y-5 p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Extracted information</h2>
            <StatusBadge status={data.status} size="md" />
          </div>
          <Field label="Candidate Name" name="candidateName" value={c?.candidateName ?? "Not Found"} confidence={c?.nameConfidence} />
          <Field label="Phone Number" name="phoneNumber" value={c?.phoneNumber ?? "Not Found"} confidence={c?.phoneConfidence} />
          <Field label="Job Role Applied For" name="jobRoleAppliedFor" value={c?.jobRoleAppliedFor ?? "Not Found"} confidence={c?.roleConfidence} />
          {c && !editing && (
            <div className="border-t border-gray-100 pt-4">
              <div className="label">Overall confidence</div>
              <div className="max-w-xs">
                <ConfidenceBar value={c.overallConfidence} threshold={threshold} />
              </div>
              <div className="mt-1 text-xs text-gray-500">Threshold {Math.round(threshold * 100)}% · fields below the threshold are flagged for review.</div>
            </div>
          )}
          {editing && <p className="text-xs text-gray-500">Enter “Not Found” to clear a field. Manual corrections are never overwritten by reprocessing.</p>}

          {(c?.reviewReasons.length || data.statusMessage) && !editing && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-800">
                <AlertTriangle size={15} /> Review information
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-amber-900">
                {data.statusMessage && <li>{data.statusMessage}</li>}
                {c?.reviewReasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">Source</h2>
            <dl className="space-y-2.5 text-sm">
              <Row k="Source" v={SOURCE_LABEL[data.sourceType] ?? data.sourceType} />
              <Row k="CV File Name" v={<span className="break-all">{data.fileName}</span>} />
              <Row k="Size / Type" v={`${formatBytes(data.fileSize)} · ${data.mimeType.split("/").pop()}`} />
              <Row
                k="CV Link"
                v={
                  <a href={openUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                    Open <ExternalLink size={12} />
                  </a>
                }
              />
              {data.sourceFileId && <Row k="Drive File ID" v={<span className="break-all font-mono text-xs">{data.sourceFileId}</span>} />}
              <Row k="Processing Status" v={<StatusBadge status={data.status} />} />
              <Row k="Created At" v={formatDate(data.createdAt)} />
              <Row k="Processed At" v={formatDate(c?.processedAt ?? null)} />
              {c && <Row k="Extraction" v={`${METHOD_LABEL[c.extractionMethod] ?? c.extractionMethod}${c.llmModel ? ` · ${c.llmModel}` : ""}${c.promptVersion ? ` · prompt ${c.promptVersion}` : ""}`} />}
            </dl>
          </div>

          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">Processing history</h2>
            <ul className="space-y-2 text-xs">
              {data.jobs.map((j) => (
                <li key={j.id} className="rounded-lg border border-gray-100 p-2.5">
                  <div className="flex items-center justify-between">
                    <StatusBadge status={j.status} />
                    <span className="text-gray-500">
                      {formatDate(j.createdAt)} · attempt {j.attempts}/{j.maxAttempts}
                    </span>
                  </div>
                  {j.stage && j.status === "PROCESSING" && <div className="mt-1 text-gray-600">Stage: {j.stage.replace(/_/g, " ").toLowerCase()}</div>}
                  {j.errorMessage && (
                    <div className="mt-1 break-words text-red-600">
                      {j.errorCode ? `[${j.errorCode}] ` : ""}
                      {j.errorMessage}
                    </div>
                  )}
                </li>
              ))}
              {data.jobs.length === 0 && <li className="text-gray-500">No processing jobs yet.</li>}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <dt className="text-gray-500">{k}</dt>
      <dd className="text-gray-900">{v}</dd>
    </div>
  );
}
