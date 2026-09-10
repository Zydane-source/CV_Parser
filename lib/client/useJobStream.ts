"use client";

import { useEffect, useRef, useState } from "react";

export interface JobRow {
  id: string;
  cvFileId: string;
  batchId: string | null;
  status: string;
  stage: string | null;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  cvFile: { fileName: string; sourceType: string; status: string; candidate: { id: string; candidateName: string; overallConfidence: number } | null };
}

export interface Progress {
  total: number;
  done: number;
  pending: number;
  processing: number;
  processed: number;
  needsReview: number;
  failed: number;
  skipped: number;
}

export interface Stats {
  total: number;
  processed: number;
  needsReview: number;
  failed: number;
  pending: number;
  processing: number;
  skipped: number;
  bySource: { manual: number; googleDrive: number };
  last24h: number;
}

export interface WorkerStatus {
  online: boolean;
  count: number;
  configError: string | null;
  workers?: Array<{ id: string; pid: number; host: string; startedAt: string; concurrency: number; llm: { provider: string; model: string; keyConfigured: boolean; lastError: string | null } }>;
}

export interface StreamUpdate {
  at: number;
  progress: Progress;
  stats: Stats;
  jobs: JobRow[];
  total: number;
  worker?: WorkerStatus;
}

/**
 * Subscribe to /api/jobs/stream (SSE) for live processing updates. Falls back
 * to polling /api/jobs if EventSource is unavailable or errors repeatedly.
 */
export function useJobStream(params: { batchId?: string; status?: string; pageSize?: number; enabled?: boolean }) {
  const [data, setData] = useState<StreamUpdate | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = params.enabled ?? true;
  const qs = new URLSearchParams();
  if (params.batchId) qs.set("batchId", params.batchId);
  if (params.status) qs.set("status", params.status);
  qs.set("pageSize", String(params.pageSize ?? 100));
  const query = qs.toString();
  const failures = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (poll) return;
      const tick = async () => {
        try {
          const res = await fetch(`/api/jobs?${query}`, { credentials: "same-origin" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json();
          const statsRes = await fetch("/api/stats", { credentials: "same-origin" });
          const stats = statsRes.ok ? await statsRes.json() : null;
          setData({ at: Date.now(), progress: j.progress, stats, jobs: j.items, total: j.total, worker: j.worker });
          setError(null);
        } catch (err) {
          setError((err as Error).message);
        }
      };
      void tick();
      poll = setInterval(tick, 3000);
    };

    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      es = new EventSource(`/api/jobs/stream?${query}`);
      es.addEventListener("update", (ev) => {
        failures.current = 0;
        setConnected(true);
        setError(null);
        try {
          setData(JSON.parse((ev as MessageEvent).data));
        } catch {
          /* ignore malformed frame */
        }
      });
      es.onerror = () => {
        setConnected(false);
        failures.current += 1;
        if (failures.current >= 3) {
          es?.close();
          es = null;
          startPolling();
        }
      };
    }
    return () => {
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [query, enabled]);

  return { data, connected, error };
}
