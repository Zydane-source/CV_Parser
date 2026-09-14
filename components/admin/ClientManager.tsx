"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Building2, Check, ChevronRight, Copy, FileText, Plus, RefreshCw, Users } from "lucide-react";
import { api, fetcher, ApiError } from "@/lib/client/api";
import { Alert, Badge, EmptyState, Section, TableSkeleton, cx } from "@/components/ui";
import { formatDate } from "@/lib/client/format";

interface Workspace {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  _count: { users: number; cvFiles: number };
  last7Days: number;
  lastFetchedAt: string | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function suggestPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * Every client on the platform. Owner only.
 *
 * A client and their first administrator are created in one form, because a
 * client nobody can sign in to is a half-finished state someone has to remember
 * to come back and repair.
 */
export function ClientManager() {
  const { data, error, isLoading, mutate } = useSWR<{ workspaces: Workspace[] }>("/api/workspaces", fetcher);

  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [handover, setHandover] = useState<{ client: string; email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", adminName: "", adminEmail: "", password: "" });

  const workspaces = data?.workspaces ?? [];
  // The handle is derived while typing but stays editable, so the common case
  // needs no thought and the awkward one is still possible.
  const effectiveSlug = form.slug || slugify(form.name);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy("create");
    try {
      await api("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          slug: effectiveSlug || undefined,
          admin: { name: form.adminName, email: form.adminEmail, password: form.password },
        }),
      });
      setHandover({ client: form.name, email: form.adminEmail, password: form.password });
      setForm({ name: "", slug: "", adminName: "", adminEmail: "", password: "" });
      setCreating(false);
      await mutate();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not create the client");
    } finally {
      setBusy(null);
    }
  };

  const toggleActive = async (ws: Workspace) => {
    setBusy(ws.id);
    setFormError(null);
    try {
      await api(`/api/workspaces/${ws.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !ws.isActive }) });
      await mutate();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not update the client");
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
          title={`${handover.client} is ready — copy these now`}
          onDismiss={() => setHandover(null)}
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
            The password is stored hashed and cannot be shown again. Their administrator can add the rest of their team themselves.
          </p>
        </Alert>
      )}

      {formError && <Alert tone="danger" title="That did not work">{formError}</Alert>}

      {/* The heading counts rather than restating: the page header above already
          names this and explains the isolation. */}
      <Section
        title={isLoading ? "Clients" : `${workspaces.length} ${workspaces.length === 1 ? "client" : "clients"}`}
        actions={
          <button type="button" onClick={() => setCreating((v) => !v)} className={creating ? "btn-secondary btn-sm" : "btn-primary btn-sm"}>
            <Plus size={14} /> {creating ? "Cancel" : "New client"}
          </button>
        }
      >
        {creating && (
          <form onSubmit={submit} className="border-b border-[var(--border)] bg-ink-50/60 px-5 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="c-name">Client name</label>
                <input
                  id="c-name"
                  className="input"
                  required
                  minLength={2}
                  maxLength={80}
                  placeholder="Apex Ventures"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="c-slug">Handle</label>
                <input
                  id="c-slug"
                  className="input numeric"
                  maxLength={48}
                  placeholder={slugify(form.name) || "apex-ventures"}
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                />
                <p className="hint">Used in links. Derived from the name unless you set one.</p>
              </div>
            </div>

            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <h3 className="text-section-title">Their first administrator</h3>
              <p className="mt-0.5 text-meta">
                This person signs in and adds the rest of their team.
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="c-admin-name">Full name</label>
                  <input id="c-admin-name" className="input" required maxLength={80} value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="c-admin-email">Sign-in address</label>
                  <input id="c-admin-email" className="input" required maxLength={160} value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} />
                </div>
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="c-password">Initial password</label>
                  <div className="flex gap-2">
                    <input
                      id="c-password"
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
                  <p className="hint">At least 10 characters. Shown once after you save, then only as a hash.</p>
                </div>
              </div>
            </div>

            <button type="submit" disabled={busy === "create"} className="btn-primary mt-5">
              {busy === "create" ? "Creating…" : "Create client"}
            </button>
          </form>
        )}

        {isLoading ? (
          <div className="p-5"><TableSkeleton rows={3} cols={5} /></div>
        ) : error ? (
          <EmptyState icon={<Building2 size={20} />} title="Could not load clients" description="Refresh the page to try again." />
        ) : workspaces.length === 0 ? (
          <EmptyState
            icon={<Building2 size={20} />}
            title="No clients yet"
            description="Create the first client and their administrator to start separating candidate data."
            action={<button type="button" onClick={() => setCreating(true)} className="btn-primary btn-sm"><Plus size={14} /> New client</button>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>People</th>
                  <th className="text-right">Total CVs</th>
                  <th className="text-right">Last 7 days</th>
                  <th>Last CV fetched</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((ws) => (
                  <tr key={ws.id} className={cx(!ws.isActive && "opacity-60")}>
                    <td>
                      {/* The client's name opens its activity: CVs fetched by date, and each one's time. */}
                      <Link href={`/clients/${ws.id}`} className="group flex items-center gap-2 font-medium text-ink-900 hover:text-brand-700">
                        <span className="min-w-0">
                          <span className="block truncate group-hover:underline">{ws.name}</span>
                          <span className="numeric block truncate text-xs font-normal text-ink-500">{ws.slug}</span>
                        </span>
                        <ChevronRight size={14} className="text-ink-400 group-hover:text-brand-600" />
                      </Link>
                    </td>
                    <td className="numeric"><span className="inline-flex items-center gap-1.5 text-ink-600"><Users size={13} className="text-ink-400" />{ws._count.users}</span></td>
                    <td className="numeric text-right"><span className="inline-flex items-center gap-1.5 font-semibold text-ink-900"><FileText size={13} className="text-ink-400" />{ws._count.cvFiles}</span></td>
                    <td className="numeric text-right text-ink-700">{ws.last7Days}</td>
                    <td className="numeric whitespace-nowrap text-ink-500">{ws.lastFetchedAt ? formatDate(ws.lastFetchedAt) : "Never"}</td>
                    <td><Badge tone={ws.isActive ? "success" : "neutral"}>{ws.isActive ? "Active" : "Suspended"}</Badge></td>
                    <td>
                      <div className="flex justify-end">
                        <button type="button" disabled={busy === ws.id} onClick={() => toggleActive(ws)} className={ws.isActive ? "btn-danger btn-sm" : "btn-secondary btn-sm"}>
                          {ws.isActive ? "Suspend" : "Restore"}
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
        Suspending a client keeps every CV and account and only stops sign-in, so ending an engagement is reversible.
      </p>
    </div>
  );
}
