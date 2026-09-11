"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Cloud, CheckCircle2, FolderOpen, RefreshCw, Unplug, ChevronRight, Search, AlertTriangle, Radio } from "lucide-react";
import { api, fetcher } from "@/lib/client/api";
import { formatDate } from "@/lib/client/format";
import { Skeleton } from "@/components/ui";

interface Status {
  configured: boolean;
  redirectUri: string;
  webhooksEnabled: boolean;
  syncIntervalMinutes: number;
  connection: {
    id: string;
    email: string | null;
    folderId: string | null;
    folderName: string | null;
    folderPath: string | null;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    lastSyncFileCount: number;
    watchActive: boolean;
    connectedAt: string;
  } | null;
}

interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

export function DriveConnect({ flash }: { flash?: { connected?: boolean; error?: string } }) {
  const { data, mutate } = useSWR<Status>("/api/google-drive/status", fetcher, { refreshInterval: 10000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(flash?.error ?? null);
  const [notice, setNotice] = useState<string | null>(flash?.connected ? "Google Drive connected." : null);
  const [picking, setPicking] = useState(false);
  const [lastBatch, setLastBatch] = useState<string | null>(null);

  useEffect(() => {
    if (data?.connection && !data.connection.folderId) setPicking(true);
  }, [data]);

  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/google-drive/connect", { method: "POST" });
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };
  const syncNow = async () => {
    setBusy("sync");
    setError(null);
    try {
      const r = await api<{ batchId: string }>("/api/google-drive/sync", { method: "POST" });
      setLastBatch(r.batchId);
      setNotice("Sync queued. New CVs will appear under Processing shortly.");
      setTimeout(() => mutate(), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async () => {
    if (!confirm("Disconnect Google Drive? Existing parsed candidates are kept; automatic sync stops.")) return;
    setBusy("disconnect");
    try {
      await api("/api/google-drive/disconnect", { method: "POST" });
      setNotice("Disconnected.");
      await mutate();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!data)
    return (
      <div className="card space-y-3 p-6" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading…</span>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-24 w-full" />
      </div>
    );

  return (
    <div className="space-y-5">
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

      {!data.configured && (
        <div className="card border-amber-200 bg-amber-50 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 text-amber-600" size={18} />
            <div className="text-sm text-amber-900">
              <div className="font-semibold">Google OAuth is not configured</div>
              <p className="mt-1">
                Set <code className="rounded bg-white px-1">GOOGLE_CLIENT_ID</code> and <code className="rounded bg-white px-1">GOOGLE_CLIENT_SECRET</code> in <code className="rounded bg-white px-1">.env</code>, add the redirect URI{" "}
                <code className="rounded bg-white px-1">{data.redirectUri}</code> to the OAuth client in Google Cloud Console, then restart the app. See <code className="rounded bg-white px-1">docs/GOOGLE_CLOUD_SETUP.md</code>.
              </p>
            </div>
          </div>
        </div>
      )}

      {!data.connection ? (
        <div className="card flex flex-col items-center p-10 text-center">
          <Cloud size={36} className="text-brand-600" />
          <h2 className="mt-3 text-lg font-semibold text-gray-900">Connect Google Drive</h2>
          <p className="mt-1 max-w-md text-sm text-gray-500">
            Sign in with Google, choose the folder where recruiters drop CVs, and every new CV is detected and parsed automatically. Read-only access – files are never modified.
          </p>
          <button className="btn-primary mt-5" onClick={connect} disabled={!data.configured || busy === "connect"}>
            <Cloud size={15} /> {busy === "connect" ? "Redirecting…" : "Connect Google Drive"}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="card p-5 lg:col-span-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Google Drive</h2>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                <CheckCircle2 size={13} /> Connected
              </span>
            </div>
            <dl className="mt-4 space-y-3 text-sm">
              <Row k="Account" v={data.connection.email ?? "—"} />
              <Row
                k="Folder"
                v={
                  data.connection.folderId ? (
                    <span className="inline-flex items-center gap-1.5">
                      <FolderOpen size={14} className="text-gray-400" /> {data.connection.folderPath ?? data.connection.folderName}
                    </span>
                  ) : (
                    <span className="text-amber-700">No folder selected</span>
                  )
                }
              />
              <Row k="Last Sync" v={data.connection.lastSyncAt ? `${formatDate(data.connection.lastSyncAt)} · ${data.connection.lastSyncFileCount} file(s) seen` : "Never"} />
              <Row
                k="Detection"
                v={
                  <span className="inline-flex items-center gap-1.5">
                    <Radio size={13} className={data.connection.watchActive ? "text-emerald-600" : "text-gray-400"} />
                    {data.connection.watchActive ? "Push notifications active" : "Push notifications inactive"} · polling every {data.syncIntervalMinutes} min
                    {!data.webhooksEnabled && <span className="text-xs text-gray-500">(webhooks require an HTTPS APP_URL)</span>}
                  </span>
                }
              />
              {data.connection.lastSyncError && <Row k="Last error" v={<span className="text-red-600">{data.connection.lastSyncError}</span>} />}
            </dl>
            <div className="mt-5 flex flex-wrap gap-2">
              <button className="btn-primary" onClick={syncNow} disabled={busy === "sync" || !data.connection.folderId}>
                <RefreshCw size={14} className={busy === "sync" ? "animate-spin" : ""} /> Sync Now
              </button>
              <button className="btn-secondary" onClick={() => setPicking((p) => !p)}>
                <FolderOpen size={14} /> {data.connection.folderId ? "Change Folder" : "Select Folder"}
              </button>
              <button className="btn-danger" onClick={disconnect} disabled={busy === "disconnect"}>
                <Unplug size={14} /> Disconnect
              </button>
              {lastBatch && (
                <Link href={`/jobs?batchId=${lastBatch}`} className="btn-secondary">
                  View sync progress <ChevronRight size={14} />
                </Link>
              )}
            </div>
          </div>
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-900">How it works</h3>
            <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs text-gray-600">
              <li>Files in the selected folder are listed (PDF, DOC, DOCX, JPG, PNG, WEBP, Google Docs).</li>
              <li>Each file is identified by its Drive file ID, so nothing is parsed twice.</li>
              <li>The Drive Changes API {data.webhooksEnabled ? "and push notifications" : "is polled"} to pick up newly added CVs automatically.</li>
              <li>Files are downloaded temporarily for parsing and never modified.</li>
            </ol>
          </div>
        </div>
      )}

      {data.connection && picking && (
        <FolderPicker
          onPicked={async () => {
            setPicking(false);
            setNotice("Folder saved. A full sync has been queued.");
            await mutate();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function FolderPicker({ onPicked, onError }: { onPicked: () => void; onError: (m: string) => void }) {
  const [stack, setStack] = useState<Folder[]>([{ id: "root", name: "My Drive", parentId: null }]);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const current = stack[stack.length - 1];
  const url = q.trim() ? `/api/google-drive/folders?q=${encodeURIComponent(q.trim())}` : `/api/google-drive/folders?parent=${encodeURIComponent(current.id)}`;
  const { data, error, isLoading } = useSWR<{ folders: Folder[] }>(url, fetcher);

  const choose = async (f: Folder) => {
    setSaving(true);
    try {
      await api("/api/google-drive/folder", { method: "PUT", body: JSON.stringify({ folderId: f.id }) });
      onPicked();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Select a Drive folder</h2>
        <div className="relative w-64">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-gray-400" />
          <input className="input pl-8" placeholder="Search folders…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!q && (
        <div className="mt-3 flex flex-wrap items-center gap-1 text-xs text-gray-600">
          {stack.map((s, i) => (
            <span key={s.id} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} />}
              <button className="hover:text-brand-700 hover:underline" onClick={() => setStack(stack.slice(0, i + 1))}>
                {s.name}
              </button>
            </span>
          ))}
          <button className="btn-primary btn-sm ml-auto" disabled={saving || current.id === "root"} onClick={() => choose(current)}>
            Use “{current.name}”
          </button>
        </div>
      )}
      {error && <div className="mt-3 text-sm text-red-600">{(error as Error).message}</div>}
      <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200">
        {isLoading && (
          <li className="space-y-2 px-3 py-3">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3.5 w-1/3" />
          </li>
        )}
        {data?.folders.map((f) => (
          <li key={f.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <button className="inline-flex items-center gap-2 text-gray-800 hover:text-brand-700" onClick={() => (q ? choose(f) : setStack([...stack, f]))}>
              <FolderOpen size={15} className="text-amber-500" /> {f.name}
            </button>
            <button className="btn-secondary btn-sm" disabled={saving} onClick={() => choose(f)}>
              Select
            </button>
          </li>
        ))}
        {data && data.folders.length === 0 && !isLoading && <li className="px-3 py-3 text-sm text-gray-500">No sub-folders here.</li>}
      </ul>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <dt className="text-gray-500">{k}</dt>
      <dd className="text-gray-900">{v}</dd>
    </div>
  );
}
