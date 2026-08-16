// QuickHack object: Sale grade badge with the same color rules used in the legacy Google Sheet.
import * as React from "react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { cn } from "@/quickhack_shared/core/utils";

const saleGradeClassNames: Record<string, string> = {
  A: "border-blue-200 bg-blue-50 text-blue-700",
  "A-": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "B+": "border-orange-200 bg-orange-50 text-orange-700",
  B: "border-red-200 bg-red-50 text-red-700",
};

export function normalizeSaleGrade(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

export function saleGradeBadgeClassName(value: unknown) {
  return (
    saleGradeClassNames[normalizeSaleGrade(value)] ??
    "border-zinc-200 bg-zinc-50 text-zinc-700"
  );
}

export function SaleGradeBadge({
  value,
  className,
  emptyText = "-",
}: {
  value: string | number | null | undefined;
  className?: string;
  emptyText?: React.ReactNode;
}) {
  const label = normalizeSaleGrade(value);

  if (!label) {
    return <span className={cn("text-muted-foreground", className)}>{emptyText}</span>;
  }

  return (
    <Badge
      variant="outline"
      className={cn(
        "min-w-10 justify-center px-2 font-bold tabular-nums",
        saleGradeBadgeClassName(label),
        className
      )}
    >
      {label}
    </Badge>
  );
}
