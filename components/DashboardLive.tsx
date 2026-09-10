"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refreshes the server-rendered dashboard while CVs are being processed. */
export function DashboardLive({ initial }: { initial: { pending: number; processing: number } }) {
  const router = useRouter();
  useEffect(() => {
    const active = initial.pending + initial.processing > 0;
    const t = setInterval(() => router.refresh(), active ? 3000 : 15000);
    return () => clearInterval(t);
  }, [initial.pending, initial.processing, router]);
  return null;
}
