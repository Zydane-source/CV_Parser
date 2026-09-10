"use client";

import useSWR from "swr";
import { Loader2 } from "lucide-react";
import { fetcher } from "@/lib/client/api";
import type { WorkerStatus } from "@/lib/client/useJobStream";
import { useDrainPump } from "@/lib/client/useDrainPump";
import { SystemAlerts } from "./SystemAlerts";

interface StatusResponse {
  worker: WorkerStatus;
  pending: number;
  mode: "queue" | "inline";
}

/**
 * Worker/LLM alert for pages that do not subscribe to the job stream (Upload,
 * Dashboard). On a deployment without a worker it also pumps the drain endpoint
 * so uploaded CVs actually get processed while the page is open.
 */
export function WorkerBanner() {
  const { data } = useSWR<StatusResponse>("/api/worker-status", fetcher, {
    refreshInterval: (d) => (d && d.pending > 0 ? 3000 : 10_000),
    revalidateOnFocus: true,
  });
  const inline = data?.mode === "inline";
  const { draining } = useDrainPump({ enabled: Boolean(inline), pending: data?.pending ?? 0 });

  if (!data) return null;

  if (inline && (data.pending > 0 || draining)) {
    return (
      <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
        <div className="flex items-center gap-2 text-sm text-blue-900">
          <Loader2 size={15} className="animate-spin" />
          <span>
            Processing {data.pending} CV{data.pending === 1 ? "" : "s"}…
            <span className="ml-1 text-xs text-blue-700">Keep this tab open to finish faster. A scheduled task also picks up anything left behind.</span>
          </span>
        </div>
      </div>
    );
  }

  return <SystemAlerts worker={data.worker} pendingCount={data.pending} />;
}
