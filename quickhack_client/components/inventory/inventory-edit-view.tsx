// QuickHack note: 기존 재고 수정 메뉴의 기기 선택, 수정 사유, 저장 확인, 재고 전체 기록 편집 화면입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import { PencilLine } from "lucide-react";
import type {
  DeviceDetailRecords,
  DeviceListItem,
  StatusTone,
} from "@/quickhack_shared/device/types";
import type { DeviceListRow } from "@/quickhack_shared/device/device-list-query";
import type {
  DeviceHistoryPage,
  DeviceHistorySection,
} from "@/quickhack_shared/device/device-history";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import type { ProductCriteriaPayload } from "@/quickhack_shared/catalog/product-criteria";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { Input } from "@/quickhack_client/components/ui/input";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import { TableSelectCheckbox } from "@/quickhack_client/components/ui/table-select-checkbox";
import { MasterDetailLayout } from "@/quickhack_client/components/ui/workspace-layout";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  DangerousConfirmDialog,
  dangerousActionButtonClassName,
} from "@/quickhack_client/components/security/sensitive-action-guards";
import {
  InventoryRelatedRecordFields,
  buildInventoryCorrectionOptionSets,
} from "@/quickhack_client/components/inventory/inventory-correction-records";
import {
  applyBulkInventoryCorrectionChanges,
  applyInventoryPendingTextDrafts,
  cloneDeviceDetailRecords,
  collectInventoryCorrectionChanges,
  emptyDeviceDetailRecords,
  inventoryCorrectionFieldKey,
  inventoryCorrectionPatches,
  type EditableInventoryCorrectionGroup,
  type InventoryPendingTextDraft,
} from "@/quickhack_client/components/inventory/inventory-correction-changes";
import {
  detailFieldLabel,
  statusBadge,
  statusLabel,
} from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { cn } from "@/quickhack_shared/core/utils";
import { POST_WRITE_REFRESH_WARNING_KEY } from "@/quickhack_client/lib/post-write-refresh";
import {
  requestDeviceDetail,
  requestDeviceHistoryPage,
  useDeviceListQuery,
} from "@/quickhack_client/components/shared/device-list-query-client";

type InventoryCorrectionApiResponse = {
  ok: boolean;
  message?: string;
  updatedCount?: number;
  pgNos?: string[];
};

type InventoryEditForm = {
  pgNo: string;
  editReason: string;
};

type ProductCriteriaApiResponse = {
  ok: boolean;
  message?: string;
  data?: ProductCriteriaPayload;
};

const INVENTORY_CORRECTION_FORM_ID = "inventory.correction";
const INVENTORY_CORRECTION_HISTORY_SECTIONS = [
  "inbounds",
  "inspections",
  "orderItems",
  "channelOrderMatches",
] as const satisfies readonly DeviceHistorySection[];

type InventoryCorrectionHistoryPages = Partial<
  Record<DeviceHistorySection, DeviceHistoryPage>
>;

async function requestInventoryCorrectionHistory(
  pgNo: string,
  fallbackMessage: string,
  signal?: AbortSignal
) {
  const pages = await Promise.all(
    INVENTORY_CORRECTION_HISTORY_SECTIONS.map((section) =>
      requestDeviceHistoryPage(pgNo, section, fallbackMessage, null, signal)
    )
  );
  return Object.fromEntries(
    pages.map((page) => [page.section, page])
  ) as InventoryCorrectionHistoryPages;
}

function recordsWithHistoryPages(
  records: DeviceDetailRecords,
  pages: InventoryCorrectionHistoryPages,
  append = false
) {
  const next = cloneDeviceDetailRecords(records);
  for (const section of INVENTORY_CORRECTION_HISTORY_SECTIONS) {
    const page = pages[section];
    if (!page) continue;
    const current = append ? next[section] : [];
    const ids = new Set(current.map((record) => record.id));
    next[section] = [
      ...current,
      ...page.items.filter((record) => !ids.has(record.id)),
    ];
  }
  return next;
}

function emptyInventoryEditForm(): InventoryEditForm {
  return {
    pgNo: "",
    editReason: "",
  };
}

function inventoryEditFormFromDevice(device: DeviceListItem): InventoryEditForm {
  return {
    pgNo: device.pgNo,
    editReason: "",
  };
}

function inventoryEditSearchableText(device: DeviceListRow) {
  return [
    device.pgNo,
    device.imei,
    device.model,
    device.modelSeq,
    formatModelSeqLabel(device.model, device.modelSeq),
    device.storage,
    device.color,
    device.appearanceGrade,
    device.appearanceDefect,
    device.functionDefect,
    device.saleGrade,
    device.warranty,
    device.inbound?.supplierName,
    device.inventory?.location,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

async function requestDeviceDetailsInBatches(
  devices: DeviceListRow[],
  fallbackMessage: string,
  batchSize = 8
) {
  const details: DeviceListItem[] = [];
  for (let index = 0; index < devices.length; index += batchSize) {
    details.push(
      ...(await Promise.all(
        devices
          .slice(index, index + batchSize)
          .map((device) => requestDeviceDetail(device.pgNo, fallbackMessage))
      ))
    );
  }
  return details;
}

export function InventoryEditView({
  initialPgNo,
  isWorkspaceRefreshing = false,
  onInitialPgNoConsumed,
}: {
  initialPgNo?: string | null;
  isWorkspaceRefreshing?: boolean;
  onInitialPgNoConsumed?: () => void;
}) {
  const feedbackT = useTranslations("common.feedback");
  const t = useTranslations("inventory.edit");
  const detailT = useTranslations("common.deviceDetail");
  const queryT = useTranslations("common.deviceQuery");
  const deviceList = useDeviceListQuery({
    endpoint: "/api/inventory/devices",
    queryString: "context=CORRECTION&limit=100",
    autoLoadAll: true,
  });
  const devices = deviceList.items;
  const normalizedInitialPgNo = initialPgNo?.trim() ?? "";
  const [query, setQuery] = React.useState(normalizedInitialPgNo);
  const [selectedPgNo, setSelectedPgNo] = React.useState(normalizedInitialPgNo);
  const [selectedDevice, setSelectedDevice] =
    React.useState<DeviceListItem | null>(null);
  const [isDetailLoading, setIsDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState("");
  const detailAbortRef = React.useRef<AbortController | null>(null);
  const [form, setForm] = React.useState<InventoryEditForm>(emptyInventoryEditForm);
  const [editRecords, setEditRecords] = React.useState<DeviceDetailRecords>(
    emptyDeviceDetailRecords
  );
  const [baselineRecords, setBaselineRecords] =
    React.useState<DeviceDetailRecords>(emptyDeviceDetailRecords);
  const [historyPages, setHistoryPages] =
    React.useState<InventoryCorrectionHistoryPages>({});
  const [isHistoryLoadingMore, setIsHistoryLoadingMore] = React.useState(false);
  const [historyError, setHistoryError] = React.useState("");
  const [selectedBulkPgNos, setSelectedBulkPgNos] = React.useState<Set<string>>(
    () => new Set()
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [isSaveConfirmOpen, setIsSaveConfirmOpen] = React.useState(false);
  const [isBulkConfirmOpen, setIsBulkConfirmOpen] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<StatusTone>("neutral");
  const [postWriteRefreshWarning, setPostWriteRefreshWarning] =
    React.useState("");
  const [criteria, setCriteria] = React.useState<ProductCriteriaPayload | null>(
    null
  );
  const [pendingTextDrafts, setPendingTextDrafts] = React.useState<
    Map<string, InventoryPendingTextDraft>
  >(() => new Map());
  const { runGuardedAction } = useUnsavedChanges();
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedEditReason = form.editReason.trim();

  React.useEffect(() => {
    let ignore = false;

    async function loadCriteria() {
      try {
        const response = await fetch("/api/product-criteria", {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as
          | ProductCriteriaApiResponse
          | null;

        if (!ignore && response.ok && payload?.ok && payload.data) {
          setCriteria(payload.data);
        }
      } catch {
        if (!ignore) {
          setCriteria(null);
        }
      }
    }

    void loadCriteria();

    return () => {
      ignore = true;
    };
  }, []);

  const filteredDevices = React.useMemo(() => {
    if (!normalizedQuery) {
      return devices;
    }

    return devices.filter((device) =>
      inventoryEditSearchableText(device).includes(normalizedQuery)
    );
  }, [devices, normalizedQuery]);
  const selectedBulkDevices = React.useMemo(
    () => devices.filter((device) => selectedBulkPgNos.has(device.pgNo)),
    [devices, selectedBulkPgNos]
  );
  const inventoryCorrectionOptionSets = React.useMemo(
    () => buildInventoryCorrectionOptionSets(criteria, devices),
    [criteria, devices]
  );
  const effectiveEditRecords = React.useMemo(
    () =>
      applyInventoryPendingTextDrafts(
        editRecords,
        Array.from(pendingTextDrafts.values())
      ),
    [editRecords, pendingTextDrafts]
  );
  const correctionChanges = React.useMemo(
    () =>
      selectedDevice
        ? collectInventoryCorrectionChanges(baselineRecords, effectiveEditRecords)
        : [],
    [baselineRecords, effectiveEditRecords, selectedDevice]
  );
  const changedFieldKeys = React.useMemo(
    () => new Set(correctionChanges.map((change) => change.key)),
    [correctionChanges]
  );
  const bulkChanges = React.useMemo(
    () => correctionChanges.filter((change) => change.bulkApplicable),
    [correctionChanges]
  );

  const clearPendingTextDrafts = React.useCallback(() => {
    setPendingTextDrafts(new Map());
  }, []);

  const discardCorrectionDraft = React.useCallback(() => {
    setForm(
      selectedDevice
        ? inventoryEditFormFromDevice(selectedDevice)
        : emptyInventoryEditForm()
    );
    setEditRecords(
      selectedDevice
        ? cloneDeviceDetailRecords(baselineRecords)
        : emptyDeviceDetailRecords()
    );
    clearPendingTextDrafts();
    setIsSaveConfirmOpen(false);
    setIsBulkConfirmOpen(false);
    setMessage("");
    setPostWriteRefreshWarning("");
  }, [baselineRecords, clearPendingTextDrafts, selectedDevice]);

  useUnsavedForm({
    id: INVENTORY_CORRECTION_FORM_ID,
    label: selectedDevice
      ? t("unsaved.device", { pg: selectedDevice.pgNo })
      : t("unsaved.form"),
    enabled: Boolean(selectedDevice),
    isDirty:
      correctionChanges.length > 0 || normalizedEditReason.length > 0,
    isBusy: isSaving,
    discard: discardCorrectionDraft,
  });

  function updateForm(key: keyof InventoryEditForm, value: string) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  const updateDetailRecordField = React.useCallback((
    group: keyof DeviceDetailRecords,
    recordId: string,
    fieldKey: string,
    value: string
  ) => {
    setEditRecords((current) => ({
      ...current,
      [group]: current[group].map((record) =>
        record.id === recordId
          ? {
              ...record,
              fields: record.fields.map((field) =>
                field.key === fieldKey
                  ? {
                      ...field,
                      value,
                      displayValue: undefined,
                    }
                  : field
              ),
            }
          : record
      ),
    }));
  }, []);

  const updatePendingTextDraft = React.useCallback(
    (
      group: EditableInventoryCorrectionGroup,
      recordId: string,
      fieldKey: string,
      value: string | null,
      isChanged: boolean
    ) => {
      const key = inventoryCorrectionFieldKey(group, recordId, fieldKey);

      setPendingTextDrafts((current) => {
        const next = new Map(current);
        if (value === null || !isChanged) {
          next.delete(key);
        } else {
          next.set(key, {
            group,
            recordId,
            fieldKey,
            value,
          });
        }
        return next;
      });
    },
    []
  );

  function currentCorrectionState() {
    const records = applyInventoryPendingTextDrafts(
      editRecords,
      Array.from(pendingTextDrafts.values())
    );
    const changes = selectedDevice
      ? collectInventoryCorrectionChanges(baselineRecords, records)
      : [];

    return {
      records,
      changes,
      bulkChanges: changes.filter((change) => change.bulkApplicable),
    };
  }

  const applyDeviceSelection = React.useCallback((
    device: DeviceListItem,
    pages: InventoryCorrectionHistoryPages = {}
  ) => {
    const completeRecords = recordsWithHistoryPages(device.detailRecords, pages);
    const deviceWithHistory = { ...device, detailRecords: completeRecords };
    setSelectedPgNo(device.pgNo);
    setSelectedDevice(deviceWithHistory);
    setForm(inventoryEditFormFromDevice(deviceWithHistory));
    setBaselineRecords(cloneDeviceDetailRecords(completeRecords));
    setEditRecords(cloneDeviceDetailRecords(completeRecords));
    setHistoryPages(pages);
    setHistoryError("");
    clearPendingTextDrafts();
    setIsSaveConfirmOpen(false);
    setIsBulkConfirmOpen(false);
    setMessage("");
    setPostWriteRefreshWarning("");
  }, [clearPendingTextDrafts]);

  const loadDeviceSelection = React.useCallback(async (pgNo: string) => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setSelectedPgNo(pgNo);
    setSelectedDevice(null);
    setForm(emptyInventoryEditForm());
    setBaselineRecords(emptyDeviceDetailRecords());
    setEditRecords(emptyDeviceDetailRecords());
    setHistoryPages({});
    setHistoryError("");
    clearPendingTextDrafts();
    setIsDetailLoading(true);
    setDetailError("");

    try {
      const [device, pages] = await Promise.all([
        requestDeviceDetail(pgNo, queryT("detailFailed"), controller.signal),
        requestInventoryCorrectionHistory(
          pgNo,
          queryT("historyFailed"),
          controller.signal
        ),
      ]);
      if (!controller.signal.aborted) applyDeviceSelection(device, pages);
      return device;
    } catch (error) {
      if (!controller.signal.aborted) {
        setSelectedDevice(null);
        setForm(emptyInventoryEditForm());
        setBaselineRecords(emptyDeviceDetailRecords());
        setEditRecords(emptyDeviceDetailRecords());
        setHistoryPages({});
        setDetailError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      if (!controller.signal.aborted) setIsDetailLoading(false);
    }
  }, [applyDeviceSelection, clearPendingTextDrafts, queryT]);

  function selectDevice(device: DeviceListRow) {
    if (device.pgNo === selectedPgNo) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [INVENTORY_CORRECTION_FORM_ID],
      targetLabel: t("unsaved.openDevice", { pg: device.pgNo }),
      action: () => {
        void loadDeviceSelection(device.pgNo).catch(() => undefined);
        onInitialPgNoConsumed?.();
      },
    });
  }

  React.useEffect(() => {
    if (!normalizedInitialPgNo) {
      return;
    }

    let canceled = false;
    queueMicrotask(() => {
      if (canceled) {
        return;
      }

      setQuery(normalizedInitialPgNo);
      const target = devices.find(
        (device) => device.pgNo === normalizedInitialPgNo
      );

      if (!target) {
        setSelectedPgNo(normalizedInitialPgNo);
        setMessage(
          isWorkspaceRefreshing
            ? t("message.focusRefreshing", { pg: normalizedInitialPgNo })
            : t("message.focusNotFound", { pg: normalizedInitialPgNo })
        );
        setMessageTone(isWorkspaceRefreshing ? "neutral" : "warning");
        return;
      }

      if (form.pgNo === target.pgNo) {
        setMessage("");
        onInitialPgNoConsumed?.();
        return;
      }

      runGuardedAction({
        intent: "internal-change",
        formIds: [INVENTORY_CORRECTION_FORM_ID],
        targetLabel: t("unsaved.openDevice", { pg: target.pgNo }),
        action: () => {
          void loadDeviceSelection(target.pgNo).catch(() => undefined);
          onInitialPgNoConsumed?.();
        },
      });
    });

    return () => {
      canceled = true;
    };
  }, [
    applyDeviceSelection,
    devices,
    form.pgNo,
    isWorkspaceRefreshing,
    normalizedInitialPgNo,
    onInitialPgNoConsumed,
    runGuardedAction,
    loadDeviceSelection,
    t,
  ]);

  React.useEffect(() => {
    if (
      normalizedInitialPgNo ||
      deviceList.isLoading ||
      selectedPgNo ||
      devices.length === 0
    ) {
      return;
    }

    let canceled = false;
    queueMicrotask(() => {
      if (!canceled) {
        void loadDeviceSelection(devices[0].pgNo).catch(() => undefined);
      }
    });
    return () => {
      canceled = true;
    };
  }, [
    deviceList.isLoading,
    devices,
    loadDeviceSelection,
    normalizedInitialPgNo,
    selectedPgNo,
  ]);

  React.useEffect(
    () => () => {
      detailAbortRef.current?.abort();
    },
    []
  );

  function setBulkSelected(pgNo: string, checked: boolean) {
    setSelectedBulkPgNos((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(pgNo);
      } else {
        next.delete(pgNo);
      }

      return next;
    });
  }

  function setVisibleBulkSelected(rows: DeviceListRow[], checked: boolean) {
    setSelectedBulkPgNos((current) => {
      const next = new Set(current);

      for (const device of rows) {
        if (checked) {
          next.add(device.pgNo);
        } else {
          next.delete(device.pgNo);
        }
      }

      return next;
    });
  }

  const hasMoreHistory = INVENTORY_CORRECTION_HISTORY_SECTIONS.some(
    (section) => historyPages[section]?.hasMore
  );

  async function loadMoreHistory() {
    if (!selectedDevice || isHistoryLoadingMore || !hasMoreHistory) return;
    setIsHistoryLoadingMore(true);
    setHistoryError("");
    try {
      const pages = await Promise.all(
        INVENTORY_CORRECTION_HISTORY_SECTIONS.flatMap((section) => {
          const current = historyPages[section];
          return current?.hasMore && current.nextCursor
            ? [
                requestDeviceHistoryPage(
                  selectedDevice.pgNo,
                  section,
                  queryT("historyFailed"),
                  current.nextCursor
                ),
              ]
            : [];
        })
      );
      const loadedPages = Object.fromEntries(
        pages.map((page) => [page.section, page])
      ) as InventoryCorrectionHistoryPages;
      setBaselineRecords((records) =>
        recordsWithHistoryPages(records, loadedPages, true)
      );
      setEditRecords((records) =>
        recordsWithHistoryPages(records, loadedPages, true)
      );
      setSelectedDevice((current) =>
        current
          ? {
              ...current,
              detailRecords: recordsWithHistoryPages(
                current.detailRecords,
                loadedPages,
                true
              ),
            }
          : current
      );
      setHistoryPages((currentPages) => {
        const nextPages = { ...currentPages };
        for (const page of pages) {
          const current = currentPages[page.section];
          nextPages[page.section] = {
            ...page,
            items: [...(current?.items ?? []), ...page.items],
          };
        }
        return nextPages;
      });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsHistoryLoadingMore(false);
    }
  }

  async function refreshDeviceAfterWrite(pgNo: string) {
    const [, updatedDevice, pages] = await Promise.all([
      deviceList.reload(),
      requestDeviceDetail(pgNo, queryT("detailFailed")),
      requestInventoryCorrectionHistory(pgNo, queryT("historyFailed")),
    ]);
    const refreshedRecords = recordsWithHistoryPages(
      updatedDevice.detailRecords,
      pages
    );
    setSelectedPgNo(updatedDevice.pgNo);
    setSelectedDevice({ ...updatedDevice, detailRecords: refreshedRecords });
    setForm(inventoryEditFormFromDevice(updatedDevice));
    setBaselineRecords(refreshedRecords);
    setEditRecords(refreshedRecords);
    setHistoryPages(pages);
    setHistoryError("");
    clearPendingTextDrafts();
  }

  async function saveCorrection() {
    if (!form.pgNo || isSaving) {
      return;
    }

    const currentState = currentCorrectionState();
    if (currentState.changes.length === 0) {
      setMessage(t("message.noChanges"));
      setMessageTone("warning");
      return;
    }

    if (!normalizedEditReason) {
      setMessage(t("message.reasonRequired"));
      setMessageTone("warning");
      return;
    }

    setIsSaveConfirmOpen(false);
    setIsSaving(true);
    setMessage("");
    setPostWriteRefreshWarning("");

    try {
      const response = await fetch(
        `/api/inventory/devices/${encodeURIComponent(form.pgNo)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pgNo: form.pgNo,
            editReason: normalizedEditReason,
            patches: inventoryCorrectionPatches(
              currentState.changes,
              t("message.missingRevision")
            ),
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | InventoryCorrectionApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("message.saveFailed")));
      }

      const committedRecords = cloneDeviceDetailRecords(currentState.records);
      setForm((current) => ({ ...current, editReason: "" }));
      setBaselineRecords(committedRecords);
      setEditRecords(committedRecords);
      clearPendingTextDrafts();
      setMessage(t("message.saved"));
      setMessageTone("success");

      try {
        await refreshDeviceAfterWrite(form.pgNo);
      } catch {
        setPostWriteRefreshWarning(feedbackT(POST_WRITE_REFRESH_WARNING_KEY));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveBulkCorrection() {
    if (isSaving) {
      return;
    }

    const currentState = currentCorrectionState();

    if (!normalizedEditReason) {
      setMessage(t("message.reasonRequired"));
      setMessageTone("warning");
      return;
    }

    if (selectedBulkDevices.length === 0) {
      setMessage(t("message.selectionRequired"));
      setMessageTone("warning");
      return;
    }

    if (currentState.bulkChanges.length === 0) {
      setMessage(t("message.noBulkColumns"));
      setMessageTone("warning");
      return;
    }

    setIsBulkConfirmOpen(false);
    setIsSaving(true);
    setMessage("");
    setPostWriteRefreshWarning("");

    let selectedBulkDeviceDetails: DeviceListItem[];
    try {
      selectedBulkDeviceDetails = await requestDeviceDetailsInBatches(
        selectedBulkDevices,
        queryT("detailFailed")
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
      setIsSaving(false);
      return;
    }

    const items = selectedBulkDeviceDetails
      .map((device) => {
        const result = applyBulkInventoryCorrectionChanges(
          device.detailRecords,
          currentState.bulkChanges
        );
        const targetChanges = collectInventoryCorrectionChanges(
          device.detailRecords,
          result.records
        );

        return result.appliedCount > 0
          ? {
              pgNo: device.pgNo,
              patches: inventoryCorrectionPatches(
                targetChanges,
                t("message.missingRevision")
              ),
              records: result.records,
            }
          : null;
      })
      .filter(
        (
          item
        ): item is {
          pgNo: string;
          patches: ReturnType<typeof inventoryCorrectionPatches>;
          records: DeviceDetailRecords;
        } => Boolean(item)
      );

    if (items.length === 0) {
      setMessage(t("message.noApplicableColumns"));
      setMessageTone("warning");
      setIsBulkConfirmOpen(false);
      return;
    }

    try {
      const response = await fetch("/api/inventory/devices/bulk-correction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          editReason: normalizedEditReason,
          items: items.map(({ pgNo, patches }) => ({ pgNo, patches })),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | InventoryCorrectionApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("message.bulkSaveFailed")));
      }

      const currentCommittedItem = items.find((item) => item.pgNo === form.pgNo);
      const committedRecords = cloneDeviceDetailRecords(
        currentCommittedItem?.records ??
          selectedDevice?.detailRecords ??
          emptyDeviceDetailRecords()
      );
      setForm((current) => ({ ...current, editReason: "" }));
      setBaselineRecords(committedRecords);
      setEditRecords(committedRecords);
      setSelectedBulkPgNos(new Set());
      clearPendingTextDrafts();
      setMessage(t("message.bulkSaved"));
      setMessageTone("success");

      try {
        await refreshDeviceAfterWrite(form.pgNo);
      } catch {
        setPostWriteRefreshWarning(feedbackT(POST_WRITE_REFRESH_WARNING_KEY));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  const deviceSelectorColumns = React.useMemo<
    DataGridColumn<"select" | "pgNo" | "model" | "status", DeviceListRow>[]
  >(
    () => [
      {
        key: "select",
        label: "",
        width: "40px",
        sortable: false,
        filterable: false,
        headerClassName: "justify-center",
        cellClassName: "flex items-center justify-center",
        headerRender: ({ displayRows }) => {
          const selectableRows = displayRows;
          const checkedCount = selectableRows.filter((device) =>
            selectedBulkPgNos.has(device.pgNo)
          ).length;

          return (
            <TableSelectCheckbox
              checked={
                selectableRows.length > 0 && checkedCount === selectableRows.length
              }
              indeterminate={
                checkedCount > 0 && checkedCount < selectableRows.length
              }
              disabled={selectableRows.length === 0}
              ariaLabel={t("selection.allAria")}
              onCheckedChange={(checked) =>
                setVisibleBulkSelected(selectableRows, checked)
              }
            />
          );
        },
        render: (device) => (
          <div onClick={(event) => event.stopPropagation()}>
            <TableSelectCheckbox
              checked={selectedBulkPgNos.has(device.pgNo)}
              ariaLabel={t("selection.itemAria", { pg: device.pgNo })}
              onCheckedChange={(checked) => setBulkSelected(device.pgNo, checked)}
            />
          </div>
        ),
      },
      {
        key: "pgNo",
        label: "PG",
        width: "126px",
        placeholder: t("placeholders.pg"),
        cellClassName: "flex items-center px-3 font-semibold",
        render: (device) => device.pgNo,
        text: (device) => device.pgNo,
      },
      {
        key: "model",
        label: t("columns.model"),
        width: "minmax(220px,1fr)",
        placeholder: t("placeholders.model"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (device) => (
          <>
            <div className="truncate font-medium">{device.model}</div>
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {[device.storage, device.color].filter(Boolean).length === 0 &&
              !device.saleGrade
                ? "-"
                : null}
              {[device.storage, device.color]
                .filter(Boolean)
                .map((value) => (
                  <span key={value} className="truncate">
                    {value}
                  </span>
                ))}
              {device.saleGrade ? (
                <SaleGradeBadge value={device.saleGrade} className="min-w-8 px-1.5" />
              ) : null}
            </div>
          </>
        ),
        text: (device) =>
          [device.model, device.storage, device.color, device.saleGrade]
            .filter(Boolean)
            .join(" "),
      },
      {
        key: "status",
        label: t("columns.status"),
        width: "96px",
        placeholder: t("placeholders.status"),
        cellClassName: "flex items-center px-3",
        render: (device) => statusBadge(device.displayStatus, detailT),
        text: (device) =>
          [statusLabel(device.displayStatus, detailT), device.displayStatus]
            .filter(Boolean)
            .join(" "),
      },
    ],
    [detailT, selectedBulkPgNos, t]
  );

  return (
    <MasterDetailLayout
      as="section"
      className="grid-cols-[minmax(420px,500px)_minmax(0,1fr)] gap-4 p-5"
    >
      <div className="flex min-h-0 flex-col rounded-md border bg-popover">
        <div className="border-b p-3">
          <SearchInput
            placeholder={t("placeholders.query")}
            value={query}
            onValueChange={setQuery}
          />
        </div>
        <VirtualizedDataGrid
          rows={filteredDevices}
          columns={deviceSelectorColumns}
          rowKey={(device) => device.pgNo}
          emptyMessage={t("empty")}
          selectedRowKey={selectedDevice?.pgNo ?? null}
          onRowClick={selectDevice}
          className="rounded-none border-0"
          minWidth="482px"
          rowHeight={58}
        />
      </div>

      <div className="min-h-0 overflow-auto">
        <div className="grid gap-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{t("title")}</h2>
              <p className="text-xs text-muted-foreground">
                {t("selection.summary", {
                  changed: correctionChanges.length,
                  pg: form.pgNo || "-",
                  selected: selectedBulkDevices.length,
                })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setSelectedBulkPgNos(new Set<string>())}
                disabled={selectedBulkDevices.length === 0 || isSaving}
              >
                {t("actions.clearSelection")}
              </Button>
              <Button
                variant="outline"
                className={dangerousActionButtonClassName}
                onClick={() => setIsBulkConfirmOpen(true)}
                disabled={
                  selectedBulkDevices.length === 0 ||
                  bulkChanges.length === 0 ||
                  !normalizedEditReason ||
                  isSaving
                }
              >
                <PencilLine className="size-4" />
                {t("actions.applyBulk")}
              </Button>
              <Button
                variant="outline"
                className={dangerousActionButtonClassName}
                onClick={() => setIsSaveConfirmOpen(true)}
                disabled={
                  !form.pgNo ||
                  correctionChanges.length === 0 ||
                  !normalizedEditReason ||
                  isSaving
                }
              >
                <PencilLine className="size-4" />
                {isSaving ? t("actions.saving") : t("actions.save")}
              </Button>
            </div>
          </div>

          <DangerousConfirmDialog
            open={isSaveConfirmOpen}
            title={t("confirm.title")}
            description={t("confirm.description")}
            detail={
              <>
                {t("confirm.detail", {
                  pg: form.pgNo || "-",
                  reason: normalizedEditReason || "-",
                })}
              </>
            }
            confirmLabel={t("actions.save")}
            busyLabel={t("actions.saving")}
            isBusy={isSaving}
            onCancel={() => setIsSaveConfirmOpen(false)}
            onConfirm={() => void saveCorrection()}
          />
          <DangerousConfirmDialog
            open={isBulkConfirmOpen}
            title={t("bulk.title")}
            description={t("bulk.description")}
            detail={
              <>
                {t("bulk.summary", {
                  changed: bulkChanges.length,
                  selected: selectedBulkDevices.length,
                })}
                <div className="mt-2 grid gap-1 text-xs font-normal">
                  {bulkChanges.slice(0, 6).map((change) => (
                    <div key={`${change.group}-${change.recordIndex}-${change.fieldKey}`}>
                      {detailFieldLabel(change.fieldKey, detailT)}:{" "}
                      <span className="font-semibold">{change.value || t("bulk.emptyValue")}</span>
                    </div>
                  ))}
                  {bulkChanges.length > 6 ? (
                    <div>{t("bulk.moreColumns", { count: bulkChanges.length - 6 })}</div>
                  ) : null}
                </div>
              </>
            }
            confirmLabel={t("bulk.confirm")}
            busyLabel={t("actions.saving")}
            isBusy={isSaving}
            onCancel={() => setIsBulkConfirmOpen(false)}
            onConfirm={() => void saveBulkCorrection()}
          />

          {message ? (
            <FeedbackBanner
              tone={messageTone === "success" ? "success" : "warning"}
            >
              {message}
            </FeedbackBanner>
          ) : null}

          {postWriteRefreshWarning ? (
            <FeedbackBanner tone="warning">
              {postWriteRefreshWarning}
            </FeedbackBanner>
          ) : null}

          {deviceList.error ? (
            <FeedbackBanner tone="warning">{deviceList.error}</FeedbackBanner>
          ) : null}

          {detailError ? (
            <FeedbackBanner tone="warning">{detailError}</FeedbackBanner>
          ) : null}

          {isDetailLoading ? (
            <FeedbackBanner tone="neutral">
              {t("loadingDetail")}
            </FeedbackBanner>
          ) : null}

          <section className="grid gap-2 rounded-md border bg-popover p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">{t("reason.title")}</h3>
              <span
                className={cn(
                  "text-xs",
                  normalizedEditReason
                    ? "text-emerald-700"
                    : "text-amber-700"
                )}
              >
                {normalizedEditReason
                  ? t("reason.ready")
                  : t("reason.required")}
              </span>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                {t("reason.label")}
              </span>
              <Input
                value={form.editReason}
                placeholder={t("placeholders.reason")}
                onChange={(event) => updateForm("editReason", event.target.value)}
              />
            </label>
          </section>

          {selectedDevice ? (
            <section className="grid gap-4">
              <h3 className="text-sm font-semibold">{t("history.title")}</h3>
              <InventoryRelatedRecordFields
                records={editRecords}
                originalRecords={baselineRecords}
                changedFieldKeys={changedFieldKeys}
                criteria={criteria}
                optionSets={inventoryCorrectionOptionSets}
                onFieldChange={updateDetailRecordField}
                onDraftFieldChange={updatePendingTextDraft}
              />
              {historyError ? (
                <FeedbackBanner tone="danger">{historyError}</FeedbackBanner>
              ) : null}
              <div className="flex items-center justify-between gap-3 rounded-md border bg-popover p-3 text-xs text-muted-foreground">
                <span>
                  {t("history.description")}
                </span>
                {hasMoreHistory ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isHistoryLoadingMore}
                    onClick={() => void loadMoreHistory()}
                  >
                    {isHistoryLoadingMore
                      ? t("actions.loading")
                      : t("actions.loadMoreHistory")}
                  </Button>
                ) : (
                  <span>{t("history.allLoaded")}</span>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </MasterDetailLayout>
  );
}
