import * as React from "react";
import { AlertTriangle, Check, Info, X, XCircle } from "lucide-react";

/**
 * Shared UI primitives.
 *
 * These exist so a screen never decides what a badge or an empty state looks
 * like. Every one is a plain server-compatible component with no state — the
 * interactive pieces stay in the feature components that own the data, so
 * nothing here forces a page to become a client component.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */
/* Page scaffolding                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every page opens the same way: what this is, what it is for, and the one
 * action most people came to take. Consistency here is most of what makes a
 * collection of screens feel like a single product.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-page-title">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-body text-ink-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-section-title">{title}</h2>}
            {description && <p className="mt-0.5 text-meta">{description}</p>}
          </div>
          {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-700 ring-ink-200",
  brand: "bg-brand-50 text-brand-700 ring-brand-100",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  warning: "bg-amber-50 text-amber-800 ring-amber-100",
  danger: "bg-red-50 text-red-700 ring-red-100",
  info: "bg-sky-50 text-sky-700 ring-sky-100",
};

/**
 * A badge always carries a word. Colour reinforces the meaning; it never
 * carries it alone, because roughly one in twelve men cannot separate the
 * red and green states reliably.
 */
export function Badge({
  tone = "neutral",
  icon,
  children,
  className,
}: {
  tone?: Tone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** A small coloured dot plus a label, for dense rows where a badge is too heavy. */
export function StatusDot({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  const dot: Record<Tone, string> = {
    neutral: "bg-ink-400",
    brand: "bg-brand-500",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    danger: "bg-red-500",
    info: "bg-sky-500",
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-700">
      <span className={cx("h-1.5 w-1.5 flex-shrink-0 rounded-full", dot[tone])} aria-hidden />
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** Deterministic tint from the name, so the same person looks the same everywhere. */
const AVATAR_TINTS = [
  "bg-brand-50 text-brand-700",
  "bg-emerald-50 text-emerald-700",
  "bg-amber-50 text-amber-700",
  "bg-sky-50 text-sky-700",
  "bg-violet-50 text-violet-700",
  "bg-rose-50 text-rose-700",
];

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const clean = (name || "").trim();
  const initials =
    clean
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?";
  let hash = 0;
  for (let i = 0; i < clean.length; i++) hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
  const dims = { sm: "h-7 w-7 text-[0.625rem]", md: "h-9 w-9 text-xs", lg: "h-12 w-12 text-sm" }[size];
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex flex-shrink-0 items-center justify-center rounded-full font-semibold",
        dims,
        AVATAR_TINTS[hash % AVATAR_TINTS.length],
      )}
    >
      {initials}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden />;
}

/**
 * A table skeleton matching the real column count, so the page does not reflow
 * when data arrives. That reflow is what makes an otherwise fast app feel
 * unsteady.
 */
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="px-4 py-2" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-[var(--border)] py-3.5 last:border-b-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cx("h-3.5", c === 0 ? "w-[22%]" : c === cols - 1 ? "w-[10%]" : "w-[15%]")} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty and error states                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An empty table with no explanation reads as a bug. Say why it is empty and
 * offer the action that fills it.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-ink-100 text-ink-500" aria-hidden>
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", description, action }: { title?: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-red-600" aria-hidden>
        <XCircle size={20} />
      </div>
      <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
      {/* Deliberately not the raw error: internal text helps nobody here and can
          leak schema or paths. The actionable version is logged server-side. */}
      <p className="mt-1.5 max-w-sm text-sm text-ink-500">{description ?? "Please try again, or contact your administrator if it keeps happening."}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Inline messaging                                                            */
/* -------------------------------------------------------------------------- */

const ALERT_STYLES: Record<Exclude<Tone, "neutral" | "brand">, { wrap: string; icon: React.ReactNode }> = {
  success: { wrap: "border-emerald-200 bg-emerald-50 text-emerald-900", icon: <Check size={16} className="text-emerald-600" /> },
  warning: { wrap: "border-amber-200 bg-amber-50 text-amber-900", icon: <AlertTriangle size={16} className="text-amber-600" /> },
  danger: { wrap: "border-red-200 bg-red-50 text-red-900", icon: <XCircle size={16} className="text-red-600" /> },
  info: { wrap: "border-sky-200 bg-sky-50 text-sky-900", icon: <Info size={16} className="text-sky-600" /> },
};

export function Alert({
  tone = "info",
  title,
  children,
  action,
  onDismiss,
}: {
  tone?: Exclude<Tone, "neutral" | "brand">;
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
}) {
  const s = ALERT_STYLES[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex gap-3 rounded-xl border px-4 py-3", s.wrap)}>
      <span className="mt-0.5 flex-shrink-0" aria-hidden>
        {s.icon}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cx(title && "mt-0.5", "text-[0.8125rem] leading-relaxed opacity-90")}>{children}</div>}
        {action && <div className="mt-2.5">{action}</div>}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="-mr-1 -mt-1 flex-shrink-0 rounded-md p-1 opacity-60 transition-opacity hover:opacity-100">
          <X size={15} />
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

/** Key/value row used by detail panels. */
export function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] py-2.5 last:border-b-0">
      <dt className="flex-shrink-0 text-xs font-medium text-ink-500">{k}</dt>
      <dd className="min-w-0 text-right text-sm text-ink-800">{v}</dd>
    </div>
  );
}

/** CSS-only tooltip. No library, no portal, no hydration cost. */
export function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-ink-900 px-2 py-1 text-xs font-medium text-white shadow-[var(--shadow-overlay)] group-hover/tt:block"
      >
        {label}
      </span>
    </span>
  );
}
