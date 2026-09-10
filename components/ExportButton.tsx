"use client";

import { useState } from "react";
import { Sheet, ExternalLink } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";

export function ExportButton({ filters }: { filters: Record<string, string | undefined> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ spreadsheetUrl: string; rowCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
      const r = await api<{ spreadsheetUrl: string; rowCount: number }>("/api/google-sheets/export", { method: "POST", body: JSON.stringify({ filters: clean }) });
      setResult(r);
    } catch (err) {
      const e = err as ApiError;
      setError(e.code === "GOOGLE_NOT_CONNECTED" ? "Connect Google Drive first (Sheets uses the same Google account)." : e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {result && (
        <a href={result.spreadsheetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline">
          <ExternalLink size={12} /> Exported {result.rowCount} rows – open sheet
        </a>
      )}
      {error && <span className="max-w-[280px] truncate text-xs text-red-600" title={error}>{error}</span>}
      <button className="btn-primary btn-sm" onClick={run} disabled={busy}>
        <Sheet size={13} /> {busy ? "Exporting…" : "Export to Google Sheets"}
      </button>
    </div>
  );
}
