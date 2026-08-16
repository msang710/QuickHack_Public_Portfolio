import * as React from "react";
import { cn } from "@/quickhack_shared/core/utils";

export type DescriptionListProps = React.HTMLAttributes<HTMLDivElement>;

export function DescriptionList({
  className,
  children,
  ...props
}: DescriptionListProps) {
  return (
    <div className={cn("grid", className)} {...props}>
      {children}
    </div>
  );
}

export interface DescriptionRowProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  label: React.ReactNode;
  value: React.ReactNode;
  labelWidth?: string;
  labelClassName?: string;
  valueClassName?: string;
}

export function DescriptionRow({
  label,
  value,
  labelWidth = "120px",
  labelClassName,
  valueClassName,
  className,
  style,
  ...props
}: DescriptionRowProps) {
  const displayValue =
    value === null || value === undefined || value === "" ? "-" : value;

  return (
    <div
      className={cn(
        "grid gap-3 border-b border-border/70 py-2 text-sm last:border-b-0",
        className
      )}
      style={{
        gridTemplateColumns: `${labelWidth} minmax(0, 1fr)`,
        ...style,
      }}
      {...props}
    >
      <span className={cn("text-muted-foreground", labelClassName)}>
        {label}
      </span>
      <span
        className={cn(
          "min-w-0 break-words text-foreground",
          valueClassName
        )}
      >
        {displayValue}
      </span>
    </div>
  );
}
