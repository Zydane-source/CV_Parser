"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { CalendarDays, ChevronDown, Cloud, FileText, Upload, X } from "lucide-react";
import { fetcher } from "@/lib/client/api";
import { Badge, EmptyState, Section, Skeleton, TableSkeleton, cx } from "@/components/ui";
import { StatusBadge } from "@/components/StatusBadge";

interface DayActivity {
  day: string;
  total: number;
  manual: number;
  drive: number;
  first: string;
  last: string;
}
interface ActivityResponse {
  tz: string;
  range: { from: string; to: string; total: number };
  summary: { allTime: number; last7Days: number; last30Days: number; lastFetchedAt: string | null };
  days: DayActivity[];
}
interface DayResponse {
  files: Array<{
    id: string;
    fileName: string;
    sourceType: "MANUAL" | "GOOGLE_DRIVE";
    status: string;
    createdAt: string;
    uploadedBy: { name: string } | null;
    candidate: { candidateName: string } | null;
  }>;
}

const RANGES = [
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
] as const;

/** YYYY-MM-DD for a Date in the browser's own zone. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + n));
}
const fmtDay = (day: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" }) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", opts);
};
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * CVs a client has fetched, by day — and, for any day, each CV with its time.
 *
 * Days are counted in the viewer's own time zone (sent to the server), so a CV
 * uploaded just after midnight lands on the date the reader expects.
 */
export function ClientActivity({ workspaceId }: { workspaceId: string }) {
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const today = ymd(new Date());
  const [preset, setPreset] = useState<string>("30");
  const [custom, setCustom] = useState({ from: addDays(today, -29), to: today });
  const [openDay, setOpenDay] = useState<string | null>(null);

  const from = preset === "custom" ? custom.from : addDays(today, -(Number(preset) - 1));
  const to = preset === "custom" ? custom.to : today;

  const { data, error, isLoading } = useSWR<ActivityResponse>(
    `/api/workspaces/${workspaceId}/activity?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}`,
    fetcher,
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Total CVs fetched" value={data?.summary.allTime} note="All time" />
        <Tile label="Last 7 days" value={data?.summary.last7Days} />
        <Tile label="Last 30 days" value={data?.summary.last30Days} />
        <Tile
          label="Last CV fetched"
          text={data ? (data.summary.lastFetchedAt ? fmtDateTime(data.summary.lastFetchedAt) : "Never") : undefined}
        />
      </div>

      <Section
        title="CVs fetched by date"
        description={data ? `${data.range.total} CV${data.range.total === 1 ? "" : "s"} between ${fmtDay(from, { day: "numeric", month: "short" })} and ${fmtDay(to, { day: "numeric", month: "short", year: "numeric" })} · times in ${tz}` : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="inline-flex rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-0.5" role="group" aria-label="Date range">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setPreset(r.key)}
                  aria-pressed={preset === r.key}
                  className={cx("rounded px-2.5 py-1 text-xs font-medium", preset === r.key ? "bg-brand-600 text-white" : "text-ink-600 hover:bg-ink-100")}
                >
                  {r.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPreset("custom")}
                aria-pressed={preset === "custom"}
                className={cx("inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium", preset === "custom" ? "bg-brand-600 text-white" : "text-ink-600 hover:bg-ink-100")}
              >
                <CalendarDays size={12} /> Custom
              </button>
            </div>
            {preset === "custom" && (
              <div className="flex items-center gap-1.5">
                <input type="date" className="input h-8 w-auto py-1 text-xs" max={custom.to} value={custom.from} aria-label="From" onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
                <span className="text-xs text-ink-400">to</span>
                <input type="date" className="input h-8 w-auto py-1 text-xs" min={custom.from} max={today} value={custom.to} aria-label="To" onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
              </div>
            )}
          </div>
        }
      >
        {isLoading ? (
          <div className="space-y-4 p-5">
            <Skeleton className="h-40 w-full" />
            <TableSkeleton rows={4} cols={5} />
          </div>
        ) : error ? (
          <EmptyState icon={<FileText size={20} />} title="Could not load activity" description="Refresh the page to try again." />
        ) : data && data.days.length === 0 ? (
          <EmptyState icon={<FileText size={20} />} title="No CVs fetched in this period" description="Try a longer date range." />
        ) : data ? (
          <>
            <DailyBars from={from} to={to} days={data.days} selected={openDay} onSelect={(d) => setOpenDay(openDay === d ? null : d)} />
            <div className="overflow-x-auto border-t border-[var(--border)]">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="text-right">CVs fetched</th>
                    <th className="text-right">Uploaded</th>
                    <th className="text-right">From Drive</th>
                    <th>First at</th>
                    <th>Last at</th>
                    <th className="w-10" aria-label="Details" />
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((d) => (
                    <DayRow key={d.day} d={d} open={openDay === d.day} onToggle={() => setOpenDay(openDay === d.day ? null : d.day)} workspaceId={workspaceId} tz={tz} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Section>
    </div>
  );
}

function Tile({ label, value, text, note }: { label: string; value?: number; text?: string; note?: string }) {
  const loading = value === undefined && text === undefined;
  return (
    <div className="card px-4 py-3.5">
      <div className="text-meta">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <div className={cx("numeric mt-1 font-semibold text-ink-900", text ? "text-base leading-7" : "text-[1.625rem] leading-8")}>
          {text ?? value!.toLocaleString("en-IN")}
        </div>
      )}
      {note && <div className="mt-0.5 text-xs text-ink-400">{note}</div>}
    </div>
  );
}

function DayRow({ d, open, onToggle, workspaceId, tz }: { d: DayActivity; open: boolean; onToggle: () => void; workspaceId: string; tz: string }) {
  return (
    <>
      <tr data-selected={open} className="cursor-pointer" onClick={onToggle}>
        <td className="whitespace-nowrap font-medium text-ink-900">{fmtDay(d.day)}</td>
        <td className="numeric text-right font-semibold text-ink-900">{d.total}</td>
        <td className="numeric text-right">{d.manual}</td>
        <td className="numeric text-right">{d.drive}</td>
        <td className="numeric whitespace-nowrap text-ink-500">{fmtTime(d.first)}</td>
        <td className="numeric whitespace-nowrap text-ink-500">{fmtTime(d.last)}</td>
        <td>
          <button
            type="button"
            className="btn-tertiary btn-sm px-1.5"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} CVs fetched on ${fmtDay(d.day)}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <ChevronDown size={14} className={cx("transition-transform", open && "rotate-180")} />
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="h-auto bg-ink-50/70 p-0">
            <DayDetail workspaceId={workspaceId} day={d.day} tz={tz} onClose={onToggle} />
          </td>
        </tr>
      )}
    </>
  );
}

function DayDetail({ workspaceId, day, tz, onClose }: { workspaceId: string; day: string; tz: string; onClose: () => void }) {
  const { data, isLoading, error } = useSWR<DayResponse>(
    `/api/workspaces/${workspaceId}/activity/day?date=${day}&tz=${encodeURIComponent(tz)}`,
    fetcher,
  );
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-ink-700">Every CV fetched on {fmtDay(day)}</span>
        <button type="button" onClick={onClose} className="btn-tertiary btn-sm px-1.5" aria-label="Close">
          <X size={14} />
        </button>
      </div>
      {isLoading ? (
        <TableSkeleton rows={3} cols={5} />
      ) : error ? (
        <p className="py-3 text-sm text-red-700">Could not load this day.</p>
      ) : (
        <div className="max-h-96 overflow-auto rounded-lg border border-[var(--border)] bg-white">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>File</th>
                <th>Candidate</th>
                <th>Source</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.files.map((f) => (
                <tr key={f.id}>
                  <td className="numeric whitespace-nowrap text-ink-900">{fmtTime(f.createdAt)}</td>
                  <td className="max-w-[16rem] truncate" title={f.fileName}>{f.fileName}</td>
                  <td className="whitespace-nowrap">{f.candidate?.candidateName ?? <span className="text-ink-400">—</span>}</td>
                  <td className="whitespace-nowrap">
                    {f.sourceType === "GOOGLE_DRIVE" ? (
                      <Badge icon={<Cloud size={12} />}>Drive</Badge>
                    ) : (
                      <Badge icon={<Upload size={12} />}>{f.uploadedBy ? `Upload · ${f.uploadedBy.name}` : "Upload"}</Badge>
                    )}
                  </td>
                  <td><StatusBadge status={f.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * One bar per calendar day in the range, including the empty ones — a gap in
 * activity is information, and skipping zero days would make a quiet week look
 * like a busy one. Hovering a bar shows the split; clicking opens that day.
 */
function DailyBars({ from, to, days, selected, onSelect }: { from: string; to: string; days: DayActivity[]; selected: string | null; onSelect: (day: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const byDay = new Map(days.map((d) => [d.day, d]));
  const series: Array<{ day: string; d: DayActivity | undefined }> = [];
  for (let day = from; day <= to && series.length < 400; day = addDays(day, 1)) series.push({ day, d: byDay.get(day) });

  const max = Math.max(1, ...days.map((d) => d.total));
  // A round axis top, so the gridlines land on numbers people read at a glance.
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : max <= 100 ? 20 : Math.ceil(max / 5 / 50) * 50;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);

  const W = 760;
  const H = 180;
  const padL = 34;
  const padB = 22;
  const plotW = W - padL - 6;
  const plotH = H - padB - 8;
  const slot = plotW / series.length;
  const barW = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number) => 8 + plotH - (v / top) * plotH;
  const labelEvery = Math.ceil(series.length / 10);
  const active = hover ?? selected;
  // The tooltip follows the pointer only. A selected day is already marked in
  // the table beneath, and a pinned tooltip sat on top of the bar it described.
  const hoverIdx = series.findIndex((s) => s.day === hover);
  const hoverD = hoverIdx >= 0 ? series[hoverIdx] : null;
  const hoverFrac = hoverIdx >= 0 ? (padL + hoverIdx * slot + slot / 2) / W : 0;

  return (
    <div className="relative px-5 pb-3 pt-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="CVs fetched per day; the table below lists the same figures">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - 6} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="#64748b" className="numeric">
              {t}
            </text>
          </g>
        ))}
        {series.map(({ day, d }, i) => {
          const x = padL + i * slot + (slot - barW) / 2;
          const v = d?.total ?? 0;
          const h = v ? Math.max(3, (v / top) * plotH) : 0;
          const r = Math.min(4, barW / 2, h);
          const isActive = day === active;
          return (
            <g key={day}>
              {h > 0 && (
                <path
                  d={`M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + barW - r} Q${x + barW},${y(0) - h} ${x + barW},${y(0) - h + r} V${y(0)} Z`}
                  fill={isActive ? "#1e40af" : "#1d4ed8"}
                  opacity={active && !isActive ? 0.55 : 1}
                />
              )}
              {/* The hit target is the whole column, not the bar, so small days
                  and empty days can still be hovered and selected. */}
              <rect
                x={padL + i * slot}
                y={8}
                width={slot}
                height={plotH}
                fill="transparent"
                style={{ cursor: v ? "pointer" : "default" }}
                onMouseEnter={() => setHover(day)}
                onMouseLeave={() => setHover(null)}
                onClick={() => v && onSelect(day)}
              />
              {i % labelEvery === 0 && (
                <text x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="#64748b">
                  {fmtDay(day, { day: "numeric", month: "short" })}
                </text>
              )}
            </g>
          );
        })}
        <line x1={padL} x2={W - 6} y1={y(0)} y2={y(0)} stroke="#cbd5e1" strokeWidth={1} />
      </svg>

      {hoverD && (
        <div
          className={cx(
            "pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-xs shadow-[var(--shadow-raised)]",
            // Kept inside the card: centred on the bar, but anchored to the side
            // with room near either edge.
            hoverFrac > 0.75 ? "-translate-x-[calc(100%+10px)]" : hoverFrac < 0.25 ? "translate-x-[10px]" : "-translate-x-1/2 -translate-y-1",
          )}
          style={{ left: `calc(1.25rem + (100% - 2.5rem) * ${hoverFrac})` }}
        >
          <div className="font-semibold text-ink-900">{fmtDay(hoverD.day)}</div>
          <div className="numeric mt-1 text-ink-700">
            <span className="font-semibold text-ink-900">{hoverD.d?.total ?? 0}</span> CVs fetched
          </div>
          {hoverD.d && (
            <div className="numeric mt-0.5 text-ink-500">
              {hoverD.d.manual} uploaded · {hoverD.d.drive} from Drive
            </div>
          )}
        </div>
      )}
    </div>
  );
}
