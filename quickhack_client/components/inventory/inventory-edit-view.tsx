// QuickHack note: 기존 재고 수정 메뉴의 기기 선택, 수정 사유, 저장 확인, 재고 전체 기록 편집 화면입니다.
"use client";

import * as React from "react";
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
  statusBadge,
  statusMap,
} from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { cn } from "@/quickhack_shared/core/utils";
import { POST_WRITE_REFRESH_WARNING } from "@/quickhack_client/lib/post-write-refresh";
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
  signal?: AbortSignal
) {
  const pages = await Promise.all(
    INVENTORY_CORRECTION_HISTORY_SECTIONS.map((section) =>
      requestDeviceHistoryPage(pgNo, section, null, signal)
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
  batchSize = 8
) {
  const details: DeviceListItem[] = [];
  for (let index = 0; index < devices.length; index += batchSize) {
    details.push(
      ...(await Promise.all(
        devices
          .slice(index, index + batchSize)
          .map((device) => requestDeviceDetail(device.pgNo))
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
      ? `${selectedDevice.pgNo} 재고 수정`
      : "재고 수정",
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
        requestDeviceDetail(pgNo, controller.signal),
        requestInventoryCorrectionHistory(pgNo, controller.signal),
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
  }, [applyDeviceSelection, clearPendingTextDrafts]);

  function selectDevice(device: DeviceListRow) {
    if (device.pgNo === selectedPgNo) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [INVENTORY_CORRECTION_FORM_ID],
      targetLabel: `${device.pgNo} 재고 열기`,
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
            ? `${normalizedInitialPgNo} 기기 목록을 갱신하고 있습니다.`
            : `${normalizedInitialPgNo} PG를 현재 재고 수정 목록에서 찾지 못했습니다. 작업 영역을 새로고침한 뒤 다시 확인하세요.`
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
        targetLabel: `${target.pgNo} 재고 열기`,
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
      requestDeviceDetail(pgNo),
      requestInventoryCorrectionHistory(pgNo),
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
      setMessage("저장할 재고 변경사항이 없습니다.");
      setMessageTone("warning");
      return;
    }

    if (!normalizedEditReason) {
      setMessage("수정 사유를 입력해야 저장할 수 있습니다.");
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
            patches: inventoryCorrectionPatches(currentState.changes),
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | InventoryCorrectionApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "기존 재고 수정에 실패했습니다.");
      }

      const committedRecords = cloneDeviceDetailRecords(currentState.records);
      setForm((current) => ({ ...current, editReason: "" }));
      setBaselineRecords(committedRecords);
      setEditRecords(committedRecords);
      clearPendingTextDrafts();
      setMessage(payload.message || "기존 재고 수정 내역을 저장했습니다.");
      setMessageTone("success");

      try {
        await refreshDeviceAfterWrite(form.pgNo);
      } catch {
        setPostWriteRefreshWarning(POST_WRITE_REFRESH_WARNING);
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
      setMessage("수정 사유를 입력해야 저장할 수 있습니다.");
      setMessageTone("warning");
      return;
    }

    if (selectedBulkDevices.length === 0) {
      setMessage("일괄 수정할 재고를 체크박스로 선택해야 합니다.");
      setMessageTone("warning");
      return;
    }

    if (currentState.bulkChanges.length === 0) {
      setMessage("일괄 적용할 변경 컬럼이 없습니다.");
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
        selectedBulkDevices
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
              patches: inventoryCorrectionPatches(targetChanges),
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
      setMessage("선택한 재고에 적용할 수 있는 변경 컬럼이 없습니다.");
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
        throw new Error(payload?.message || "기존 재고 일괄 수정에 실패했습니다.");
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
      setMessage(payload.message || "선택 재고 수정 내역을 저장했습니다.");
      setMessageTone("success");

      try {
        await refreshDeviceAfterWrite(form.pgNo);
      } catch {
        setPostWriteRefreshWarning(POST_WRITE_REFRESH_WARNING);
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
              ariaLabel="표시된 재고 전체 선택 또는 해제"
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
              ariaLabel={`${device.pgNo} 일괄 수정 대상 선택`}
              onCheckedChange={(checked) => setBulkSelected(device.pgNo, checked)}
            />
          </div>
        ),
      },
      {
        key: "pgNo",
        label: "PG",
        width: "126px",
        placeholder: "PG 검색",
        cellClassName: "flex items-center px-3 font-semibold",
        render: (device) => device.pgNo,
        text: (device) => device.pgNo,
      },
      {
        key: "model",
        label: "모델",
        width: "minmax(220px,1fr)",
        placeholder: "모델/용량/색상",
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
        label: "상태",
        width: "96px",
        placeholder: "상태 검색",
        cellClassName: "flex items-center px-3",
        render: (device) => statusBadge(device.displayStatus),
        text: (device) =>
          [statusMap[device.displayStatus]?.label, device.displayStatus]
            .filter(Boolean)
            .join(" "),
      },
    ],
    [selectedBulkPgNos]
  );

  return (
    <MasterDetailLayout
      as="section"
      className="grid-cols-[minmax(420px,500px)_minmax(0,1fr)] gap-4 p-5"
    >
      <div className="flex min-h-0 flex-col rounded-md border bg-popover">
        <div className="border-b p-3">
          <SearchInput
            placeholder="PG, IMEI, 모델 검색"
            value={query}
            onValueChange={setQuery}
          />
        </div>
        <VirtualizedDataGrid
          rows={filteredDevices}
          columns={deviceSelectorColumns}
          rowKey={(device) => device.pgNo}
          emptyMessage="수정할 기기가 없습니다."
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
              <h2 className="text-sm font-semibold">기존 재고 수정</h2>
              <p className="text-xs text-muted-foreground">
                기준 PG {form.pgNo || "-"} / 선택{" "}
                {selectedBulkDevices.length.toLocaleString("ko-KR")}건 / 변경{" "}
                {correctionChanges.length.toLocaleString("ko-KR")}개
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setSelectedBulkPgNos(new Set<string>())}
                disabled={selectedBulkDevices.length === 0 || isSaving}
              >
                선택 해제
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
                선택 일괄 적용
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
                {isSaving ? "저장중" : "수정 저장"}
              </Button>
            </div>
          </div>

          <DangerousConfirmDialog
            open={isSaveConfirmOpen}
            title="기존 재고 수정 저장"
            description="선택한 기기의 재고, 입고, 기기 정보를 수동으로 덮어씁니다."
            detail={
              <>
                대상 PG <span className="font-mono">{form.pgNo || "-"}</span>의
                기존 데이터가 즉시 변경됩니다. 수정 사유:{" "}
                <span className="font-semibold">{normalizedEditReason || "-"}</span>
              </>
            }
            confirmLabel="수정 저장"
            busyLabel="저장중"
            isBusy={isSaving}
            onCancel={() => setIsSaveConfirmOpen(false)}
            onConfirm={() => void saveCorrection()}
          />
          <DangerousConfirmDialog
            open={isBulkConfirmOpen}
            title="선택 재고 일괄 수정"
            description="기준 PG에서 실제로 변경한 컬럼만 체크된 재고에 같은 값으로 반영합니다. PG, IMEI, ADB Serial, 고유번호는 일괄 적용에서 제외됩니다."
            detail={
              <>
                선택 {selectedBulkDevices.length.toLocaleString("ko-KR")}건 / 변경{" "}
                {bulkChanges.length.toLocaleString("ko-KR")}개 컬럼
                <div className="mt-2 grid gap-1 text-xs font-normal">
                  {bulkChanges.slice(0, 6).map((change) => (
                    <div key={`${change.group}-${change.recordIndex}-${change.fieldKey}`}>
                      {change.label}:{" "}
                      <span className="font-semibold">{change.value || "(빈 값)"}</span>
                    </div>
                  ))}
                  {bulkChanges.length > 6 ? (
                    <div>외 {bulkChanges.length - 6}개 컬럼</div>
                  ) : null}
                </div>
              </>
            }
            confirmLabel="일괄 수정 저장"
            busyLabel="저장중"
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
              선택한 기기의 상세 정보를 불러오는 중입니다.
            </FeedbackBanner>
          ) : null}

          <section className="grid gap-2 rounded-md border bg-popover p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">수정 기록</h3>
              <span
                className={cn(
                  "text-xs",
                  normalizedEditReason
                    ? "text-emerald-700"
                    : "text-amber-700"
                )}
              >
                {normalizedEditReason ? "저장 가능" : "수정 사유 필요"}
              </span>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                수정 사유
              </span>
              <Input
                value={form.editReason}
                placeholder="예: 반품 재검수 결과 반영, 거래처 협의 내용 정정"
                onChange={(event) => updateForm("editReason", event.target.value)}
              />
            </label>
          </section>

          {selectedDevice ? (
            <section className="grid gap-4">
              <h3 className="text-sm font-semibold">재고 전체 기록</h3>
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
                  입고·검수·주문 이력은 페이지 단위로 조회됩니다.
                </span>
                {hasMoreHistory ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isHistoryLoadingMore}
                    onClick={() => void loadMoreHistory()}
                  >
                    {isHistoryLoadingMore
                      ? "불러오는 중"
                      : "이전 기록 더 불러오기"}
                  </Button>
                ) : (
                  <span>전체 이력을 불러왔습니다.</span>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </MasterDetailLayout>
  );
}
