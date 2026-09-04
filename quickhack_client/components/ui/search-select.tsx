"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { createPortal } from "react-dom";
import { CheckCheck, ChevronDown, CircleX } from "lucide-react";
import { Input } from "@/quickhack_client/components/ui/input";
import { cn } from "@/quickhack_shared/core/utils";

export type SearchSelectOption = {
  value: string;
  label?: string;
  description?: string;
  searchText?: string;
  receiptId?: string;
};

function normalizeOptions(
  options: Array<SearchSelectOption | string>
): SearchSelectOption[] {
  return options
    .map((option) =>
      typeof option === "string" ? { value: option, label: option } : option
    )
    .filter((option) => option.value.trim() !== "");
}

function optionLabel(option: SearchSelectOption) {
  return option.label?.trim() || option.value;
}

function optionSearchText(option: SearchSelectOption) {
  return `${option.value} ${option.label ?? ""} ${option.description ?? ""} ${
    option.searchText ?? ""
  }`
    .trim()
    .toLowerCase();
}

function optionValueSet(options: SearchSelectOption[]) {
  return new Set(options.map((option) => option.value));
}

function optionByDisplayText(options: SearchSelectOption[], text: string) {
  const normalizedText = text.trim();

  return options.find(
    (option) =>
      option.value === normalizedText || optionLabel(option) === normalizedText
  );
}

type BasePickerProps = {
  label?: string;
  value: string;
  options: Array<SearchSelectOption | string>;
  placeholder?: string;
  emptyLabel?: string;
  allowEmpty?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  isChanged?: boolean;
  className?: string;
  inputClassName?: string;
  onSearchChange?: (value: string) => void;
  selectionMode?: "matching-text" | "explicit-option";
  onSelectionInvalidated?: () => void;
};

function useAnchoredPopup(isOpen: boolean) {
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = React.useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  React.useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    function updatePosition() {
      const rect = anchorRef.current?.getBoundingClientRect();

      if (!rect) {
        return;
      }

      const margin = 8;
      const preferredMaxHeight = 256;
      const availableBelow = window.innerHeight - rect.bottom - margin;
      const availableAbove = rect.top - margin;
      const shouldOpenAbove =
        availableBelow < 160 && availableAbove > availableBelow;
      const available = shouldOpenAbove ? availableAbove : availableBelow;
      const maxHeight = Math.max(120, Math.min(preferredMaxHeight, available - 4));

      setPosition({
        left: Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin)),
        top: shouldOpenAbove
          ? Math.max(margin, rect.top - maxHeight - 4)
          : rect.bottom + 4,
        width: rect.width,
        maxHeight,
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;

      if (
        anchorRef.current?.contains(target) ||
        popupRef.current?.contains(target)
      ) {
        return;
      }

      anchorRef.current?.dispatchEvent(new CustomEvent("quickhack-close-popup"));
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  return { anchorRef, popupRef, position };
}

export function SearchSelect({
  label,
  value,
  options,
  onValueChange,
  placeholder,
  emptyLabel,
  allowEmpty = true,
  disabled = false,
  readOnly = false,
  isChanged = false,
  className,
  inputClassName,
  onSearchChange,
  selectionMode = "matching-text",
  onSelectionInvalidated,
}: BasePickerProps & {
  onValueChange: (value: string) => void;
}) {
  const t = useTranslations("common.searchControl");
  const resolvedEmptyLabel = emptyLabel ?? t("emptySelection");
  const normalizedOptions = React.useMemo(
    () => normalizeOptions(options),
    [options]
  );
  const selectedOption = React.useMemo(
    () => normalizedOptions.find((option) => option.value === value) ?? null,
    [normalizedOptions, value]
  );
  const selectedDisplayValue = selectedOption ? optionLabel(selectedOption) : value;
  const values = React.useMemo(
    () => optionValueSet(normalizedOptions),
    [normalizedOptions]
  );
  const [draftState, setDraftState] = React.useState(() => ({
    draftValue: selectedDisplayValue,
    externalValue: value,
  }));
  const draftValue =
    draftState.externalValue === value
      ? draftState.draftValue
      : selectedDisplayValue;
  const [isOpen, setIsOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const { anchorRef, popupRef, position } = useAnchoredPopup(isOpen);
  const isDisabled = disabled || readOnly;
  const canClear = !isDisabled && draftValue.trim() !== "";
  const filteredOptions = React.useMemo(() => {
    const query = draftValue.trim().toLowerCase();
    const matched = query
      ? normalizedOptions.filter((option) =>
          optionSearchText(option).includes(query)
        )
      : normalizedOptions;

    return matched.slice(0, 80);
  }, [draftValue, normalizedOptions]);

  const resetDraft = React.useCallback(() => {
    setDraftState({
      draftValue: selectedDisplayValue,
      externalValue: value,
    });
  }, [selectedDisplayValue, value]);
  const commitDraft = React.useCallback(() => {
    const nextValue = draftValue.trim();

    if (!nextValue && allowEmpty) {
      if (value !== "") {
        onValueChange("");
      }
      return;
    }

    if (nextValue && selectionMode === "matching-text") {
      const matchedOption = optionByDisplayText(normalizedOptions, nextValue);

      if (matchedOption && values.has(matchedOption.value)) {
        if (matchedOption.value !== value) {
          onValueChange(matchedOption.value);
        }
        return;
      }
    }

    resetDraft();
  }, [
    allowEmpty,
    draftValue,
    normalizedOptions,
    onValueChange,
    resetDraft,
    selectionMode,
    value,
    values,
  ]);
  const selectValue = React.useCallback(
    (nextValue: string) => {
      const option = normalizedOptions.find((item) => item.value === nextValue);

      setDraftState({
        draftValue: option ? optionLabel(option) : nextValue,
        externalValue: value,
      });
      setIsOpen(false);
      setActiveIndex(-1);

      if (nextValue !== value) {
        onValueChange(nextValue);
      }
    },
    [normalizedOptions, onValueChange, value]
  );
  const clearDraft = React.useCallback(() => {
    setDraftState({
      draftValue: "",
      externalValue: value,
    });
    setIsOpen(true);
    setActiveIndex(-1);
    onSearchChange?.("");
    if (selectionMode === "explicit-option" && value) {
      onSelectionInvalidated?.();
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [onSearchChange, onSelectionInvalidated, selectionMode, value]);

  React.useEffect(() => {
    const anchor = anchorRef.current;

    if (!anchor) {
      return;
    }

    function closePopup() {
      setIsOpen(false);
      setActiveIndex(-1);
      resetDraft();
    }

    anchor.addEventListener("quickhack-close-popup", closePopup);
    return () => anchor.removeEventListener("quickhack-close-popup", closePopup);
  }, [anchorRef, resetDraft]);

  const popup =
    isOpen && !isDisabled && position && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popupRef}
            className="fixed z-[100] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
          >
            <div className="max-h-[inherit] overflow-auto p-1">
              {allowEmpty ? (
                <button
                  type="button"
                  className="flex w-full items-center rounded-sm px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-secondary"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectValue("")}
                >
                  {resolvedEmptyLabel}
                </button>
              ) : null}
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-sm px-3 py-1.5 text-left text-sm hover:bg-secondary",
                      (option.value === value || index === activeIndex) &&
                        "bg-secondary"
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectValue(option.value)}
                  >
                    <span className="min-w-0 truncate">
                      {optionLabel(option)}
                      {option.description ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {option.value === value ? (
                      <CheckCheck className="size-4 shrink-0 text-emerald-600" />
                    ) : null}
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  {t("noResults")}
                </div>
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <label className={cn("grid gap-1 text-sm", className)}>
      {label ? (
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
      ) : null}
      <div ref={anchorRef} className="relative">
        <Input
          ref={inputRef}
          readOnly={readOnly}
          disabled={disabled}
          value={draftValue}
          placeholder={placeholder}
          className={cn(
            canClear ? "pr-16" : "pr-9",
            readOnly && "bg-secondary text-muted-foreground",
            isChanged &&
              "border-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.24)] focus-visible:ring-emerald-500",
            inputClassName
          )}
          onFocus={() => {
            if (!isDisabled) {
              setIsOpen(true);
              setActiveIndex(-1);
              onSearchChange?.(draftValue);
            }
          }}
          onBlur={() => {
            window.setTimeout(() => {
              commitDraft();
              setIsOpen(false);
            }, 0);
          }}
          onChange={(event) => {
            if (
              selectionMode === "explicit-option" &&
              value &&
              event.target.value !== selectedDisplayValue
            ) {
              onSelectionInvalidated?.();
            }
            setDraftState({
              draftValue: event.target.value,
              externalValue: value,
            });
            onSearchChange?.(event.target.value);
            setIsOpen(true);
            setActiveIndex(-1);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }

            if (event.key === "ArrowDown" && filteredOptions.length > 0) {
              event.preventDefault();
              setIsOpen(true);
              setActiveIndex((current) =>
                current < filteredOptions.length - 1 ? current + 1 : 0
              );
              return;
            }

            if (event.key === "ArrowUp" && filteredOptions.length > 0) {
              event.preventDefault();
              setIsOpen(true);
              setActiveIndex((current) =>
                current > 0 ? current - 1 : filteredOptions.length - 1
              );
              return;
            }

            if (event.key === "Enter") {
              event.preventDefault();
              const activeOption = filteredOptions[activeIndex];
              if (activeOption) {
                selectValue(activeOption.value);
              } else {
                commitDraft();
              }
              event.currentTarget.blur();
            }

            if (event.key === "Escape") {
              resetDraft();
              setIsOpen(false);
              setActiveIndex(-1);
              event.currentTarget.blur();
            }
          }}
        />
        {canClear ? (
          <button
            type="button"
            className="absolute right-8 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
            tabIndex={-1}
            aria-label={label ? t("clearInputLabel", { label }) : t("clearInput")}
            title={t("clearInput")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={clearDraft}
          >
            <CircleX className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={isDisabled}
          tabIndex={-1}
          aria-label={label ? t("listLabel", { label }) : t("list")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (isDisabled) {
              return;
            }

            setIsOpen((current) => !current);
            window.requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <ChevronDown className="size-4 opacity-60" />
        </button>
      </div>
      {popup}
    </label>
  );
}

export function SuggestInput({
  label,
  value,
  options,
  onValueChange,
  placeholder,
  emptyLabel,
  allowEmpty = true,
  disabled = false,
  readOnly = false,
  className,
  inputClassName,
}: BasePickerProps & {
  onValueChange: (value: string) => void;
}) {
  const t = useTranslations("common.searchControl");
  const resolvedEmptyLabel = emptyLabel ?? t("defaultSelection");
  const normalizedOptions = React.useMemo(() => {
    const seen = new Set<string>();
    const nextOptions: SearchSelectOption[] = [];

    if (allowEmpty) {
      nextOptions.push({ value: "", label: resolvedEmptyLabel });
      seen.add("");
    }

    for (const option of normalizeOptions(options)) {
      if (seen.has(option.value)) {
        continue;
      }

      seen.add(option.value);
      nextOptions.push(option);
    }

    return nextOptions;
  }, [allowEmpty, options, resolvedEmptyLabel]);
  const [isOpen, setIsOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const { anchorRef, popupRef, position } = useAnchoredPopup(isOpen);
  const isDisabled = disabled || readOnly;
  const canClear = !isDisabled && value.trim() !== "";
  const filteredOptions = React.useMemo(() => {
    const query = value.trim().toLowerCase();
    const matched = query
      ? normalizedOptions.filter((option) =>
          optionSearchText(option).includes(query)
        )
      : normalizedOptions;

    return matched.slice(0, 80);
  }, [normalizedOptions, value]);
  const selectValue = React.useCallback(
    (nextValue: string) => {
      onValueChange(nextValue);
      setIsOpen(false);
    },
    [onValueChange]
  );
  const clearValue = React.useCallback(() => {
    onValueChange("");
    setIsOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [onValueChange]);

  React.useEffect(() => {
    const anchor = anchorRef.current;

    if (!anchor) {
      return;
    }

    function closePopup() {
      setIsOpen(false);
    }

    anchor.addEventListener("quickhack-close-popup", closePopup);
    return () => anchor.removeEventListener("quickhack-close-popup", closePopup);
  }, [anchorRef]);

  const popup =
    isOpen && !isDisabled && position && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popupRef}
            className="fixed z-[100] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
          >
            <div className="max-h-[inherit] overflow-auto p-1">
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option) => (
                  <button
                    key={option.value || "__EMPTY__"}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-sm px-3 py-1.5 text-left text-sm hover:bg-secondary",
                      option.value === value && "bg-secondary"
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectValue(option.value)}
                  >
                    <span className="min-w-0 truncate">
                      {optionLabel(option)}
                      {option.description ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {option.value === value ? (
                      <CheckCheck className="size-4 shrink-0 text-emerald-600" />
                    ) : null}
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  {t("noResults")}
                </div>
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <label className={cn("grid gap-1 text-sm", className)}>
      {label ? (
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
      ) : null}
      <div ref={anchorRef} className="relative">
        <Input
          ref={inputRef}
          readOnly={readOnly}
          disabled={disabled}
          value={value}
          placeholder={placeholder}
          className={cn(canClear ? "pr-16" : "pr-9", inputClassName)}
          onFocus={() => !isDisabled && setIsOpen(true)}
          onBlur={() => window.setTimeout(() => setIsOpen(false), 0)}
          onChange={(event) => {
            onValueChange(event.target.value);
            setIsOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }

            if (event.key === "Escape") {
              setIsOpen(false);
              event.currentTarget.blur();
            }
          }}
        />
        {canClear ? (
          <button
            type="button"
            className="absolute right-8 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
            tabIndex={-1}
            aria-label={label ? t("clearInputLabel", { label }) : t("clearInput")}
            title={t("clearInput")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={clearValue}
          >
            <CircleX className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={isDisabled}
          tabIndex={-1}
          aria-label={label ? t("listLabel", { label }) : t("list")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (isDisabled) {
              return;
            }

            setIsOpen((current) => !current);
            window.requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <ChevronDown className="size-4 opacity-60" />
        </button>
      </div>
      {popup}
    </label>
  );
}
