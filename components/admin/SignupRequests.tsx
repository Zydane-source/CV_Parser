"use client";

import { useState } from "react";
import useSWR, { mutate as refresh } from "swr";
import { Check, UserPlus, X } from "lucide-react";
import { api, fetcher, ApiError } from "@/lib/client/api";
import { Alert, Section } from "@/components/ui";

interface PendingSignup {
  id: string;
  name: string;
  email: string;
  companyName: string;
  createdAt: string;
  expiresAt: string;
  attempts: number;
}

const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Create account requests that have not been completed yet.
 *
 * The emailed code is one way to approve; this is the other. Approving here
 * creates the client at once, and the applicant signs in with the email and
 * password they chose — useful when the code has expired, or when the approval
 * email is not to hand. Renders nothing when there is nothing waiting.
 */
export function SignupRequests() {
  const { data, mutate } = useSWR<{ requests: PendingSignup[] }>("/api/signup-requests", fetcher, { refreshInterval: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const requests = data?.requests ?? [];

  const act = async (r: PendingSignup, approve: boolean) => {
    if (!approve && !window.confirm(`Reject the account request from ${r.companyName}? Their code will stop working.`)) return;
    setBusy(r.id);
    setMessage(null);
    try {
      await api(`/api/signup-requests/${r.id}`, { method: approve ? "POST" : "DELETE" });
      setMessage(
        approve
          ? { tone: "success", text: `${r.companyName} is approved. ${r.email} can now sign in with the password they chose.` }
          : { tone: "success", text: `The request from ${r.companyName} was rejected.` },
      );
      await mutate();
      // The new client should appear in the list below without a reload.
      await refresh("/api/workspaces");
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof ApiError ? err.message : "That did not work" });
    } finally {
      setBusy(null);
    }
  };

  if (!requests.length && !message) return null;

  return (
    <div className="space-y-3">
      {message && (
        <Alert tone={message.tone} onDismiss={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}
      {requests.length > 0 && (
        <Section
          title={`${requests.length} account ${requests.length === 1 ? "request" : "requests"} waiting`}
          description="People who used Create account. Approve here, or share the code emailed to you."
        >
          <ul className="divide-y divide-[var(--border)]">
            {requests.map((r) => {
              const codeLive = new Date(r.expiresAt).getTime() > Date.now();
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600" aria-hidden>
                    <UserPlus size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-ink-900">{r.companyName}</div>
                    <div className="truncate text-xs text-ink-500">
                      {r.name} · {r.email}
                    </div>
                  </div>
                  <div className="text-right text-xs text-ink-500">
                    <div className="numeric">Requested {fmt(r.createdAt)}</div>
                    <div>{codeLive ? "Code still valid" : "Code expired — approve here"}</div>
                  </div>
                  <div className="flex gap-1.5">
                    <button type="button" disabled={busy === r.id} onClick={() => act(r, false)} className="btn-secondary btn-sm">
                      <X size={14} /> Reject
                    </button>
                    <button type="button" disabled={busy === r.id} onClick={() => act(r, true)} className="btn-primary btn-sm">
                      <Check size={14} /> {busy === r.id ? "Approving…" : "Approve"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </div>
  );
}
