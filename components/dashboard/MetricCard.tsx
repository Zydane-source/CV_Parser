import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cx, type Tone } from "@/components/ui";

/**
 * A dashboard metric.
 *
 * Two deliberate choices. The number carries the tone, not the whole card — five
 * tinted panels in a row compete with each other and with the table below, and
 * none of them wins. And a metric that corresponds to a filtered view links
 * there, because the question after "8 need review" is always "which eight?".
 */
const VALUE_TONE: Record<Tone, string> = {
  neutral: "text-ink-900",
  brand: "text-brand-700",
  success: "text-emerald-600",
  warning: "text-amber-600",
  danger: "text-red-600",
  info: "text-sky-600",
};

const ICON_TONE: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-500",
  brand: "bg-brand-50 text-brand-600",
  success: "bg-emerald-50 text-emerald-600",
  warning: "bg-amber-50 text-amber-600",
  danger: "bg-red-50 text-red-600",
  info: "bg-sky-50 text-sky-600",
};

export function MetricCard({
  label,
  value,
  icon: Icon,
  tone = "neutral",
  hint,
  href,
}: {
  label: string;
  value: number | string;
  icon?: LucideIcon;
  tone?: Tone;
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-ink-500">{label}</span>
        {Icon && (
          <span className={cx("flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg", ICON_TONE[tone])} aria-hidden>
            <Icon size={15} />
          </span>
        )}
      </div>
      <div className={cx("mt-2.5 text-metric", VALUE_TONE[tone])}>
        {typeof value === "number" ? value.toLocaleString("en-IN") : value}
      </div>
      {/* Reserved whether or not a hint exists, so cards in a row stay the same
          height and the grid does not look ragged. */}
      <div className="mt-1 min-h-[1rem] text-[0.6875rem] leading-4 text-ink-500">{hint ?? ""}</div>
    </>
  );

  if (href) {
    return (
      <Link href={href} className="card-interactive group block p-4 focus-visible:ring-2 focus-visible:ring-brand-500/30">
        {body}
        <span className="mt-1 inline-block text-[0.6875rem] font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
          View →
        </span>
      </Link>
    );
  }
  return (
    <div className="card p-4">
      {body}
      <span className="mt-1 inline-block h-4" aria-hidden />
    </div>
  );
}
