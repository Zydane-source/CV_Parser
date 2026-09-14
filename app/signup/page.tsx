"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, Eye, EyeOff, Loader2, MailCheck } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";

/**
 * Create account.
 *
 * Two steps on one page. The first collects who is asking; submitting it emails
 * a code to the CV Parser team rather than to the applicant, so the page says so
 * plainly — otherwise people would go looking in their own inbox for a code that
 * is never coming.
 */
type Pending = { requestId: string; emailed?: boolean; sentTo: string | null; expiresAt: string };

function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const d = err.details as { fieldErrors?: Record<string, string[]> } | undefined;
  return Object.fromEntries(Object.entries(d?.fieldErrors ?? {}).map(([k, v]) => [k, v[0]]));
}

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", companyName: "", email: "", password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"request" | "verify" | "resend" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("request");
    setError(null);
    setErrors({});
    try {
      setPending(await api<Pending>("/api/auth/signup", { method: "POST", body: JSON.stringify(form) }));
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      if (!Object.keys(fe).length) setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pending) return;
    setBusy("verify");
    setError(null);
    setNotice(null);
    try {
      await api("/api/auth/signup/verify", { method: "POST", body: JSON.stringify({ requestId: pending.requestId, code }) });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    if (!pending) return;
    setBusy("resend");
    setError(null);
    setNotice(null);
    try {
      setPending(await api<Pending>("/api/auth/signup/resend", { method: "POST", body: JSON.stringify({ requestId: pending.requestId }) }));
      setCode("");
      setNotice("A new code has been sent. The previous one no longer works.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const input = (key: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="mb-4">
      <label htmlFor={`su-${key}`} className="label">{label}</label>
      <input
        id={`su-${key}`}
        className="field"
        required
        value={form[key]}
        aria-invalid={errors[key] ? true : undefined}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        {...props}
      />
      {errors[key] && <p className="field-error">{errors[key]}</p>}
    </div>
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--surface-sunken,#f8fafc)] px-6 py-12">
      <div className="w-full max-w-md">
        <Image src="/logo-full.png" alt="CV Parser — Recruit smarter, faster" width={320} height={286} className="mb-8 h-auto w-[180px]" priority />

        <div className="card p-6 sm:p-8">
          {!pending ? (
            <>
              <h1 className="text-[1.375rem] font-semibold tracking-[-0.02em] text-ink-900">Create account</h1>
              <p className="mt-1.5 text-sm text-ink-500">
                Set up a workspace for your company. Your candidates and CVs stay private to your team.
              </p>

              <form onSubmit={request} className="mt-6" noValidate>
                {input("name", "Your name", { autoComplete: "name", autoFocus: true, maxLength: 80 })}
                {input("companyName", "Company name", { autoComplete: "organization", maxLength: 80 })}
                {input("email", "Work email", { type: "email", autoComplete: "email", maxLength: 160 })}
                <div className="mb-5">
                  <label htmlFor="su-password" className="label">Password</label>
                  <div className="relative">
                    <input
                      id="su-password"
                      className="field pr-11"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      required
                      minLength={10}
                      value={form.password}
                      aria-invalid={errors.password ? true : undefined}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {errors.password ? <p className="field-error">{errors.password}</p> : <p className="hint">At least 10 characters.</p>}
                </div>

                {error && <ErrorBox message={error} />}

                <button type="submit" className="btn-primary btn-lg w-full" disabled={busy !== null}>
                  {busy === "request" ? <><Loader2 size={16} className="animate-spin" /> Sending code…</> : "Continue"}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600" aria-hidden>
                <MailCheck size={20} />
              </div>
              {pending.emailed === false ? (
                <>
                  <h1 className="text-[1.375rem] font-semibold tracking-[-0.02em] text-ink-900">Request received</h1>
                  <p className="mt-2 text-sm leading-relaxed text-ink-600">
                    Your account request for <strong className="text-ink-900">{form.companyName}</strong> is with the CV Parser team
                    for approval. Once it is approved, sign in with <strong className="text-ink-900">{form.email}</strong> and the
                    password you chose.
                  </p>
                  <Link href="/login" className="btn-primary btn-lg mt-6 w-full">Go to sign in</Link>
                </>
              ) : (
              <>
              <h1 className="text-[1.375rem] font-semibold tracking-[-0.02em] text-ink-900">Enter your verification code</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                New accounts are approved by the CV Parser team. We have sent a 6-digit code to{" "}
                <strong className="numeric text-ink-900">{pending.sentTo}</strong> — once they share it with you, enter it
                here. It is valid for 15 minutes.
              </p>
              <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-500">
                If the team approves your request directly instead, no code is needed — just{" "}
                <Link href="/login" className="font-medium text-brand-700 hover:underline">sign in</Link> with the email and password you chose.
              </p>

              <form onSubmit={verify} className="mt-6" noValidate>
                <label htmlFor="su-code" className="label">Verification code</label>
                <input
                  id="su-code"
                  className="field numeric text-center text-2xl tracking-[0.5em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  placeholder="••••••"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />

                {notice && !error && <p role="status" className="mt-3 text-[0.8125rem] text-emerald-700">{notice}</p>}
                <div className="mt-5">{error && <ErrorBox message={error} />}</div>

                <button type="submit" className="btn-primary btn-lg w-full" disabled={code.length !== 6 || busy !== null}>
                  {busy === "verify" ? <><Loader2 size={16} className="animate-spin" /> Verifying…</> : "Verify and create account"}
                </button>
              </form>

              <div className="mt-4 flex items-center justify-between text-[0.8125rem]">
                <button type="button" className="btn-tertiary btn-sm px-1" onClick={() => { setPending(null); setCode(""); setError(null); }}>
                  <ArrowLeft size={14} /> Change details
                </button>
                <button type="button" className="btn-tertiary btn-sm px-1" onClick={resend} disabled={busy !== null}>
                  {busy === "resend" ? "Sending…" : "Send a new code"}
                </button>
              </div>
              </>
              )}
            </>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-ink-500">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link>
        </p>
      </div>
    </main>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="mb-5 flex gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[0.8125rem] text-red-800">
      <AlertCircle size={16} className="mt-px flex-shrink-0 text-red-600" aria-hidden />
      <span>{message}</span>
    </div>
  );
}
