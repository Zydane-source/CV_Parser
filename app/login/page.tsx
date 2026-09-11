"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Eye, EyeOff, FileText, Loader2, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { api } from "@/lib/client/api";

/**
 * Sign-in.
 *
 * A split layout: the form on the left at a comfortable reading width, and a
 * brand panel on the right that appears only when there is room for it. The
 * panel states what the product does — the previous page showed a logo and two
 * fields, which tells a first-time viewer nothing about what they are signing
 * in to.
 *
 * Only what the backend supports appears here. There is no "remember me",
 * because the session length is fixed server-side, and no social provider,
 * because none is implemented. Offering either would be a control that lies.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const expired = params.get("next") !== null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      const next = params.get("next");
      router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white shadow-[var(--shadow-raised)]">
          <FileText size={21} />
        </span>
        <span>
          <span className="block text-base font-semibold tracking-[-0.01em] text-ink-900">CV Parser</span>
          <span className="block text-xs text-ink-500">Recruitment intake</span>
        </span>
      </div>

      <h1 className="text-[1.5rem] font-semibold tracking-[-0.02em] text-ink-900">Sign in</h1>
      <p className="mt-1.5 text-sm text-ink-500">Manage and process candidate resumes effortlessly.</p>

      {/* Arriving with a ?next= means a protected route bounced them. Saying so
          is kinder than an unexplained login screen. */}
      {expired && !error && (
        <div role="status" className="mt-5 flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[0.8125rem] text-amber-900">
          <AlertCircle size={16} className="mt-px flex-shrink-0 text-amber-600" aria-hidden />
          <span>Your session has ended. Sign in again to continue where you left off.</span>
        </div>
      )}

      <form onSubmit={submit} className="mt-6" noValidate>
        <div className="mb-4">
          <label htmlFor="identifier" className="label">
            Email or username
          </label>
          <input
            id="identifier"
            className="field"
            type="text"
            autoComplete="username"
            autoFocus
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="mb-5">
          <label htmlFor="password" className="label">
            Password
          </label>
          <div className="relative">
            <input
              id="password"
              className="field pr-11"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {error && (
          <div id="login-error" role="alert" className="mb-5 flex gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[0.8125rem] text-red-800">
            <AlertCircle size={16} className="mt-px flex-shrink-0 text-red-600" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" className="btn-primary btn-lg w-full" disabled={busy}>
          {busy ? (
            <>
              <Loader2 size={16} className="animate-spin" /> Signing in…
            </>
          ) : (
            "Sign in"
          )}
        </button>
      </form>

      <p className="mt-6 text-center text-xs text-ink-400">
        Accounts are created by an administrator. Contact yours if you need access.
      </p>
    </div>
  );
}

const POINTS = [
  { icon: Zap, title: "Parsed in milliseconds", body: "Name, phone and applied role extracted locally — no queue, no per-CV cost." },
  { icon: ShieldCheck, title: "Candidate data stays put", body: "CV content is never sent to an external AI service. Extraction runs in-process." },
  { icon: Sparkles, title: "Confidence you can act on", body: "Every field is scored, and anything uncertain is flagged for review rather than guessed." },
];

export default function LoginPage() {
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <div className="flex items-center justify-center px-6 py-12 sm:px-10">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>

      {/* Decorative and secondary: hidden below lg so a phone gets the form
          immediately rather than a wall of marketing above it. */}
      <aside className="relative hidden overflow-hidden bg-ink-900 lg:flex lg:flex-col lg:justify-center lg:px-14">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 22% 18%, #2f5bea 0, transparent 42%), radial-gradient(circle at 78% 82%, #1c3ca3 0, transparent 46%)",
          }}
        />
        <div className="relative max-w-md">
          <h2 className="text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-white">
            Turn a folder of resumes into a searchable candidate database.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-300">
            Upload in bulk or sync a Google Drive folder. Every CV is read, scored and filed — with the uncertain ones
            surfaced for a human instead of quietly guessed.
          </p>
          <ul className="mt-10 space-y-6">
            {POINTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-white/10 text-brand-200" aria-hidden>
                  <Icon size={17} />
                </span>
                <span>
                  <span className="block text-sm font-medium text-white">{title}</span>
                  <span className="mt-0.5 block text-[0.8125rem] leading-relaxed text-ink-400">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </main>
  );
}
