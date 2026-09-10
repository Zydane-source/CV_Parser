import clsx from "clsx";

export function ConfidenceBar({ value, threshold = 0.75, label }: { value: number; threshold?: number; label?: string }) {
  const p = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = value >= threshold ? "bg-emerald-500" : value >= 0.5 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="min-w-[110px]">
      {label && (
        <div className="mb-0.5 flex justify-between text-[11px] text-gray-500">
          <span>{label}</span>
          <span className={clsx("font-medium", value >= threshold ? "text-emerald-700" : "text-amber-700")}>{p}%</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
          <div className={clsx("h-full rounded-full", color)} style={{ width: `${p}%` }} />
        </div>
        {!label && <span className="w-9 text-right text-xs tabular-nums text-gray-700">{p}%</span>}
      </div>
    </div>
  );
}
