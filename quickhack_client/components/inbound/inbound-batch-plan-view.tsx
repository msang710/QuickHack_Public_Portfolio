// QuickHack note: 일자별 입고 예정 차수와 대수를 등록하고 실제 입고 연결 수량을 확인합니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
import {
  CalendarDays,
  ClipboardList,
  PackageCheck,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { Input } from "@/quickhack_client/components/ui/input";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  type DataGridColumn,
  type DataGridSortState,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import { todayKstDate } from "@/quickhack_shared/core/time";
import type { StatusTone } from "@/quickhack_shared/device/types";
import type { InboundBatchPlanRowDto } from "@/quickhack_shared/inbound/inbound-reconciliation";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";
import type { MutationReceipt } from "@/quickhack_shared/core/mutation-receipt";

type InboundBatchMutationResult = {
  id: number;
  revision: number;
  batchDate: string;
  batchNo: number;
};

type InboundBatchesApiResponse = {
  ok: boolean;
  message?: string;
  batches?: InboundBatchPlanRowDto[];
  batch?: InboundBatchMutationResult;
  receipt?: MutationReceipt<InboundBatchMutationResult>;
};

type InboundBatchColumnKey =
  | "batchDate"
  | "batchNo"
  | "expectedQuantity"
  | "linkedQuantity"
  | "supplierReturnQuantity"
  | "normalInboundTargetQuantity"
  | "arrivalDifference"
  | "note"
  | "actions";
type InboundBatchFilterKey = Exclude<InboundBatchColumnKey, "actions">;
type InboundBatchColumnFilters = Record<InboundBatchFilterKey, string>;
type InboundBatchSortState = DataGridSortState<InboundBatchColumnKey>;

type InboundBatchForm = {
  batchDate: string;
  batchNo: string;
  expectedQuantity: string;
  note: string;
};

const emptyColumnFilters: InboundBatchColumnFilters = {
  batchDate: "",
  batchNo: "",
  expectedQuantity: "",
  linkedQuantity: "",
  supplierReturnQuantity: "",
  normalInboundTargetQuantity: "",
  arrivalDifference: "",
  note: "",
};

const INBOUND_BATCH_FORM_ID = "inbound.batch-plan";

function nextBatchNo(
  batches: InboundBatchPlanRowDto[],
  batchDate: string
) {
  return (
    batches
      .filter((batch) => batch.batchDate === batchDate)
      .reduce((highest, batch) => Math.max(highest, batch.batchNo), 0) + 1
  );
}

function createNewForm(
  batches: InboundBatchPlanRowDto[] = [],
  batchDate = todayKstDate()
): InboundBatchForm {
  return {
    batchDate,
    batchNo: String(nextBatchNo(batches, batchDate)),
    expectedQuantity: "",
    note: "",
  };
}

function batchSearchText(batch: InboundBatchPlanRowDto, batchLabel: string) {
  return [
    batch.batchDate,
    batchLabel,
    batch.expectedQuantity,
    batch.linkedQuantity,
    batch.supplierReturnQuantity,
    batch.normalInboundTargetQuantity,
    batch.arrivalDifference,
    batch.note,
  ]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}

function batchColumnText(
  batch: InboundBatchPlanRowDto,
  key: InboundBatchColumnKey
) {
  switch (key) {
    case "batchDate":
      return batch.batchDate;
    case "batchNo":
      return String(batch.batchNo);
    case "expectedQuantity":
      return String(batch.expectedQuantity);
    case "linkedQuantity":
      return String(batch.linkedQuantity);
    case "supplierReturnQuantity":
      return String(batch.supplierReturnQuantity);
    case "normalInboundTargetQuantity":
      return String(batch.normalInboundTargetQuantity);
    case "arrivalDifference":
      return String(batch.arrivalDifference);
    case "note":
      return batch.note ?? "";
    default:
      return "";
  }
}

function compareValues(left: string, right: string) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);

  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right, "ko", { numeric: true });
}

function sortBatches(
  batches: InboundBatchPlanRowDto[],
  sort: InboundBatchSortState
) {
  if (!sort) {
    return batches;
  }

  return [...batches].sort((left, right) => {
    const result = compareValues(
      batchColumnText(left, sort.key),
      batchColumnText(right, sort.key)
    );

    return sort.direction === "asc" ? result : -result;
  });
}

function hasColumnFilters(filters: InboundBatchColumnFilters) {
  return Object.values(filters).some((value) => value.trim() !== "");
}

function arrivalDifferenceText(value: number, locale: string) {
  if (value > 0) {
    return `+${value.toLocaleString(locale)}`;
  }

  return value.toLocaleString(locale);
}

function BatchSummaryCell({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  const locale = useLocale();
  return (
    <div className="flex items-center gap-3 border-r px-4 py-3 last:border-r-0">
      <div className="flex size-10 items-center justify-center rounded bg-secondary text-primary">
        <Icon className="size-5" />
      </div>
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-semibold tabular-nums">
          {value.toLocaleString(locale)}
        </div>
      </div>
    </div>
  );
}

export function SimpleInboundBatchPlanView() {
  const t = useTranslations("inbound.batchPlan");
  const locale = useLocale();
  const [batches, setBatches] = React.useState<
    InboundBatchPlanRowDto[]
  >([]);
  const [editingBatchId, setEditingBatchId] = React.useState<number | null>(null);
  const [editingBatchRevision, setEditingBatchRevision] = React.useState<number | null>(null);
  const [formBaseline, setFormBaseline] = React.useState<InboundBatchForm>(() =>
    createNewForm()
  );
  const [form, setForm] = React.useState<InboundBatchForm>(() => formBaseline);
  const [query, setQuery] = React.useState("");
  const [columnFilters, setColumnFilters] =
    React.useState<InboundBatchColumnFilters>(() => ({ ...emptyColumnFilters }));
  const [sort, setSort] = React.useState<InboundBatchSortState>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<StatusTone>("neutral");
  const { runGuardedAction } = useUnsavedChanges();
  const deferredQuery = React.useDeferredValue(query);
  const deferredColumnFilters = React.useDeferredValue(columnFilters);
  const totalExpectedQuantity = batches.reduce(
    (sum, batch) => sum + batch.expectedQuantity,
    0
  );
  const totalLinkedQuantity = batches.reduce(
    (sum, batch) => sum + batch.linkedQuantity,
    0
  );
  const filteredBatches = React.useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const normalizedColumnFilters = Object.entries(deferredColumnFilters)
      .map(
        ([key, value]) =>
          [key as InboundBatchFilterKey, value.trim().toLowerCase()] as const
      )
      .filter(([, value]) => value !== "");

    const rows = batches.filter((batch) => {
      if (
        normalizedQuery &&
        !batchSearchText(batch, t("units.batch", { count: batch.batchNo })).includes(normalizedQuery)
      ) {
        return false;
      }

      return normalizedColumnFilters.every(([key, value]) =>
        batchColumnText(batch, key).toLowerCase().includes(value)
      );
    });

    return sortBatches(rows, sort);
  }, [batches, deferredColumnFilters, deferredQuery, sort, t]);
  const hasActiveFilters =
    query.trim() !== "" || hasColumnFilters(columnFilters) || sort !== null;

  const discardBatchDraft = React.useCallback(() => {
    setForm(formBaseline);
    setMessage("");
  }, [formBaseline]);

  useUnsavedForm({
    id: INBOUND_BATCH_FORM_ID,
    label:
      editingBatchId === null
        ? t("unsaved.create")
        : t("unsaved.edit", {
            batch: Number(formBaseline.batchNo),
            date: formBaseline.batchDate,
          }),
    isDirty: !unsavedFormSnapshotsEqual(formBaseline, form),
    isBusy: isSaving,
    discard: discardBatchDraft,
  });

  const loadBatches = React.useCallback(async () => {
    setIsLoading(true);

    try {
      const response = await fetch("/api/inbound/batches", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | InboundBatchesApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("fallback.loadFailed")));
      }

      const nextBatches = payload.batches ?? [];
      const nextForm = createNewForm(nextBatches);
      setBatches(nextBatches);
      setEditingBatchId(null);
      setEditingBatchRevision(null);
      setFormBaseline(nextForm);
      setForm(nextForm);
      setMessage("");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => void loadBatches(), 0);
    return () => window.clearTimeout(timerId);
  }, [loadBatches]);

  function updateForm<K extends keyof InboundBatchForm>(
    key: K,
    value: InboundBatchForm[K]
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeBatchDate(value: string) {
    setForm((current) => ({
      ...current,
      batchDate: value,
      batchNo:
        editingBatchId === null ? String(nextBatchNo(batches, value)) : current.batchNo,
    }));
  }

  function applyNewForm(batchDate = form.batchDate || todayKstDate()) {
    const nextForm = createNewForm(batches, batchDate);
    setEditingBatchId(null);
    setEditingBatchRevision(null);
    setFormBaseline(nextForm);
    setForm(nextForm);
    setMessage("");
  }

  function startNewForm(batchDate = form.batchDate || todayKstDate()) {
    const nextForm = createNewForm(batches, batchDate);
    if (
      editingBatchId === null &&
      unsavedFormSnapshotsEqual(form, nextForm)
    ) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [INBOUND_BATCH_FORM_ID],
      targetLabel: t("unsaved.newTarget"),
      action: () => applyNewForm(batchDate),
    });
  }

  function applyEdit(batch: InboundBatchPlanRowDto) {
    const nextForm = {
      batchDate: batch.batchDate,
      batchNo: String(batch.batchNo),
      expectedQuantity: String(batch.expectedQuantity),
      note: batch.note ?? "",
    };
    setEditingBatchId(batch.id);
    setEditingBatchRevision(batch.revision);
    setFormBaseline(nextForm);
    setForm(nextForm);
    setMessage(t("message.editing", { date: batch.batchDate, batch: batch.batchNo }));
    setMessageTone("neutral");
  }

  function startEdit(batch: InboundBatchPlanRowDto) {
    if (editingBatchId === batch.id) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [INBOUND_BATCH_FORM_ID],
      targetLabel: t("navigation.editTarget", { date: batch.batchDate, batch: batch.batchNo }),
      action: () => applyEdit(batch),
    });
  }

  function requestReload() {
    runGuardedAction({
      intent: "internal-change",
      formIds: [INBOUND_BATCH_FORM_ID],
      targetLabel: t("navigation.reload"),
      action: () => {
        void loadBatches();
      },
    });
  }

  function resetFilters() {
    setQuery("");
    setColumnFilters({ ...emptyColumnFilters });
    setSort(null);
  }

  async function saveInboundBatchPlan() {
    if (isSaving) return;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.batchDate)) {
      setMessage(t("message.dateRequired"));
      setMessageTone("warning");
      return;
    }

    if (!/^\d+$/.test(form.batchNo.trim()) || Number(form.batchNo) <= 0) {
      setMessage(t("message.batchInvalid"));
      setMessageTone("warning");
      return;
    }

    if (
      !/^\d+$/.test(form.expectedQuantity.trim()) ||
      Number(form.expectedQuantity) <= 0
    ) {
      setMessage(t("message.quantityInvalid"));
      setMessageTone("warning");
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/inbound/batches", {
        method: editingBatchId === null ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: editingBatchId,
          expectedRevision: editingBatchRevision,
          batchDate: form.batchDate,
          batchNo: form.batchNo,
          expectedQuantity: form.expectedQuantity,
          note: form.note,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | InboundBatchesApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.batch) {
        throw new Error(legacyApiMessage(payload, t("message.saveFailed")));
      }

      const refreshed = payload.batches
        ? true
        : payload.receipt?.refreshRequired
          ? await loadBatches()
          : false;
      if (payload.batches) {
        setBatches(payload.batches);
        setEditingBatchId(null);
        setEditingBatchRevision(null);
        const nextForm = createNewForm(
          payload.batches,
          payload.batch.batchDate
        );
        setFormBaseline(nextForm);
        setForm(nextForm);
      } else if (!refreshed) {
        setEditingBatchId(null);
        setEditingBatchRevision(null);
        const nextForm = createNewForm(batches, payload.batch.batchDate);
        setFormBaseline(nextForm);
        setForm(nextForm);
      }
      setMessage(
        refreshed
          ? t("message.saved")
          : t("message.refreshRequired", { message: t("message.saved") })
      );
      setMessageTone(refreshed ? "success" : "warning");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteInboundBatchPlan(batch: InboundBatchPlanRowDto) {
    if (isSaving || batch.historicalInboundQuantity > 0) return;

    if (!window.confirm(t("message.deleteConfirm", { date: batch.batchDate, batch: batch.batchNo }))) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/inbound/batches", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: batch.id, expectedRevision: batch.revision }),
      });
      const payload = (await response.json().catch(() => null)) as
        | InboundBatchesApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.batch) {
        throw new Error(legacyApiMessage(payload, t("message.deleteFailed")));
      }

      const refreshed = payload.batches
        ? true
        : payload.receipt?.refreshRequired
          ? await loadBatches()
          : false;
      if (payload.batches) {
        setBatches(payload.batches);
        if (editingBatchId === batch.id) {
          setEditingBatchId(null);
          setEditingBatchRevision(null);
          const nextForm = createNewForm(payload.batches, batch.batchDate);
          setFormBaseline(nextForm);
          setForm(nextForm);
        }
      } else if (!refreshed) {
        const remainingBatches = batches.filter((item) => item.id !== batch.id);
        setBatches(remainingBatches);
        if (editingBatchId === batch.id) {
          setEditingBatchId(null);
          setEditingBatchRevision(null);
          const nextForm = createNewForm(remainingBatches, batch.batchDate);
          setFormBaseline(nextForm);
          setForm(nextForm);
        }
      }
      setMessage(
        refreshed
          ? t("message.deleted")
          : t("message.refreshRequired", { message: t("message.deleted") })
      );
      setMessageTone(refreshed ? "success" : "warning");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  function requestDeleteInboundBatchPlan(batch: InboundBatchPlanRowDto) {
    if (editingBatchId !== batch.id) {
      void deleteInboundBatchPlan(batch);
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [INBOUND_BATCH_FORM_ID],
      targetLabel: t("message.deleteTarget", { date: batch.batchDate, batch: batch.batchNo }),
      action: () => {
        void deleteInboundBatchPlan(batch);
      },
    });
  }

  const columns: DataGridColumn<
    InboundBatchColumnKey,
    InboundBatchPlanRowDto
  >[] = [
    {
      key: "batchDate",
      label: t("columns.batchDate"),
      width: "150px",
      placeholder: "YYYY-MM-DD",
      cellClassName: "flex items-center px-3 tabular-nums",
      render: (batch) => batch.batchDate,
    },
    {
      key: "batchNo",
      label: t("columns.batchNo"),
      width: "100px",
      placeholder: t("placeholders.batch"),
      cellClassName: "flex items-center px-3 font-semibold",
      render: (batch) => t("units.batch", { count: batch.batchNo }),
    },
    {
      key: "expectedQuantity",
      label: t("columns.expected"),
      width: "120px",
      placeholder: t("placeholders.expected"),
      cellClassName: "flex items-center px-3 tabular-nums",
      render: (batch) => t("units.device", { count: batch.expectedQuantity }),
    },
    {
      key: "linkedQuantity",
      label: t("columns.linked"),
      width: "120px",
      placeholder: t("placeholders.linked"),
      cellClassName: "flex items-center px-3 tabular-nums",
      render: (batch) => t("units.device", { count: batch.linkedQuantity }),
    },
    {
      key: "supplierReturnQuantity",
      label: t("columns.supplierReturn"),
      width: "130px",
      placeholder: t("placeholders.supplierReturn"),
      cellClassName: "flex items-center px-3 tabular-nums",
      render: (batch) =>
        t("units.device", { count: batch.supplierReturnQuantity }),
    },
    {
      key: "normalInboundTargetQuantity",
      label: t("columns.normalTarget"),
      width: "150px",
      placeholder: t("placeholders.normalTarget"),
      cellClassName: "flex items-center px-3 tabular-nums",
      render: (batch) =>
        t("units.device", { count: batch.normalInboundTargetQuantity }),
    },
    {
      key: "arrivalDifference",
      label: t("columns.difference"),
      width: "100px",
      placeholder: t("placeholders.difference"),
      cellClassName: "flex items-center px-3 tabular-nums",
      render: (batch) => (
        <span
          className={
            batch.arrivalDifference === 0
              ? "font-medium text-emerald-700"
              : "font-semibold text-amber-700"
          }
          title={
            batch.arrivalDifference < 0
              ? t("tooltips.differenceShort", { count: Math.abs(batch.arrivalDifference) })
              : batch.arrivalDifference > 0
                ? t("tooltips.differenceExtra", { count: batch.arrivalDifference })
                : t("tooltips.differenceEqual")
          }
        >
          {t("units.signedDevice", {
            value: arrivalDifferenceText(batch.arrivalDifference, locale),
          })}
        </span>
      ),
    },
    {
      key: "note",
      label: t("columns.note"),
      width: "minmax(260px,1fr)",
      placeholder: t("placeholders.note"),
      cellClassName: "min-w-0 px-3 py-2",
      render: (batch) => <div className="truncate">{batch.note || "-"}</div>,
    },
    {
      key: "actions",
      label: t("columns.actions"),
      width: "112px",
      sortable: false,
      filterable: false,
      headerClassName: "justify-end",
      cellClassName: "flex items-center justify-end gap-1 px-3",
      render: (batch) => (
        <>
          <Button
            size="icon"
            variant="ghost"
            disabled={isSaving}
            title={t("actions.edit")}
            onClick={(event) => {
              event.stopPropagation();
              startEdit(batch);
            }}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={
              isSaving || batch.historicalInboundQuantity > 0
            }
            title={
              batch.historicalInboundQuantity > 0
                ? t("tooltips.deleteBlocked", { count: batch.historicalInboundQuantity })
                : t("actions.delete")
            }
            onClick={(event) => {
              event.stopPropagation();
              requestDeleteInboundBatchPlan(batch);
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </>
      ),
    },
  ];

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden p-5">
      <div className="grid shrink-0 grid-cols-3 overflow-hidden rounded-md border bg-popover">
        <BatchSummaryCell icon={ClipboardList} label={t("summary.batches")} value={batches.length} />
        <BatchSummaryCell icon={PackagePlus} label={t("summary.expected")} value={totalExpectedQuantity} />
        <BatchSummaryCell icon={PackageCheck} label={t("summary.linked")} value={totalLinkedQuantity} />
      </div>

      <section className="grid shrink-0 gap-4 rounded-md border bg-popover p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              {editingBatchId === null ? t("title.create") : t("title.edit")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("description")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => startNewForm()}>
              <Plus className="size-4" />{t("actions.new")}
            </Button>
            <Button onClick={saveInboundBatchPlan} disabled={isSaving}>
              <Save className="size-4" />
              {isSaving ? t("actions.saving") : editingBatchId === null ? t("actions.create") : t("actions.save")}
            </Button>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[170px_120px_140px_minmax(240px,1fr)]">
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("fields.batchDate")}</span>
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="date"
                className="pl-9"
                value={form.batchDate}
                onChange={(event) => changeBatchDate(event.target.value)}
              />
            </div>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("fields.batchNo")}</span>
            <Input
              inputMode="numeric"
              value={form.batchNo}
              placeholder={t("fields.batchNoPlaceholder")}
              onChange={(event) => updateForm("batchNo", event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("fields.expected")}</span>
            <Input
              inputMode="numeric"
              value={form.expectedQuantity}
              placeholder={t("fields.expectedPlaceholder")}
              onChange={(event) => updateForm("expectedQuantity", event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("fields.note")}</span>
            <Input
              value={form.note}
              placeholder={t("fields.notePlaceholder")}
              onChange={(event) => updateForm("note", event.target.value)}
            />
          </label>
        </div>
      </section>

      {message ? (
        <FeedbackBanner
          tone={
            messageTone === "success"
              ? "success"
              : messageTone === "warning"
                ? "warning"
                : "neutral"
          }
          className="shrink-0"
        >
          {message}
        </FeedbackBanner>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <SearchInput
            label={t("filters.search")}
            wrapperClassName="min-w-[280px] flex-1"
            placeholder={t("filters.placeholder")}
            value={query}
            onValueChange={setQuery}
          />
          <Button variant="outline" onClick={resetFilters} disabled={!hasActiveFilters}>
            <RefreshCcw className="size-4" />{t("actions.reset")}
          </Button>
          <Button variant="outline" onClick={requestReload} disabled={isLoading}>
            <RefreshCcw className="size-4" />
            {isLoading ? t("actions.refreshing") : t("actions.refresh")}
          </Button>
        </div>

        <div className="shrink-0 text-xs text-muted-foreground">
          {t("filters.count", { count: filteredBatches.length })}
        </div>

        <VirtualizedDataGrid
          rows={filteredBatches}
          columns={columns}
          rowKey={(batch) => batch.id}
          emptyMessage={t("empty")}
          filters={columnFilters}
          sort={sort}
          onFilterChange={(key, value) => {
            if (key !== "actions") {
              setColumnFilters((current) => ({ ...current, [key]: value }));
            }
          }}
          onSortChange={setSort}
          onRowClick={startEdit}
          minWidth="1420px"
          rowHeight={52}
        />
      </section>
    </section>
  );
}
