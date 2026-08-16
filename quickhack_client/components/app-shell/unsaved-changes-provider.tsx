"use client";

import * as React from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import {
  UnsavedChangesRegistry,
  type UnsavedEntryKind,
  type UnsavedFormEntry,
  type UnsavedFormRegistrationToken,
  type UnsavedFormSelection,
} from "@/quickhack_client/lib/unsaved-changes";
import { Button } from "@/quickhack_client/components/ui/button";
import { DialogFrame } from "@/quickhack_client/components/ui/dialog-frame";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";

export type UnsavedGuardIntent =
  | "menu-change"
  | "refresh"
  | "logout"
  | "close-window"
  | "internal-change"
  | "dialog-close";

export type GuardedActionOptions = {
  intent: UnsavedGuardIntent;
  action: () => void;
  formIds?: readonly string[];
  targetLabel?: string;
};

type GuardDialogState =
  | {
      kind: "dirty";
      entries: UnsavedFormEntry[];
      intent: UnsavedGuardIntent;
      targetLabel?: string;
    }
  | {
      kind: "busy";
      entries: UnsavedFormEntry[];
      targetLabel?: string;
    }
  | {
      kind: "discard-error";
      entries: UnsavedFormEntry[];
      message: string;
    };

type PendingGuardedAction = GuardedActionOptions & {
  entries: UnsavedFormEntry[];
};

type UnsavedChangesContextValue = {
  registry: UnsavedChangesRegistry;
  hasDirtyForms: boolean;
  hasBusyForms: boolean;
  runGuardedAction: (options: GuardedActionOptions) => void;
  allowNextBeforeUnload: (resetAfterMilliseconds?: number) => void;
};

const UnsavedChangesContext =
  React.createContext<UnsavedChangesContextValue | null>(null);

function intentDestination(intent: UnsavedGuardIntent) {
  switch (intent) {
    case "menu-change":
      return { destination: "다른 메뉴로 이동", action: "이동" };
    case "refresh":
      return { destination: "현재 메뉴를 다시 불러오기", action: "새로고침" };
    case "logout":
      return { destination: "로그아웃", action: "로그아웃" };
    case "close-window":
      return { destination: "QuickHack 창을 닫기", action: "창 닫기" };
    case "dialog-close":
      return { destination: "현재 창을 닫기", action: "닫기" };
    default:
      return { destination: "다음 작업을 계속하기", action: "계속" };
  }
}

function intentCopy(
  intent: UnsavedGuardIntent,
  entries: readonly UnsavedFormEntry[] = []
) {
  const hasOneTimeResult = entries.some(
    (entry) => entry.kind === "one-time-result"
  );
  const hasDraft = entries.some((entry) => entry.kind !== "one-time-result");
  const { destination, action } = intentDestination(intent);

  if (hasOneTimeResult && !hasDraft) {
    return {
      title: "한 번만 표시되는 정보가 남아 있습니다",
      description: `보관하지 않고 ${destination}하면 이 정보를 다시 확인하지 못할 수 있습니다.`,
      confirmLabel: `보관하지 않고 ${action}`,
    };
  }

  if (hasOneTimeResult && hasDraft) {
    return {
      title: "저장하지 않은 변경과 미보관 정보가 있습니다",
      description: `변경사항을 버리고 일회성 정보를 보관하지 않은 채 ${destination}하시겠습니까?`,
      confirmLabel: `버리고 ${action}`,
    };
  }

  switch (intent) {
    case "menu-change":
      return {
        title: "저장하지 않은 변경사항이 있습니다",
        description: "변경사항을 버리고 다른 메뉴로 이동하시겠습니까?",
        confirmLabel: "버리고 이동",
      };
    case "refresh":
      return {
        title: "저장하지 않은 변경사항이 있습니다",
        description: "변경사항을 버리고 현재 메뉴를 다시 불러오시겠습니까?",
        confirmLabel: "버리고 새로고침",
      };
    case "logout":
      return {
        title: "저장하지 않은 변경사항이 있습니다",
        description: "변경사항을 버리고 로그아웃하시겠습니까?",
        confirmLabel: "버리고 로그아웃",
      };
    case "close-window":
      return {
        title: "저장하지 않은 변경사항이 있습니다",
        description: "변경사항을 버리고 QuickHack 창을 닫으시겠습니까?",
        confirmLabel: "버리고 창 닫기",
      };
    case "dialog-close":
      return {
        title: "저장하지 않은 변경사항이 있습니다",
        description: "변경사항을 버리고 창을 닫으시겠습니까?",
        confirmLabel: "버리고 닫기",
      };
    default:
      return {
        title: "저장하지 않은 변경사항이 있습니다",
        description: "변경사항을 버리고 계속하시겠습니까?",
        confirmLabel: "버리고 계속",
      };
  }
}

function formSelection(formIds?: readonly string[]): UnsavedFormSelection {
  return formIds ? formIds : "all";
}

function formLabels(entries: readonly UnsavedFormEntry[]) {
  const labels = entries.slice(0, 4).map((entry) => entry.label);
  const remaining = entries.length - labels.length;
  return remaining > 0 ? [...labels, `외 ${remaining}개`] : labels;
}

export function UnsavedChangesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [registry] = React.useState(() => new UnsavedChangesRegistry());
  React.useSyncExternalStore(
    registry.subscribe,
    registry.getRevision,
    registry.getRevision
  );
  const pendingActionRef = React.useRef<PendingGuardedAction | null>(null);
  const suppressNextBeforeUnloadRef = React.useRef(false);
  const suppressResetTimerRef = React.useRef<number | null>(null);
  const [dialogState, setDialogState] =
    React.useState<GuardDialogState | null>(null);
  const [isDiscarding, setIsDiscarding] = React.useState(false);

  const dirtyEntries = registry.getDirtyEntries();
  const busyEntries = registry.getBusyEntries();

  const allowNextBeforeUnload = React.useCallback(
    (resetAfterMilliseconds = 1_000) => {
      suppressNextBeforeUnloadRef.current = true;
      if (suppressResetTimerRef.current !== null) {
        window.clearTimeout(suppressResetTimerRef.current);
        suppressResetTimerRef.current = null;
      }
      suppressResetTimerRef.current = window.setTimeout(() => {
        suppressNextBeforeUnloadRef.current = false;
        suppressResetTimerRef.current = null;
      }, resetAfterMilliseconds);
    },
    []
  );

  const executeAction = React.useCallback(
    (options: GuardedActionOptions) => {
      if (options.intent === "close-window") {
        allowNextBeforeUnload();
      }
      options.action();
    },
    [allowNextBeforeUnload]
  );

  const runGuardedAction = React.useCallback(
    (options: GuardedActionOptions) => {
      if (dialogState || pendingActionRef.current) {
        return;
      }

      const selection = formSelection(options.formIds);
      const matchingBusyEntries = registry.getBusyEntries(selection);
      if (matchingBusyEntries.length > 0) {
        setDialogState({
          kind: "busy",
          entries: matchingBusyEntries,
          targetLabel: options.targetLabel,
        });
        return;
      }

      const matchingDirtyEntries = registry.getDirtyEntries(selection);
      if (matchingDirtyEntries.length === 0) {
        executeAction(options);
        return;
      }

      pendingActionRef.current = {
        ...options,
        entries: matchingDirtyEntries,
      };
      setDialogState({
        kind: "dirty",
        entries: matchingDirtyEntries,
        intent: options.intent,
        targetLabel: options.targetLabel,
      });
    },
    [dialogState, executeAction, registry]
  );

  const closeDialog = React.useCallback(() => {
    if (isDiscarding) {
      return;
    }
    pendingActionRef.current = null;
    setDialogState(null);
  }, [isDiscarding]);

  const confirmDiscard = React.useCallback(async () => {
    const pendingAction = pendingActionRef.current;
    if (!pendingAction || isDiscarding) {
      return;
    }

    setIsDiscarding(true);
    const result = await registry.discardEntries(pendingAction.entries);
    setIsDiscarding(false);

    if (!result.ok) {
      const failedLabels = result.errors.map(({ entry }) => entry.label);
      pendingActionRef.current = null;
      setDialogState({
        kind: "discard-error",
        entries: result.errors.map(({ entry }) => entry),
        message: `${failedLabels.join(", ")} 항목을 초기화하지 못했습니다.`,
      });
      return;
    }

    pendingActionRef.current = null;
    setDialogState(null);
    executeAction(pendingAction);
  }, [executeAction, isDiscarding, registry]);

  React.useEffect(() => {
    if (dirtyEntries.length === 0 && busyEntries.length === 0) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (suppressNextBeforeUnloadRef.current) {
        suppressNextBeforeUnloadRef.current = false;
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [busyEntries.length, dirtyEntries.length]);

  React.useEffect(
    () => () => {
      if (suppressResetTimerRef.current !== null) {
        window.clearTimeout(suppressResetTimerRef.current);
      }
    },
    []
  );

  const value = React.useMemo<UnsavedChangesContextValue>(
    () => ({
      registry,
      hasDirtyForms: dirtyEntries.length > 0,
      hasBusyForms: busyEntries.length > 0,
      runGuardedAction,
      allowNextBeforeUnload,
    }),
    [
      allowNextBeforeUnload,
      busyEntries.length,
      dirtyEntries.length,
      registry,
      runGuardedAction,
    ]
  );

  const dirtyEntriesForDialog =
    dialogState?.kind === "dirty" ? dialogState.entries : [];
  const dirtyCopy = intentCopy(
    dialogState?.kind === "dirty" ? dialogState.intent : "internal-change",
    dirtyEntriesForDialog
  );
  const hasOneTimeResult = dirtyEntriesForDialog.some(
    (entry) => entry.kind === "one-time-result"
  );
  const hasDraft = dirtyEntriesForDialog.some(
    (entry) => entry.kind !== "one-time-result"
  );
  const displayedLabels = dialogState ? formLabels(dialogState.entries) : [];

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <DialogFrame
        open={dialogState !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        title={
          dialogState?.kind === "busy"
            ? "작업을 처리하고 있습니다"
            : dialogState?.kind === "discard-error"
              ? "변경사항을 초기화하지 못했습니다"
              : dirtyCopy.title
        }
        description={
          dialogState?.kind === "busy"
            ? "저장 작업이 끝난 뒤 다시 시도해 주세요."
            : dialogState?.kind === "discard-error"
              ? "현재 작업은 실행하지 않았습니다. 입력 내용을 확인한 뒤 다시 시도해 주세요."
              : dialogState?.targetLabel
                ? `${dialogState.targetLabel}: ${dirtyCopy.description}`
                : dirtyCopy.description
        }
        icon={
          dialogState?.kind === "busy" ? (
            <LoaderCircle className="mt-0.5 size-5 animate-spin text-primary" />
          ) : (
            <TriangleAlert className="mt-0.5 size-5 text-amber-600" />
          )
        }
        closeDisabled={isDiscarding}
        closeLabel="계속 편집"
        contentClassName="max-w-lg"
        footerClassName="justify-end gap-2"
        footer={
          dialogState?.kind === "dirty" ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                disabled={isDiscarding}
              >
                계속 편집
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => void confirmDiscard()}
                disabled={isDiscarding}
              >
                {isDiscarding ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : null}
                {dirtyCopy.confirmLabel}
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={closeDialog}>
              확인
            </Button>
          )
        }
      >
        {dialogState?.kind === "discard-error" ? (
          <FeedbackBanner tone="danger">
            {dialogState.message}
          </FeedbackBanner>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {dialogState?.kind === "busy"
                ? "처리 중인 항목"
                : hasOneTimeResult && hasDraft
                  ? "확인이 필요한 항목"
                  : hasOneTimeResult
                    ? "보관하지 않은 항목"
                    : "저장하지 않은 항목"}
            </p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {displayedLabels.map((label, index) => (
                <li key={`${index}:${label}`}>• {label}</li>
              ))}
            </ul>
          </div>
        )}
      </DialogFrame>
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedChanges() {
  const context = React.useContext(UnsavedChangesContext);
  if (!context) {
    throw new Error(
      "useUnsavedChanges must be used inside UnsavedChangesProvider."
    );
  }
  return context;
}

export function useGuardedDialogClose({
  formIds,
  targetLabel,
  onClose,
}: {
  formIds: readonly string[];
  targetLabel: string;
  onClose: () => void;
}) {
  const { runGuardedAction } = useUnsavedChanges();

  return React.useCallback(() => {
    runGuardedAction({
      intent: "dialog-close",
      action: onClose,
      formIds,
      targetLabel,
    });
  }, [formIds, onClose, runGuardedAction, targetLabel]);
}

export function useUnsavedForm({
  id,
  label,
  kind = "draft",
  enabled = true,
  isDirty,
  isBusy = false,
  discard,
}: {
  id: string;
  label: string;
  kind?: UnsavedEntryKind;
  enabled?: boolean;
  isDirty: boolean;
  isBusy?: boolean;
  discard: () => void | Promise<void>;
}) {
  const { registry } = useUnsavedChanges();
  const tokenRef = React.useRef<UnsavedFormRegistrationToken | null>(null);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const token = registry.register({
      id,
      label: id,
      kind,
      isDirty: false,
      isBusy: false,
      discard: () => {},
    });
    tokenRef.current = token;

    return () => {
      registry.unregister(token);
      if (tokenRef.current?.instance === token.instance) {
        tokenRef.current = null;
      }
    };
  }, [enabled, id, kind, registry]);

  React.useEffect(() => {
    const token = tokenRef.current;
    if (!enabled || !token) {
      return;
    }
    registry.update(token, {
      id,
      label,
      kind,
      isDirty,
      isBusy,
      discard,
    });
  }, [discard, enabled, id, isBusy, isDirty, kind, label, registry]);
}
