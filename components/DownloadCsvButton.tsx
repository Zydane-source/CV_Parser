"use client";

import { useState } from "react";
import { Download, ChevronDown } from "lucide-react";

/**
 * Downloads the current candidate selection as CSV.
 *
 * Uses a normal navigation rather than fetch + blob: the endpoint streams, the
 * session cookie is sent automatically, and the browser writes straight to disk
 * so a large export never has to be held in a JavaScript string.
 */
export function DownloadCsvButton({ filters, total }: { filters: Record<string, string | undefined>; total?: number }) {
  const [open, setOpen] = useState(false);

  const href = (columns: "core" | "all") => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    p.set("columns", columns);
    return `/api/candidates/export?${p.toString()}`;
  };

  const go = (columns: "core" | "all") => {
    setOpen(false);
    window.location.href = href(columns);
  };

  return (
    <div className="relative">
      <div className="flex">
        <button className="btn-secondary btn-sm rounded-r-none" onClick={() => go("core")} title="Name, phone number and job role">
          <Download size={13} /> Download CSV{typeof total === "number" ? ` (${total})` : ""}
        </button>
        <button
          className="btn-secondary btn-sm rounded-l-none border-l-0 px-1.5"
          onClick={() => setOpen((o) => !o)}
          aria-label="CSV options"
          aria-expanded={open}
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
            <button className="block w-full px-3 py-2 text-left text-xs hover:bg-gray-50" onClick={() => go("core")}>
              <span className="font-medium text-gray-900">Three fields</span>
              <span className="block text-gray-500">Candidate name, phone number, job role</span>
            </button>
            <button className="block w-full border-t border-gray-100 px-3 py-2 text-left text-xs hover:bg-gray-50" onClick={() => go("all")}>
              <span className="font-medium text-gray-900">All details</span>
              <span className="block text-gray-500">Adds file name, CV link, source, status, confidence, date</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
