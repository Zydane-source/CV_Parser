"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Save, CheckCircle2, XCircle } from "lucide-react";
import { api, fetcher } from "@/lib/client/api";

interface SettingsResponse {
  settings: Record<string, string | number | null>;
  env: {
    appUrl: string;
    llm: { provider: string; model: string; baseUrl: string; apiKeyConfigured: boolean; promptVersion: string; timeoutMs: number };
    google: { clientConfigured: boolean; redirectUri: string; defaultFolderId: string | null; defaultSpreadsheetId: string | null; webhooksEnabled: boolean };
    ocr: { provider: string; languages: string };
    storage: { driver: string; effectiveDriver: string; bucket: string | null; blobTokenConfigured: boolean };
    queue: { redisConfigured: boolean; workerConcurrency: number };
  };
  promptVersions: string[];
}

type Field = { key: string; label: string; type: "number" | "text" | "select"; step?: string; min?: number; max?: number; hint?: string; options?: string[] };

const SECTIONS: Array<{ title: string; description: string; fields: Field[] }> = [
  {
    title: "LLM configuration",
    description: "Provider, API key and base URL come from the environment (never stored in the database). Model and prompt can be tuned here.",
    fields: [
      { key: "llmModel", label: "Model", type: "text" },
      { key: "llmPromptVersion", label: "Prompt version", type: "select", options: [] },
      { key: "llmTemperature", label: "Temperature", type: "number", step: "0.1", min: 0, max: 2 },
      { key: "llmTimeoutMs", label: "Timeout (ms)", type: "number", min: 1000, max: 600000 },
      { key: "maxCvTextChars", label: "Max CV text chars sent to LLM", type: "number", min: 1000, max: 200000 },
      { key: "llmRateLimitPerMinute", label: "LLM calls per minute (worker)", type: "number", min: 1, max: 10000, hint: "Protects the external API from bulk batches" },
    ],
  },
  {
    title: "Confidence",
    description: "Any required field below the threshold marks the CV as Needs Review.",
    fields: [{ key: "confidenceThreshold", label: "Confidence threshold (0–1)", type: "number", step: "0.05", min: 0, max: 1 }],
  },
  {
    title: "Processing",
    description: "Background worker behaviour. Concurrency and retry changes take effect when the worker restarts; other values apply immediately.",
    fields: [
      { key: "workerConcurrency", label: "Worker concurrency", type: "number", min: 1, max: 50 },
      { key: "maxRetries", label: "Max attempts per CV", type: "number", min: 0, max: 10 },
      { key: "retryBackoffMs", label: "Retry backoff base (ms)", type: "number", min: 500, max: 600000, hint: "Exponential: base × 2^attempt" },
    ],
  },
  {
    title: "File limits",
    description: "Applies to manual uploads.",
    fields: [
      { key: "maxFileSizeMb", label: "Max file size (MB)", type: "number", min: 1, max: 200 },
      { key: "maxFilesPerRequest", label: "Max files per upload request", type: "number", min: 1, max: 200, hint: "The upload page chunks large batches automatically" },
    ],
  },
  {
    title: "OCR",
    description: "OCR runs automatically when a file has no usable text layer (images, scanned PDFs).",
    fields: [
      { key: "ocrMinTextChars", label: "Min text chars before OCR fallback", type: "number", min: 0, max: 100000 },
      { key: "ocrMaxPages", label: "Max pages to OCR per PDF", type: "number", min: 1, max: 50 },
      { key: "ocrLanguages", label: "OCR languages (Tesseract codes, e.g. eng or eng+hin)", type: "text" },
    ],
  },
  {
    title: "Google Drive",
    description: "Folder selection happens on the Google Drive page; this sets the default and the polling interval.",
    fields: [
      { key: "driveSyncIntervalMinutes", label: "Polling interval (minutes)", type: "number", min: 1, max: 1440, hint: "Applied when the worker restarts" },
      { key: "driveFolderId", label: "Default Drive folder ID", type: "text", hint: "Pre-selected after connecting if no folder is chosen" },
    ],
  },
  {
    title: "Google Sheets",
    description: "Leave the spreadsheet ID blank to create a new spreadsheet per export; set it to append a new tab to an existing one.",
    fields: [{ key: "sheetsSpreadsheetId", label: "Spreadsheet ID", type: "text" }],
  },
];

export function SettingsForm({ isAdmin }: { isAdmin: boolean }) {
  const { data, mutate } = useSWR<SettingsResponse>("/api/settings", fetcher);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (data) setForm(Object.fromEntries(Object.entries(data.settings).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)])));
  }, [data]);

  if (!data) return <div className="card p-6 text-sm text-gray-500">Loading…</div>;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        const original = data.settings[k];
        if (typeof original === "number") patch[k] = Number(v);
        else if (original === null || k === "driveFolderId" || k === "sheetsSpreadsheetId") patch[k] = v.trim() ? v.trim() : null;
        else patch[k] = v;
      }
      await api("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
      await mutate();
      setMsg({ ok: true, text: "Settings saved." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const e = data.env;
  const Chip = ({ ok, label }: { ok: boolean; label: string }) => (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
      {ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {label}
    </span>
  );

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-gray-900">Environment status</h2>
        <p className="mt-1 text-xs text-gray-500">Secrets are read from .env only and are never displayed or stored in the database.</p>
        <div className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <Env k="LLM" v={`${e.llm.provider} · ${e.llm.model} · ${e.llm.baseUrl}`} chip={<Chip ok={e.llm.apiKeyConfigured} label={e.llm.apiKeyConfigured ? "API key set" : "LLM_API_KEY missing"} />} />
          <Env k="Google OAuth" v={e.google.redirectUri} chip={<Chip ok={e.google.clientConfigured} label={e.google.clientConfigured ? "Client configured" : "GOOGLE_CLIENT_ID/SECRET missing"} />} />
          {/* Configured and in-force can differ when a driver cannot be honoured
              here, and "where do uploads actually go" is the question worth
              answering on this page. */}
          <Env
            k="Storage"
            v={
              e.storage.effectiveDriver === e.storage.driver
                ? `${e.storage.driver}${e.storage.bucket ? ` · ${e.storage.bucket}` : ""}`
                : `${e.storage.effectiveDriver} (configured: ${e.storage.driver})`
            }
            chip={
              e.storage.effectiveDriver === e.storage.driver ? (
                <Chip ok label="Ready" />
              ) : (
                <Chip ok={false} label="Substituted" />
              )
            }
          />
          <Env k="Queue" v={`Redis · concurrency ${e.queue.workerConcurrency}`} chip={<Chip ok={e.queue.redisConfigured} label={e.queue.redisConfigured ? "REDIS_URL set" : "REDIS_URL missing"} />} />
          <Env k="OCR" v={`${e.ocr.provider} · ${e.ocr.languages}`} chip={<Chip ok label="Local" />} />
          <Env k="Drive webhooks" v={e.appUrl} chip={<Chip ok={e.google.webhooksEnabled} label={e.google.webhooksEnabled ? "Enabled (HTTPS)" : "Polling only (HTTP)"} />} />
        </div>
      </div>

      {SECTIONS.map((s) => (
        <div key={s.title} className="card p-5">
          <h2 className="text-sm font-semibold text-gray-900">{s.title}</h2>
          <p className="mt-1 text-xs text-gray-500">{s.description}</p>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            {s.fields.map((f) => (
              <div key={f.key}>
                <label className="label">{f.label}</label>
                {f.type === "select" ? (
                  <select className="input" value={form[f.key] ?? ""} disabled={!isAdmin} onChange={(ev) => setForm((x) => ({ ...x, [f.key]: ev.target.value }))}>
                    {(f.key === "llmPromptVersion" ? data.promptVersions : f.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    type={f.type}
                    step={f.step}
                    min={f.min}
                    max={f.max}
                    value={form[f.key] ?? ""}
                    disabled={!isAdmin}
                    onChange={(ev) => setForm((x) => ({ ...x, [f.key]: ev.target.value }))}
                  />
                )}
                {f.hint && <div className="mt-1 text-[11px] text-gray-500">{f.hint}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={!isAdmin || saving}>
          <Save size={14} /> {saving ? "Saving…" : "Save settings"}
        </button>
        {!isAdmin && <span className="text-xs text-gray-500">Only admins can change settings.</span>}
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

function Env({ k, v, chip }: { k: string; v: string; chip: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-100 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{k}</span>
        {chip}
      </div>
      <div className="mt-1 break-all text-xs text-gray-700">{v}</div>
    </div>
  );
}
