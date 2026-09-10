"use client";

import { useState } from "react";
import { Trash2, AlertTriangle, X } from "lucide-react";
import { api } from "@/lib/client/api";

export interface DeleteTarget {
  ids: string[];
  /** Shown in the prompt when a single CV is being deleted. */
  label?: string;
  /** Whether any target came from Google Drive (changes the wording). */
  hasDriveFiles?: boolean;
}

/**
 * Confirmation dialog for deleting CVs. Deletion removes the extracted
 * candidate, the job history and the stored file, so it always asks first.
 */
export function DeleteCvDialog({ target, onClose, onDeleted }: { target: DeleteTarget | null; onClose: () => void; onDeleted: (n: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ignoreFutureSync, setIgnoreFutureSync] = useState(true);

  if (!target) return null;
  const many = target.ids.length > 1;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ deleted: number }>("/api/candidates/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids: target.ids, ignoreFutureSync }),
      });
      onDeleted(res.deleted);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-red-50 text-red-600">
              <AlertTriangle size={18} />
            </span>
            <h2 className="text-base font-semibold text-gray-900">{many ? `Delete ${target.ids.length} CVs?` : "Delete this CV?"}</h2>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="mt-3 text-sm text-gray-600">
          {!many && target.label && <p className="mb-2 break-all font-medium text-gray-900">{target.label}</p>}
          <p>This permanently removes the extracted candidate details, the processing history and the uploaded file. It cannot be undone.</p>
          {target.hasDriveFiles && (
            <>
              <p className="mt-2">
                Files that came from Google Drive are only unlinked here. <span className="font-medium">The file in your Drive is never touched.</span>
              </p>
              <label className="mt-3 flex items-start gap-2 rounded-lg bg-gray-50 p-2.5 text-xs">
                <input type="checkbox" className="mt-0.5" checked={ignoreFutureSync} onChange={(e) => setIgnoreFutureSync(e.target.checked)} />
                <span>
                  Do not import these Drive files again.
                  <span className="block text-gray-500">Untick and the next sync will re-import them.</span>
                </span>
              </label>
            </>
          )}
        </div>

        {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn bg-red-600 text-white hover:bg-red-700" onClick={confirm} disabled={busy}>
            <Trash2 size={14} /> {busy ? "Deleting…" : many ? `Delete ${target.ids.length}` : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
