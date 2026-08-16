import * as React from "react";
import { cn } from "@/quickhack_shared/core/utils";

export interface FormSectionProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  headerClassName?: string;
}

export function FormSection({
  title,
  description,
  action,
  className,
  headerClassName,
  children,
  ...props
}: FormSectionProps) {
  return (
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-3 rounded-md border bg-popover p-4",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "flex items-start justify-between gap-4",
          headerClassName
        )}
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export interface FormFieldProps
  extends React.LabelHTMLAttributes<HTMLLabelElement> {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  labelClassName?: string;
}

export function FormField({
  label,
  description,
  error,
  labelClassName,
  className,
  children,
  ...props
}: FormFieldProps) {
  return (
    <label
      className={cn(
        "grid gap-1 text-xs font-medium text-muted-foreground",
        className
      )}
      {...props}
    >
      <span className={labelClassName}>{label}</span>
      {children}
      {error ? (
        <span className="font-normal text-destructive">{error}</span>
      ) : description ? (
        <span className="font-normal text-muted-foreground">{description}</span>
      ) : null}
    </label>
  );
}

export interface FormActionBarProps
  extends React.HTMLAttributes<HTMLDivElement> {
  status?: React.ReactNode;
  statusClassName?: string;
}

export function FormActionBar({
  status,
  statusClassName,
  className,
  children,
  ...props
}: FormActionBarProps) {
  return (
    <div
      className={cn(
        "flex min-h-16 shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-background px-5 py-3",
        className
      )}
      {...props}
    >
      {status ? (
        <span
          className={cn(
            "mr-auto text-sm text-muted-foreground",
            statusClassName
          )}
        >
          {status}
        </span>
      ) : null}
      {children}
    </div>
  );
}
