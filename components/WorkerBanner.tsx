"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/client/api";
import type { WorkerStatus } from "@/lib/client/useJobStream";
import { SystemAlerts } from "./SystemAlerts";

/**
 * Standalone worker/LLM alert for pages that do not already subscribe to the
 * job stream (Upload, Dashboard). Polls a cheap endpoint every 10 seconds.
 */
export function WorkerBanner() {
  const { data } = useSWR<{ worker: WorkerStatus; pending: number }>("/api/worker-status", fetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
  });
  if (!data) return null;
  return <SystemAlerts worker={data.worker} pendingCount={data.pending} />;
}
