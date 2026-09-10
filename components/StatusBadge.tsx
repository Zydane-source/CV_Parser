import clsx from "clsx";
import { CheckCircle2, Loader2, AlertTriangle, XCircle, Clock, MinusCircle } from "lucide-react";
import { STATUS_LABEL } from "@/lib/client/format";

const STYLES: Record<string, { cls: string; Icon: typeof CheckCircle2; spin?: boolean }> = {
  PENDING: { cls: "bg-gray-100 text-gray-700", Icon: Clock },
  PROCESSING: { cls: "bg-blue-50 text-blue-700", Icon: Loader2, spin: true },
  PROCESSED: { cls: "bg-emerald-50 text-emerald-700", Icon: CheckCircle2 },
  NEEDS_REVIEW: { cls: "bg-amber-50 text-amber-700", Icon: AlertTriangle },
  FAILED: { cls: "bg-red-50 text-red-700", Icon: XCircle },
  SKIPPED: { cls: "bg-gray-100 text-gray-500", Icon: MinusCircle },
};

export function StatusBadge({ status, size = "sm" }: { status: string; size?: "sm" | "md" }) {
  const s = STYLES[status] ?? STYLES.PENDING;
  const Icon = s.Icon;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        s.cls,
      )}
    >
      <Icon size={size === "sm" ? 12 : 14} className={s.spin ? "animate-spin" : undefined} />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
