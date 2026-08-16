// QuickHack note: 목록 상단의 핵심 건수와 상태를 동일한 요약 셀과 스트립 구조로 표시합니다.
import * as React from "react";
import { cn } from "@/quickhack_shared/core/utils";

type SummaryMetricIcon = React.ComponentType<{ className?: string }>;

export type SummaryStripProps = React.HTMLAttributes<HTMLDivElement>;

export function SummaryStrip({
  className,
  children,
  ...props
}: SummaryStripProps) {
  return (
    <div
      className={cn(
        "grid shrink-0 overflow-hidden rounded-md border bg-popover",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface SummaryMetricProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  icon: SummaryMetricIcon;
  label: React.ReactNode;
  value: React.ReactNode;
  valueClassName?: string;
}

export function SummaryMetric({
  icon: Icon,
  label,
  value,
  className,
  valueClassName,
  ...props
}: SummaryMetricProps) {
  return (
    <div
      className={cn(
        "flex min-h-16 items-center gap-3 border-r px-4 last:border-r-0",
        className
      )}
      {...props}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div
          className={cn(
            "truncate text-xl font-semibold tabular-nums",
            valueClassName
          )}
        >
          {value}
        </div>
      </div>
    </div>
  );
}
