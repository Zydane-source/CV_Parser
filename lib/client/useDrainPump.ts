"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Keeps CV processing moving from the browser when the deployment has no worker
 * process (PROCESSING_MODE=inline, e.g. on Vercel).
 *
 * Normally the server processes in the background by itself (background chains,
 * see services/processing/background.ts) and this only *nudges*: while CVs are
 * pending it asks /api/jobs/kick every few seconds to make sure chains are
 * running. That is cheap and idempotent, and closing the tab changes nothing.
 *
 * If a deployment cannot run background chains (no CRON_SECRET), it falls back
 * to draining from the tab, with a few requests in parallel. A failed or timed
 * out request is retried rather than ending the loop — previously a single 504
 * stopped all processing until the page was reloaded.
 */
const NUDGE_EVERY_MS = 8_000;
const TAB_LANES = 3;

export function useDrainPump({ enabled, pending }: { enabled: boolean; pending: number }) {
  const [draining, setDraining] = useState(false);
  const [background, setBackground] = useState<boolean | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || pending <= 0 || running.current) return;
    running.current = true;
    setDraining(true);

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const tabLane = async () => {
      let failures = 0;
      while (mounted.current && failures < 5) {
        try {
          const res = await fetch("/api/jobs/drain", { method: "POST", credentials: "same-origin" });
          if (!res.ok) throw new Error(String(res.status));
          failures = 0;
          const j = (await res.json()) as { remaining: number; claimed: number };
          if (j.remaining <= 0 && j.claimed === 0) return;
        } catch {
          failures++;
          await sleep(1500 * failures);
        }
      }
    };

    void (async () => {
      try {
        while (mounted.current && pendingRef.current > 0) {
          let bg = false;
          try {
            const res = await fetch("/api/jobs/kick", { method: "POST", credentials: "same-origin" });
            if (res.ok) {
              const j = (await res.json()) as { background: boolean; pending: number };
              bg = j.background;
              setBackground(bg);
              if (j.pending <= 0) break;
            }
          } catch {
            // Offline for a moment: try again on the next tick.
          }
          if (!bg) {
            // No background processing on this deployment: do the work from here.
            await Promise.all(Array.from({ length: TAB_LANES }, tabLane));
            break;
          }
          await sleep(NUDGE_EVERY_MS);
        }
      } finally {
        running.current = false;
        if (mounted.current) setDraining(false);
      }
    })();
  }, [enabled, pending]);

  return { draining, background };
}
