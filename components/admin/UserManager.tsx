"use client";

import { useState } from "react";
import useSWR from "swr";
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck, UserPlus, Users } from "lucide-react";
import { api, fetcher, ApiError } from "@/lib/client/api";
import { Alert, Avatar, Badge, EmptyState, Section, TableSkeleton, cx } from "@/components/ui";
import { formatDate } from "@/lib/client/format";

export interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: "OWNER" | "ADMIN" | "RECRUITER";
  isActive: boolean;
  createdAt: string;
}

/**
 * Generate a password the administrator can hand over.
 *
 * Offered because the alternative is observable: whoever is adding five
 * recruiters in a row types five variations of the same thing. Deliberately
 * excludes the characters that get misread when a password is written down or
 * read aloud — 0/O, 1/l/I.
 */
function suggestPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const ROLE_LABEL: Record<ManagedUser["role"], string> = {
  OWNER: "Platform owner",
  ADMIN: "Administrator",
  RECRUITER: "Recruiter",
};

/**
 * People in one client workspace.
 *
 * `workspaceId` is passed only by the platform owner, who is managing a client
 * that is not their own. A client's administrator renders this with no id and
 * the server takes the workspace from their session — so the component cannot be
 * pointed at another client by changing what the browser sends.
 */
export function UserManager({ workspaceId, canAdd = true }: { workspaceId?: string; canAdd?: boolean }) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  const { data, error, isLoading, mutate } = useSWR<{ users: ManagedUser[] }>(`/api/users${qs}`, fetcher);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "RECRUITER" as "ADMIN" | "RECRUITER" });
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [handover, setHandover] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const users = data?.users ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy("create");
    try {
      await api(`/api/users${qs}`, { method: "POST", body: JSON.stringify(form) });
      // Shown once, right after creating, because this is the only moment the
      // plain password exists anywhere — it is hashed before it is stored.
      setHandover({ email: form.email, password: form.password });
      setForm({ name: "", email: "", password: "", role: "RECRUITER" });
      setAdding(false);
      await mutate();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not create the account");
    } finally {
      setBusy(null);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    setFormError(null);
    try {
      await api(`/api/users/${id}${qs}`, { method: "PATCH", body: JSON.stringify(body) });
      await mutate();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not update the account");
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = async (u: ManagedUser) => {
    const password = suggestPassword();
    setBusy(u.id);
    setFormError(null);
    try {
      await api(`/api/users/${u.id}${qs}`, { method: "PATCH", body: JSON.stringify({ password }) });
      setHandover({ email: u.email, password });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not reset the password");
    } finally {
      setBusy(null);
    }
  };

  const copyHandover = async () => {
    if (!handover) return;
    await navigator.clipboard.writeText(`${handover.email} / ${handover.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {handover && (
        <Alert
          tone="success"
          title="Account ready — copy these now"
          action={
            <button type="button" onClick={copyHandover} className="btn-secondary btn-sm">
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
            </button>
          }
        >
          <p className="numeric break-all text-[0.8125rem]">
            {handover.email} &nbsp;·&nbsp; <strong>{handover.password}</strong>
          </p>
          <p className="mt-1 text-xs opacity-80">
            The password is stored hashed, so it cannot be shown again. Ask them to change it after signing in.
          </p>
          <button type="button" onClick={() => setHandover(null)} className="btn-tertiary btn-sm mt-2 px-0">
            Dismiss
          </button>
        </Alert>
      )}

      {formError && <Alert tone="danger" title="That did not work">{formError}</Alert>}

      <Section
        title="People"
        description="Who can sign in to this client and what they may do."
        actions={
          canAdd && (
            <button type="button" onClick={() => setAdding((v) => !v)} className={adding ? "btn-secondary btn-sm" : "btn-primary btn-sm"}>
              <UserPlus size={14} /> {adding ? "Cancel" : "Add person"}
            </button>
          )
        }
      >
        {adding && (
          <form onSubmit={submit} className="grid gap-4 border-b border-[var(--border)] bg-ink-50/60 px-5 py-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="u-name">Full name</label>
              <input id="u-name" className="input" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="u-email">Sign-in address</label>
              <input id="u-email" className="input" required maxLength={160} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <p className="hint">An email address, or a plain username for a shared account.</p>
            </div>
            <div>
              <label className="label" htmlFor="u-role">Role</label>
              <select id="u-role" className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "ADMIN" | "RECRUITER" })}>
                <option value="RECRUITER">Recruiter — uploads and reviews CVs</option>
                <option value="ADMIN">Administrator — also manages people and settings</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="u-password">Initial password</label>
              <div className="flex gap-2">
                <input
                  id="u-password"
                  className="input numeric"
                  required
                  minLength={10}
                  maxLength={200}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                <button type="button" className="btn-secondary btn-sm flex-shrink-0" onClick={() => setForm({ ...form, password: suggestPassword() })}>
                  <RefreshCw size={14} /> Generate
                </button>
              </div>
              <p className="hint">At least 10 characters. Shown once after you save.</p>
            </div>
            <div className="sm:col-span-2">
              <button type="submit" disabled={busy === "create"} className="btn-primary">
                {busy === "create" ? "Creating…" : "Create account"}
              </button>
            </div>
          </form>
        )}

        {isLoading ? (
          <div className="p-5"><TableSkeleton rows={3} cols={4} /></div>
        ) : error ? (
          <EmptyState icon={<Users size={20} />} title="Could not load the people in this client" description="Refresh the page to try again." />
        ) : users.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title="Nobody here yet" description="Add the first person to give this client access." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Added</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={cx(!u.isActive && "opacity-60")}>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={u.name} size="sm" />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink-900">{u.name}</div>
                          <div className="truncate text-xs text-ink-500">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={u.role === "RECRUITER" ? "neutral" : "brand"} icon={u.role !== "RECRUITER" ? <ShieldCheck size={12} /> : undefined}>
                        {ROLE_LABEL[u.role]}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={u.isActive ? "success" : "neutral"}>{u.isActive ? "Active" : "Deactivated"}</Badge>
                    </td>
                    <td className="numeric whitespace-nowrap text-ink-500">{formatDate(u.createdAt)}</td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <button type="button" disabled={busy === u.id} onClick={() => resetPassword(u)} className="btn-tertiary btn-sm" title="Set a new password">
                          <KeyRound size={14} /> Reset password
                        </button>
                        <button
                          type="button"
                          disabled={busy === u.id}
                          onClick={() => patch(u.id, { isActive: !u.isActive })}
                          className={u.isActive ? "btn-danger btn-sm" : "btn-secondary btn-sm"}
                        >
                          {u.isActive ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <p className="text-xs text-ink-500">
        Deactivating keeps everything the person did — who uploaded which CV stays answerable — and only stops them signing in.
      </p>
    </div>
  );
}
