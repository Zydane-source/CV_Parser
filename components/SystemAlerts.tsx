"use client";

import { AlertTriangle, KeyRound, Terminal } from "lucide-react";
import type { WorkerStatus } from "@/lib/client/useJobStream";

/**
 * Explains why CVs are not progressing. Without this, a stopped worker or a
 * rejected LLM key looks identical to "still queued" and the queue appears
 * silently stuck.
 */
export function SystemAlerts({ worker, pendingCount = 0 }: { worker?: WorkerStatus; pendingCount?: number }) {
  if (!worker) return null;

  if (!worker.online) {
    return (
      <div className="rounded-xl border border-red-300 bg-red-50 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-900">
            <div className="font-semibold">No background worker is running — CVs will stay Pending</div>
            <p className="mt-1">
              Uploads are saved and queued correctly, but nothing is consuming the queue
              {pendingCount > 0 ? ` (${pendingCount} job${pendingCount === 1 ? "" : "s"} waiting)` : ""}. Start the worker in a second terminal from the project folder:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-red-100 px-3 py-2 font-mono text-xs text-red-900">npm run worker</pre>
            <p className="mt-2 text-xs">
              Queued CVs are picked up automatically once it starts. Use <span className="font-medium">npm run dev:all</span> to run the web app and the worker together.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (worker.configError) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
        <div className="flex items-start gap-3">
          <KeyRound size={18} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            <div className="font-semibold">The worker is running but the LLM is not usable — every CV will fail</div>
            <p className="mt-1 break-words">{worker.configError}</p>
            <p className="mt-2 text-xs">
              Fix <span className="font-mono">LLM_API_KEY</span> (and <span className="font-mono">LLM_PROVIDER</span> / <span className="font-mono">LLM_MODEL</span>) in{" "}
              <span className="font-mono">.env</span>, restart the worker, then click <span className="font-medium">Retry all failed</span>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

/** Compact inline indicator for headers. */
export function WorkerPill({ worker }: { worker?: WorkerStatus }) {
  if (!worker) return null;
  const tone = !worker.online ? "bg-red-50 text-red-700" : worker.configError ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700";
  const label = !worker.online ? "Worker offline" : worker.configError ? "Worker degraded" : `Worker online${worker.count > 1 ? ` ×${worker.count}` : ""}`;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      <Terminal size={12} />
      {label}
    </span>
  );
}
