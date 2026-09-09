"use client";

import * as React from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
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
import { useDesktopCapability } from "@/quickhack_client/components/desktop/desktop-capability-provider";

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

type UnsavedChangesTranslator = ReturnType<typeof useTranslations<"common.unsavedChanges">>;

function intentDestination(intent: UnsavedGuardIntent, t: UnsavedChangesTranslator) {
  switch (intent) {
    case "menu-change":
      return { destination: t("destination.menuChange.destination"), action: t("destination.menuChange.action") };
    case "refresh":
      return { destination: t("destination.refresh.destination"), action: t("destination.refresh.action") };
    case "logout":
      return { destination: t("destination.logout.destination"), action: t("destination.logout.action") };
    case "close-window":
      return { destination: t("destination.closeWindow.destination"), action: t("destination.closeWindow.action") };
    case "dialog-close":
      return { destination: t("destination.dialogClose.destination"), action: t("destination.dialogClose.action") };
    default:
      return { destination: t("destination.internalChange.destination"), action: t("destination.internalChange.action") };
  }
}

function intentCopy(
  intent: UnsavedGuardIntent,
  t: UnsavedChangesTranslator,
  entries: readonly UnsavedFormEntry[] = []
) {
  const hasOneTimeResult = entries.some(
    (entry) => entry.kind === "one-time-result"
  );
  const hasDraft = entries.some((entry) => entry.kind !== "one-time-result");
  const { destination, action } = intentDestination(intent, t);

  if (hasOneTimeResult && !hasDraft) {
    return {
      title: t("oneTimeOnly.title"),
      description: t("oneTimeOnly.description", { destination }),
      confirmLabel: t("oneTimeOnly.confirm", { action }),
    };
  }

  if (hasOneTimeResult && hasDraft) {
    return {
      title: t("mixed.title"),
      description: t("mixed.description", { destination }),
      confirmLabel: t("mixed.confirm", { action }),
    };
  }

  return { title: t("dirty.title"), description: t("dirty.description", { destination }), confirmLabel: t("dirty.confirm", { action }) };
}

function formSelection(formIds?: readonly string[]): UnsavedFormSelection {
  return formIds ? formIds : "all";
}

function formLabels(entries: readonly UnsavedFormEntry[], t: UnsavedChangesTranslator) {
  const labels = entries.slice(0, 4).map((entry) => entry.label);
  const remaining = entries.length - labels.length;
  return remaining > 0 ? [...labels, t("remaining", { count: remaining })] : labels;
}

export function UnsavedChangesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { api: desktopApi } = useDesktopCapability();
  const t = useTranslations("common.unsavedChanges");
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
        message: t("discardError.message", { labels: failedLabels.join(", ") }),
      });
      return;
    }

    pendingActionRef.current = null;
    setDialogState(null);
    executeAction(pendingAction);
  }, [executeAction, isDiscarding, registry, t]);

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

  React.useEffect(() => {
    if (!desktopApi) return;
    return desktopApi.onCloseRequested(() => {
      runGuardedAction({
        intent: "close-window",
        targetLabel: t("closeTarget"),
        action: () => { void desktopApi.confirmClose(); },
      });
    });
  }, [desktopApi, runGuardedAction, t]);

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
    t,
    dirtyEntriesForDialog
  );
  const hasOneTimeResult = dirtyEntriesForDialog.some(
    (entry) => entry.kind === "one-time-result"
  );
  const hasDraft = dirtyEntriesForDialog.some(
    (entry) => entry.kind !== "one-time-result"
  );
  const displayedLabels = dialogState ? formLabels(dialogState.entries, t) : [];

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
            ? t("busy.title")
            : dialogState?.kind === "discard-error"
              ? t("discardError.title")
              : dirtyCopy.title
        }
        description={
          dialogState?.kind === "busy"
            ? t("busy.description")
            : dialogState?.kind === "discard-error"
              ? t("discardError.description")
              : dialogState?.targetLabel
                ? t("targetDescription", { target: dialogState.targetLabel, description: dirtyCopy.description })
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
        closeLabel={t("continueEditing")}
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
                {t("continueEditing")}
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
              {t("confirm")}
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
                ? t("section.busy")
                : hasOneTimeResult && hasDraft
                  ? t("section.mixed")
                  : hasOneTimeResult
                    ? t("section.oneTimeOnly")
                    : t("section.dirty")}
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
