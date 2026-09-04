// QuickHack note: 기존 재고 수정과 기준값 관리 화면에서 공통으로 쓰는 한 줄 편집 필드와 접이식 섹션입니다.
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  SearchSelect,
  type SearchSelectOption,
} from "@/quickhack_client/components/ui/search-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import { cn } from "@/quickhack_shared/core/utils";

export type InventoryEditOption = SearchSelectOption;

export type InventoryEditFieldMode =
  | "text"
  | "date"
  | "datetime-local"
  | "select"
  | "datalist";

type InventoryEditFieldProps = {
  recordId?: string;
  fieldKey?: string;
  label: string;
  value: string;
  onChange: (value: string, recordId?: string, fieldKey?: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  isChanged?: boolean;
  originalValue?: string;
  onDraftChange?: (
    value: string | null,
    isChanged: boolean,
    recordId?: string,
    fieldKey?: string
  ) => void;
  mode?: InventoryEditFieldMode;
  options?: InventoryEditOption[];
  allowEmpty?: boolean;
};

export type { InventoryEditFieldProps };

const EMPTY_SELECT_VALUE = "__quickhack_empty__";

export const InventoryEditField = React.memo(function InventoryEditField({
  recordId,
  fieldKey,
  label,
  value,
  onChange,
  placeholder,
  readOnly = false,
  isChanged = false,
  originalValue = value,
  onDraftChange,
  mode = "text",
  options = [],
  allowEmpty = true,
}: InventoryEditFieldProps) {
  const t = useTranslations("inventory.editFields");
  const [draftState, setDraftState] = React.useState(() => ({
    draftValue: value,
    externalValue: value,
  }));
  const draftValue =
    draftState.externalValue === value ? draftState.draftValue : value;
  const resetDraftValue = React.useCallback(
    (nextValue: string) => {
      setDraftState({
        draftValue: nextValue,
        externalValue: value,
      });
    },
    [value]
  );

  const commitDraft = React.useCallback(() => {
    if (readOnly) {
      return;
    }

    const nextValue = draftValue;

    if (nextValue === value) {
      onDraftChange?.(null, false, recordId, fieldKey);
      return;
    }

    onChange(nextValue, recordId, fieldKey);
    onDraftChange?.(null, false, recordId, fieldKey);
  }, [
    draftValue,
    fieldKey,
    onChange,
    onDraftChange,
    readOnly,
    recordId,
    value,
  ]);

  const handleSelectChange = React.useCallback(
    (nextValue: string) => {
      if (readOnly) {
        return;
      }

      const normalizedValue =
        nextValue === EMPTY_SELECT_VALUE ? "" : nextValue;

      if (!normalizedValue && !allowEmpty) {
        return;
      }

      if (normalizedValue !== value) {
        onChange(normalizedValue, recordId, fieldKey);
      }
    },
    [allowEmpty, fieldKey, onChange, readOnly, recordId, value]
  );

  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;
      setDraftState({
        draftValue: nextValue,
        externalValue: value,
      });
      onDraftChange?.(
        nextValue,
        nextValue !== originalValue,
        recordId,
        fieldKey
      );
    },
    [fieldKey, onDraftChange, originalValue, recordId, value]
  );
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) {
        return;
      }

      if (event.key === "Enter") {
        commitDraft();
        event.currentTarget.blur();
      }

      if (event.key === "Escape") {
        resetDraftValue(value);
        onDraftChange?.(null, false, recordId, fieldKey);
        event.currentTarget.blur();
      }
    },
    [
      commitDraft,
      fieldKey,
      onDraftChange,
      recordId,
      resetDraftValue,
      value,
    ]
  );
  const displayedValueIsChanged =
    isChanged || (draftValue !== value && draftValue !== originalValue);

  if (mode === "select" && options.length > 0) {
    return (
      <label className="grid gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Select
          disabled={readOnly}
          value={value || EMPTY_SELECT_VALUE}
          onValueChange={handleSelectChange}
        >
          <SelectTrigger
            className={cn(
              readOnly && "bg-secondary text-muted-foreground",
              displayedValueIsChanged &&
                "border-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.24)] focus:ring-emerald-500"
            )}
          >
            <SelectValue placeholder={placeholder || t("selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {allowEmpty ? (
              <SelectItem value={EMPTY_SELECT_VALUE}>
                {t("clearSelection")}
              </SelectItem>
            ) : null}
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );
  }

  if (mode === "datalist" && options.length > 0) {
    return (
      <SearchSelect
        label={label}
        value={value}
        options={options}
        placeholder={placeholder}
        allowEmpty={allowEmpty}
        readOnly={readOnly}
        isChanged={isChanged}
        onValueChange={(nextValue) => onChange(nextValue, recordId, fieldKey)}
      />
    );
  }

  return (
    <label className="grid gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        type={mode === "date" || mode === "datetime-local" ? mode : "text"}
        readOnly={readOnly}
        value={mode === "datetime-local" ? draftValue.replace(" ", "T") : draftValue}
        placeholder={placeholder}
        onChange={handleChange}
        onBlur={commitDraft}
        onKeyDown={handleKeyDown}
        className={cn(
          readOnly && "bg-secondary text-muted-foreground",
          displayedValueIsChanged &&
            "border-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.24)] focus-visible:ring-emerald-500"
        )}
      />
    </label>
  );
});

export const InventoryEditSection = React.memo(function InventoryEditSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = React.useState(true);

  return (
    <section className="grid gap-3 rounded-md border bg-popover p-4">
      <h3>
        <button
          type="button"
          aria-expanded={isOpen}
          className="flex w-full items-center gap-2 text-left text-sm font-semibold"
          onClick={() => setIsOpen((current) => !current)}
        >
          <span className="w-4 shrink-0 text-xs text-muted-foreground">
            {isOpen ? "▼" : "▶"}
          </span>
          <span>{title}</span>
        </button>
      </h3>
      {isOpen ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
      ) : null}
    </section>
  );
});
