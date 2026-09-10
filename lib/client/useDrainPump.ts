"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Drives CV processing from the browser when the deployment has no worker
 * process (PROCESSING_MODE=inline, e.g. on Vercel).
 *
 * Each call to /api/jobs/drain runs inside its own serverless invocation and
 * processes a small number of CVs, so a batch completes as a series of short
 * requests instead of one long-running job. Calls are strictly sequential: a
 * second request while one is in flight would only contend for the same rows.
 *
 * A scheduled cron performs the same drain server-side, so closing the tab
 * delays a batch rather than stalling it.
 */
export function useDrainPump({ enabled, pending }: { enabled: boolean; pending: number }) {
  const [draining, setDraining] = useState(false);
  const inFlight = useRef(false);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled || pending <= 0 || inFlight.current) return;

    let cancelled = false;
    const pump = async () => {
      inFlight.current = true;
      setDraining(true);
      try {
        // Keep going while this component is mounted and work remains.
        for (;;) {
          if (cancelled || stopped.current) break;
          const res = await fetch("/api/jobs/drain", { method: "POST", credentials: "same-origin" });
          if (!res.ok) break;
          const j = (await res.json()) as { remaining: number; claimed: number };
          if (j.remaining <= 0 || j.claimed === 0) break;
        }
      } catch {
        // Network hiccup: the next status refresh re-triggers the pump.
      } finally {
        inFlight.current = false;
        setDraining(false);
      }
    };
    void pump();
    return () => {
      cancelled = true;
    };
  }, [enabled, pending]);

  return { draining };
}
