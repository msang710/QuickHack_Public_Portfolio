// QuickHack note: 표 헤더와 행 선택에 쓰는 체크박스이며 indeterminate 상태를 지원합니다.
"use client";

import * as React from "react";

import { cn } from "@/quickhack_shared/core/utils";

type TableSelectCheckboxProps = {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  title?: string;
  onCheckedChange: (checked: boolean) => void;
};

export function TableSelectCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  ariaLabel,
  title,
  onCheckedChange,
}: TableSelectCheckboxProps) {
  const checkboxRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={checkboxRef}
      type="checkbox"
      className={cn(
        "size-4 rounded border-input align-middle",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      )}
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  );
}
