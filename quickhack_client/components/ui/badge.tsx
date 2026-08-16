// QuickHack note: 상태와 등급을 작은 라벨로 표시하는 공통 Badge 컴포넌트입니다.
﻿import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/quickhack_shared/core/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        success: "border-emerald-200 bg-emerald-50 text-emerald-700",
        warning: "border-amber-200 bg-amber-50 text-amber-800",
        danger: "border-red-200 bg-red-50 text-red-700",
        neutral: "border-zinc-200 bg-zinc-50 text-zinc-700",
        purple: "border-purple-200 bg-purple-50 text-purple-700",
        orange: "border-orange-200 bg-orange-50 text-orange-700",
        sky: "border-sky-200 bg-sky-50 text-sky-700",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
