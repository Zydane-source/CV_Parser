import clsx from "clsx";

/**
 * Extraction confidence.
 *
 * The design system bands confidence at 90 and 70 and renders it as a pill with
 * a leading dot: high, review-needed, low. Those bands are *display* only — the
 * decision about whether a CV actually needs a human still comes from the
 * configurable `confidenceThreshold` on the server, which drives
 * `reviewRequired` and the job status. Letting a visual band feed back into that
 * would change behaviour under the guise of a retheme.
 *
 * Every pill carries a word as well as a colour and a dot: about one man in
 * twelve cannot separate the red and green states reliably.
 */
type Band = "high" | "medium" | "low";

function bandFor(value: number): Band {
  if (value >= 0.9) return "high";
  if (value >= 0.7) return "medium";
  return "low";
}

const BAND_PILL: Record<Band, string> = {
  high: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  medium: "bg-amber-50 text-amber-800 ring-amber-200",
  low: "bg-red-50 text-red-800 ring-red-200",
};

const BAND_DOT: Record<Band, string> = {
  high: "bg-emerald-600",
  medium: "bg-amber-600",
  low: "bg-red-600",
};

const BAND_LABEL: Record<Band, string> = { high: "High", medium: "Review", low: "Low" };

const BAND_BAR: Record<Band, string> = {
  high: "bg-emerald-600",
  medium: "bg-amber-600",
  low: "bg-red-600",
};

/** Compact pill: the band, then the figure. Used in dense candidate rows. */
export function ConfidencePill({ value, showPercent = true }: { value: number; showPercent?: boolean }) {
  const v = Math.max(0, Math.min(1, value));
  const band = bandFor(v);
  const pct = Math.round(v * 100);
  return (
    <span
      className={clsx(
        "inline-flex h-[22px] items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-label-xs ring-1 ring-inset",
        BAND_PILL[band],
      )}
      title={`${pct}% confidence`}
    >
      <span className={clsx("h-1.5 w-1.5 flex-shrink-0 rounded-full", BAND_DOT[band])} aria-hidden />
      {showPercent && <span className="numeric">{pct}%</span>}
      {BAND_LABEL[band]}
    </span>
  );
}

/**
 * Labelled meter, for the detail view where per-field scores are compared.
 * `threshold` still comes from settings so the marker reflects the real review
 * boundary rather than the display bands.
 */
export function ConfidenceBar({ value, threshold = 0.75, label }: { value: number; threshold?: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value));
  const pct = Math.round(v * 100);
  const band = bandFor(v);

  if (!label) {
    return <ConfidencePill value={v} />;
  }

  return (
    <div className="min-w-[140px]">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-500">{label}</span>
        <span className={clsx("text-xs font-semibold numeric", band === "high" ? "text-emerald-700" : band === "medium" ? "text-amber-700" : "text-red-700")}>
          {pct}%
        </span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-ink-200">
        <div className={clsx("h-full rounded-full transition-[width] duration-300", BAND_BAR[band])} style={{ width: `${pct}%` }} />
        {/* Where the server would actually flag this for review. */}
        <span
          className="absolute top-0 h-full w-px bg-ink-400/70"
          style={{ left: `${Math.round(Math.max(0, Math.min(1, threshold)) * 100)}%` }}
          aria-hidden
        />
      </div>
    </div>
  );
}
