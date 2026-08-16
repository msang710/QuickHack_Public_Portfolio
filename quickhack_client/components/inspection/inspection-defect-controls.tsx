"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";

export type DefectMap = Record<string, readonly string[]>;
export type DefectState = Record<string, string[]>;

export function defectStateToText(selected: DefectState) {
  return Object.entries(selected)
    .flatMap(([part, states]) =>
      [...states].sort().map((state) => `${part}-${state}`)
    )
    .join(", ");
}

function updateDefectState(
  selected: DefectState,
  part: string,
  state: string,
  checked: boolean
) {
  const currentStates = new Set(selected[part] ?? []);

  if (checked) {
    currentStates.add(state);
  } else {
    currentStates.delete(state);
  }

  const next = { ...selected };

  if (currentStates.size === 0) {
    delete next[part];
  } else {
    next[part] = Array.from(currentStates);
  }

  return next;
}

// QuickHack object: 외관/기능 하자 항목을 그룹별 체크박스로 선택해 텍스트 값으로 합칩니다.
export function DefectSelector({
  title,
  defectMap,
  selected,
  onSelectedChange,
  emptyLabel,
  actionLabel,
  onAction,
}: {
  title: string;
  defectMap: DefectMap;
  selected: DefectState;
  onSelectedChange: (selected: DefectState) => void;
  emptyLabel: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const parts = React.useMemo(() => Object.keys(defectMap), [defectMap]);
  const [activePart, setActivePart] = React.useState(parts[0] ?? "");
  const selectedText = defectStateToText(selected);
  const activeStates = defectMap[activePart] ?? [];

  return (
    <div className="grid gap-3 rounded-md border bg-popover p-3 xl:grid-cols-[1fr_360px]">
      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSelectedChange({})}
          >
            선택 초기화
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          {parts.map((part) => (
            <Button
              key={part}
              type="button"
              variant={activePart === part ? "default" : "outline"}
              size="sm"
              onClick={() => setActivePart(part)}
            >
              {part}
            </Button>
          ))}
        </div>

        <div className="min-h-14 rounded-md border bg-background p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            상태
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            {activeStates.map((state) => (
              <label
                key={`${activePart}-${state}`}
                className="inline-flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="size-4 rounded border-input"
                  checked={(selected[activePart] ?? []).includes(state)}
                  onChange={(event) =>
                    onSelectedChange(
                      updateDefectState(
                        selected,
                        activePart,
                        state,
                        event.target.checked
                      )
                    )
                  }
                />
                {state}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="flex min-h-36 flex-col gap-3 rounded-md border bg-background p-3">
        <div className="text-xs font-medium text-muted-foreground">
          선택 결과
        </div>
        <div className="min-h-16 flex-1 whitespace-pre-wrap text-sm">
          {selectedText || emptyLabel}
        </div>
        {actionLabel && onAction ? (
          <Button type="button" onClick={onAction}>
            <CheckCircle2 className="size-4" />
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function FieldLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}
