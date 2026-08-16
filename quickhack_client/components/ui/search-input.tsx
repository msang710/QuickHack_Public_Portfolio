// QuickHack note: 단순 검색어 입력에 쓰는 돋보기 아이콘, 지우기 버튼 포함 공통 입력 컴포넌트입니다.
"use client";

import * as React from "react";
import { CircleX, Search } from "lucide-react";
import { Input } from "@/quickhack_client/components/ui/input";
import { cn } from "@/quickhack_shared/core/utils";

type SearchInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
> & {
  value: string;
  onValueChange: (value: string) => void;
  label?: string;
  wrapperClassName?: string;
};

export function SearchInput({
  value,
  onValueChange,
  label,
  wrapperClassName,
  className,
  type = "text",
  autoComplete = "off",
  autoCorrect = "off",
  spellCheck = false,
  ...props
}: SearchInputProps) {
  const canClear = !props.disabled && !props.readOnly && value.trim() !== "";

  const input = (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        {...props}
        data-quickhack-search-input="true"
        type={type}
        value={value}
        autoComplete={autoComplete}
        autoCorrect={autoCorrect}
        spellCheck={spellCheck}
        className={cn(canClear ? "pl-9 pr-16" : "pl-9 pr-9", className)}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {canClear ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
          title="검색어 지우기"
          aria-label={label ? `${label} 지우기` : "검색어 지우기"}
          onClick={() => onValueChange("")}
        >
          <CircleX className="size-4" />
        </button>
      ) : null}
    </div>
  );

  if (!label) {
    return <div className={wrapperClassName}>{input}</div>;
  }

  return (
    <label className={cn("grid gap-1 text-sm", wrapperClassName)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {input}
    </label>
  );
}
