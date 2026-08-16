// QuickHack note: 화면 안의 안내, 성공, 경고, 오류 메시지를 같은 시각 규칙과 접근성 속성으로 표시합니다.
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/quickhack_shared/core/utils";

const feedbackBannerVariants = cva("rounded-md border px-3 py-2", {
  variants: {
    tone: {
      neutral: "border-zinc-200 bg-zinc-50 text-zinc-700",
      info: "border-sky-200 bg-sky-50 text-sky-800",
      success: "border-emerald-200 bg-emerald-50 text-emerald-700",
      warning: "border-amber-200 bg-amber-50 text-amber-800",
      danger: "border-red-200 bg-red-50 text-red-700",
    },
    size: {
      xs: "text-xs",
      sm: "text-sm",
    },
  },
  defaultVariants: {
    tone: "neutral",
    size: "sm",
  },
});

export type FeedbackTone = NonNullable<
  VariantProps<typeof feedbackBannerVariants>["tone"]
>;

export interface FeedbackBannerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof feedbackBannerVariants> {}

export function FeedbackBanner({
  tone = "neutral",
  size = "sm",
  className,
  role,
  children,
  ...props
}: FeedbackBannerProps) {
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      aria-live={tone === "danger" ? "assertive" : "polite"}
      className={cn(feedbackBannerVariants({ tone, size }), className)}
      {...props}
    >
      {children}
    </div>
  );
}

export { feedbackBannerVariants };
