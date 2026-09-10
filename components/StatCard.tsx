import clsx from "clsx";
import type { LucideIcon } from "lucide-react";

export function StatCard({ label, value, icon: Icon, tone = "default", hint }: { label: string; value: number | string; icon?: LucideIcon; tone?: "default" | "success" | "warning" | "danger" | "info"; hint?: string }) {
  const tones = {
    default: "text-gray-900",
    success: "text-emerald-700",
    warning: "text-amber-700",
    danger: "text-red-700",
    info: "text-blue-700",
  };
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
        {Icon && <Icon size={16} className="text-gray-400" />}
      </div>
      <div className={clsx("mt-2 text-3xl font-semibold tabular-nums", tones[tone])}>{typeof value === "number" ? value.toLocaleString("en-IN") : value}</div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}
