// QuickHack note: 외관 검수, 기능 검수, 업로드 대기 목록과 ADB 보조 흐름을 담당하는 검수 작업 화면입니다.
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import {
  Loader2,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import { getCameraCheckByProduct } from "@/quickhack_client/adb/adb-config";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  DefectSelector,
  FieldLabel,
  defectStateToText,
  type DefectState,
} from "@/quickhack_client/components/inspection/inspection-defect-controls";
import {
  createFunctionRow,
  fieldForBarcodeScan,
  findNextIncompleteFunctionRowIndex,
  findRowIndexForBarcodeScan,
  isAdbVirtualEmulatorPort,
  isCompleteFunctionRow,
  mergeFunctionRowsWithAdbDevices,
  parseBarcodeScans,
  type ConnectedAdbDevice,
} from "@/quickhack_client/components/inspection/inspection-function-row-logic";
import { buildInspectionColorOptions } from "@/quickhack_client/components/inspection/inspection-color-options";
import {
  defaultProductCriteria,
  mergeProductCriteriaPayload,
  type ProductOption,
} from "@/quickhack_client/components/inspection/inspection-product-criteria";
import {
  hasAppearanceRecordData,
  hasFunctionRecordData,
  normalizeInspectionRecordKinds,
  recordForUpload,
} from "@/quickhack_client/components/inspection/inspection-record-logic";
import {
  useAppearanceHistoryColumns,
  useAppearancePendingColumns,
  useFunctionPendingColumns,
} from "@/quickhack_client/components/inspection/inspection-record-columns";
import {
  advanceFunctionRowDraftBaseline,
  appearanceDraftSnapshotsEqual,
  createAppearanceDraftSnapshot,
  createFunctionRowDraftBaselines,
  discardPendingInspectionRecords,
  hasPendingInspectionRecords,
  isFunctionDraftDirty,
  restoreFunctionRowsFromBaselines,
  type AppearanceDraftSnapshot,
  type FunctionRowDraftBaselines,
} from "@/quickhack_client/components/inspection/inspection-unsaved-state";
import {
  FunctionInspectionEditTable,
  isOptionValue,
  type FunctionRow,
  type ProductCriteriaRuntime,
} from "@/quickhack_client/components/inspection/function-inspection-edit-table";
import { SearchCombobox } from "@/quickhack_client/components/inspection/inspection-input-controls";
import { TableSelectCheckbox } from "@/quickhack_client/components/ui/table-select-checkbox";
import { VirtualizedDataGrid } from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  FunctionInspectionRemotePortal,
  useFunctionRemoteWindow,
  type FunctionAction,
} from "@/quickhack_client/components/inspection/function-inspection-remote-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import { Tabs, TabsContent } from "@/quickhack_client/components/ui/tabs";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import {
  CLIENT_RECORD_ID,
  DISCOUNT_CHECK_URL,
  INSPECTION_RECORD_KINDS,
  UPLOAD_STATUSES,
  UPLOAD_STATUS_COLUMN,
  createInspectionRecord,
  getRecordLabel,
  hasActualDefectText,
  isValidFirstCallDateInput,
  mergeInspectionRecord,
  normalizeDefectText,
  nowSqlDateTime,
  normalizeFirstCallDate,
  validateBarcodeInput,
  validateBatch,
  type InspectionRecord,
  type InspectionRecordKind,
  type InspectionRecordWithStatus,
} from "@/quickhack_shared/inspection/inspection-schema";
import type { ProductCriteriaPayload } from "@/quickhack_shared/catalog/product-criteria";
import { cn } from "@/quickhack_shared/core/utils";
import { ADB_CLIENT_API_MESSAGE_KEYS, isAdbClientApiCode } from "@/quickhack_client/api/adb/client-api-codes";

// QuickHack object: 검수 화면이 로그인 사용자와 업로드 후 새로고침 콜백을 받는 props 타입입니다.
type InspectionWorkspaceProps = {
  currentUser: AuthUser;
  defaultTab?: InspectionTab;
  records: InspectionRecordWithStatus[];
  setRecords: React.Dispatch<React.SetStateAction<InspectionRecordWithStatus[]>>;
  selectedRecordIds: Set<string>;
  setSelectedRecordIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onUploadComplete?: () => Promise<void> | void;
};

type InspectionTab = "appearance" | "function" | "records";

const INSPECTION_FUNCTION_DRAFT_FORM_ID = "inspection.function-draft";

type UploadResult = {
  ok: boolean;
  label: string;
  errorCode?: string;
};

type UploadResponse = {
  ok: boolean;
  successCount: number;
  failCount: number;
  results: UploadResult[];
};

type AdbDevicesResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  details?: string;
  devices?: ConnectedAdbDevice[];
};

type AdbActionResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  details?: string;
  successCount?: number;
  failCount?: number;
};

type ProductCriteriaResponse = {
  ok: boolean;
  message?: string;
  data?: ProductCriteriaPayload;
};

// QuickHack object: 외관 검수, 기능 검수, 업로드 대기 목록을 제공하는 검수 업무 최상위 화면입니다.
export function InspectionWorkspace({
  currentUser,
  defaultTab = "appearance",
  records,
  setRecords,
  selectedRecordIds,
  setSelectedRecordIds,
  onUploadComplete,
}: InspectionWorkspaceProps) {
  const t = useTranslations("inspection.workspace");
  const barcodeValidationMessage = React.useCallback(
    (code: "BARCODE_EMPTY" | "PG_INVALID" | "IMEI_INVALID" | "BARCODE_VALID") =>
      t(`messages.barcode.${code}`),
    [t]
  );
  const remoteT = useTranslations("inspection.remote.actions");
  const actionLabel = React.useCallback((action: FunctionAction) =>
    remoteT(action.id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) as "refresh"), [remoteT]);
  const adbT = useTranslations("common.adbApi");
  const [message, setMessage] = React.useState(() => t("status.idle"));
  const [messageTone, setMessageTone] = React.useState<"success" | "warning">(
    "success"
  );
  const showMessage = React.useCallback(
    (value: string, tone: "success" | "warning" = "success") => {
      setMessage(value);
      setMessageTone(tone);
    },
    []
  );
  const [isUploading, setIsUploading] = React.useState(false);
  const [productCriteria, setProductCriteria] =
    React.useState<ProductCriteriaPayload>(() => defaultProductCriteria());

  const [batchNo, setBatchNo] = React.useState("");
  const [appearancePg, setAppearancePg] = React.useState("");
  const [appearanceColor, setAppearanceColor] = React.useState("");
  const [appearanceGrade, setAppearanceGrade] = React.useState("A");
  const [appearanceDefects, setAppearanceDefects] = React.useState<DefectState>(
    {}
  );
  const [appearanceDraftBaseline, setAppearanceDraftBaseline] =
    React.useState<AppearanceDraftSnapshot>(() =>
      createAppearanceDraftSnapshot({
        batchNo: "",
        pg: "",
        color: "",
        grade: "A",
        defectText: "",
      })
    );

  const [scanValue, setScanValue] = React.useState("");
  const [functionRows, setFunctionRows] = React.useState<FunctionRow[]>([
    createFunctionRow("row-1"),
  ]);
  const [selectedFunctionRowId, setSelectedFunctionRowId] = React.useState(
    functionRows[0]?.id ?? ""
  );
  const [functionDefects, setFunctionDefects] = React.useState<DefectState>({});
  const [allDevices, setAllDevices] = React.useState(true);
  const [connectedDeviceCount, setConnectedDeviceCount] = React.useState(0);
  const [readyDeviceCount, setReadyDeviceCount] = React.useState(0);
  const [ignoredAdbDeviceCount, setIgnoredAdbDeviceCount] = React.useState(0);
  const [isLoadingDevices, setIsLoadingDevices] = React.useState(false);
  const [isRunningAdbAction, setIsRunningAdbAction] = React.useState(false);
  const [functionRowDraftBaselines, setFunctionRowDraftBaselines] =
    React.useState<FunctionRowDraftBaselines>({});
  const functionRowsRef = React.useRef(functionRows);
  const selectedFunctionRowIdRef = React.useRef(selectedFunctionRowId);
  const { runGuardedAction } = useUnsavedChanges();
  const handleFunctionRemotePopupBlocked = React.useCallback(() => {
    showMessage(t("messages.popupBlocked"), "warning");
  }, [showMessage, t]);
  const {
    isFunctionRemoteOpen,
    functionRemoteRoot,
    openFunctionRemoteWindow,
    closeFunctionRemoteWindow,
  } = useFunctionRemoteWindow({
    onPopupBlocked: handleFunctionRemotePopupBlocked,
  });

  const appearanceDefectText = defectStateToText(appearanceDefects);
  const functionDefectText = defectStateToText(functionDefects);
  const appearanceDraftSnapshot = createAppearanceDraftSnapshot({
    batchNo,
    pg: appearancePg,
    color: appearanceColor,
    grade: appearanceGrade,
    defectText: appearanceDefectText,
  });
  const appearanceDraftDirty = !appearanceDraftSnapshotsEqual(
    appearanceDraftBaseline,
    appearanceDraftSnapshot
  );
  const functionDraftDirty = isFunctionDraftDirty({
    rows: functionRows,
    baselines: functionRowDraftBaselines,
    selectedDefectText: functionDefectText,
  });
  const pendingRecordsDirty = hasPendingInspectionRecords(records);
  const selectedFunctionRow = functionRows.find(
    (row) => row.id === selectedFunctionRowId
  );
  const criteriaRuntime = React.useMemo<ProductCriteriaRuntime>(
    () => ({
      productValues: new Set(productCriteria.productValues),
      carrierValues: new Set(productCriteria.carriers),
      storageValues: new Set(productCriteria.storages),
      storageValuesByProduct: new Map(
        Object.entries(productCriteria.storagesByProduct).map(
          ([product, storages]) => [product, new Set(storages)]
        )
      ),
      colorValues: new Set(productCriteria.colors),
    }),
    [
      productCriteria.carriers,
      productCriteria.colors,
      productCriteria.productValues,
      productCriteria.storages,
      productCriteria.storagesByProduct,
    ]
  );
  const colorOptions = React.useMemo<ProductOption[]>(
    () =>
      buildInspectionColorOptions({
        colors: productCriteria.colors,
        colorModelsByColor: productCriteria.colorModelsByColor,
        rawOptions: productCriteria.rawOptions,
        formatMoreModels: (visible, remaining) =>
          t("color.moreModels", { visible, remaining }),
      }),
    [
      productCriteria.colorModelsByColor,
      productCriteria.colors,
      productCriteria.rawOptions,
      t,
    ]
  );

  const discardAppearanceDraft = React.useCallback(() => {
    setBatchNo(appearanceDraftBaseline.batchNo);
    setAppearancePg(appearanceDraftBaseline.pg);
    setAppearanceColor(appearanceDraftBaseline.color);
    setAppearanceGrade(appearanceDraftBaseline.grade || "A");
    setAppearanceDefects({});
  }, [appearanceDraftBaseline]);

  const discardFunctionDraft = React.useCallback(() => {
    const restoredRows = restoreFunctionRowsFromBaselines(
      functionRowsRef.current,
      functionRowDraftBaselines
    );
    const nextRows =
      restoredRows.length > 0 ? restoredRows : [createFunctionRow()];
    const currentSelectedRowId = selectedFunctionRowIdRef.current;
    const nextSelectedRowId = nextRows.some(
      (row) => row.id === currentSelectedRowId
    )
      ? currentSelectedRowId
      : nextRows[0]?.id ?? "";

    functionRowsRef.current = nextRows;
    selectedFunctionRowIdRef.current = nextSelectedRowId;
    setFunctionRows(nextRows);
    setSelectedFunctionRowId(nextSelectedRowId);
    setFunctionDefects({});
  }, [functionRowDraftBaselines]);

  const discardPendingRecords = React.useCallback(() => {
    setRecords((current) => discardPendingInspectionRecords(current));
    setSelectedRecordIds(new Set());
  }, [setRecords, setSelectedRecordIds]);

  useUnsavedForm({
    id: "inspection.appearance-draft",
    label: t("unsaved.appearance"),
    isDirty: appearanceDraftDirty,
    discard: discardAppearanceDraft,
  });
  useUnsavedForm({
    id: INSPECTION_FUNCTION_DRAFT_FORM_ID,
    label: t("unsaved.function"),
    isDirty: functionDraftDirty,
    isBusy: isLoadingDevices || isRunningAdbAction,
    discard: discardFunctionDraft,
  });
  useUnsavedForm({
    id: "inspection.pending-records",
    label: t("unsaved.pending"),
    isDirty: pendingRecordsDirty,
    isBusy: isUploading,
    discard: discardPendingRecords,
  });

  function cameraCheckForProduct(product: string) {
    const normalizedProduct = product.trim();

    return (
      productCriteria.cameraCheckByProduct[normalizedProduct] ??
      getCameraCheckByProduct(normalizedProduct)
    );
  }

  React.useEffect(() => {
    let isAlive = true;

    async function loadProductCriteria() {
      try {
        const response = await fetch("/api/product-criteria", {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as
          | ProductCriteriaResponse
          | null;

        if (!isAlive || !response.ok || !payload?.ok) {
          return;
        }

        setProductCriteria(mergeProductCriteriaPayload(payload.data));
      } catch {
        // Keep the built-in defaults when the criteria API is unavailable.
      }
    }

    void loadProductCriteria();

    return () => {
      isAlive = false;
    };
  }, []);

  React.useEffect(() => {
    functionRowsRef.current = functionRows;
  }, [functionRows]);

  React.useEffect(() => {
    selectedFunctionRowIdRef.current = selectedFunctionRowId;
  }, [selectedFunctionRowId]);

  React.useEffect(() => {
    const liveRecordIds = new Set(
      records.map((record) => record[CLIENT_RECORD_ID])
    );

    setSelectedRecordIds((current) => {
      const next = new Set(
        Array.from(current).filter((recordId) => liveRecordIds.has(recordId))
      );

      return next.size === current.size ? current : next;
    });
  }, [records, setSelectedRecordIds]);

  React.useEffect(() => {
    setRecords(normalizeInspectionRecordKinds);
  }, [setRecords]);

  function addOrUpdateRecord(
    record: InspectionRecord,
    kind: InspectionRecordKind
  ) {
    const label = getRecordLabel(record);

    setRecords((current) => mergeInspectionRecord(current, record, kind).records);
    showMessage(t("messages.recordApplied", { label }));
  }

  function handleAddAppearanceRecord() {
    if (batchNo.trim() && !validateBatch(batchNo)) {
      showMessage(t("messages.invalidBatch"), "warning");
      return;
    }

    const validation = validateBarcodeInput(appearancePg, "PG");

    if (!validation.ok) {
      showMessage(barcodeValidationMessage(validation.code), "warning");
      setAppearancePg("");
      return;
    }

    addOrUpdateRecord(
      createInspectionRecord({
        PG: validation.value,
        기기색상: appearanceColor,
        외관등급: appearanceGrade,
        외관하자: normalizeDefectText(appearanceDefectText),
        매입처반품유무: "N",
        차수: batchNo.trim(),
        외관검수자: currentUser.displayName,
        외관검수일시: nowSqlDateTime(),
      }),
      INSPECTION_RECORD_KINDS.appearance
    );
    setAppearancePg("");
    setAppearanceColor("");
    setAppearanceDefects({});
    setAppearanceDraftBaseline(
      createAppearanceDraftSnapshot({
        batchNo,
        pg: "",
        color: "",
        grade: appearanceGrade,
        defectText: "",
      })
    );
  }

  function updateFunctionRow(rowId: string, values: Partial<FunctionRow>) {
    setFunctionRows((current) =>
      current.map((row) => (row.id === rowId ? { ...row, ...values } : row))
    );
  }

  function commitFunctionRow(row: FunctionRow) {
    if (!row.pg || !row.imei) {
      showMessage(t("messages.functionRequired"), "warning");
      return false;
    }

    const pgValidation = validateBarcodeInput(row.pg, "PG");
    const imeiValidation = validateBarcodeInput(row.imei, "IMEI");

    if (!pgValidation.ok) {
      showMessage(barcodeValidationMessage(pgValidation.code), "warning");
      return false;
    }

    if (!imeiValidation.ok) {
      showMessage(barcodeValidationMessage(imeiValidation.code), "warning");
      return false;
    }

    const normalizedFirstCallDate = normalizeFirstCallDate(row.firstCallDate);

    if (!isValidFirstCallDateInput(row.firstCallDate)) {
      showMessage(t("messages.invalidFirstCall"), "warning");
      return false;
    }

    addOrUpdateRecord(
      createInspectionRecord({
        PG: pgValidation.value,
        IMEI: imeiValidation.value,
        기능하자: normalizeDefectText(row.functionDefect),
        매입처반품유무: hasActualDefectText(row.functionDefect)
          ? row.returnYn
          : "N",
        제품명: isOptionValue(row.product, criteriaRuntime.productValues)
          ? row.product
          : "",
        통신사: isOptionValue(row.csc, criteriaRuntime.carrierValues)
          ? row.csc
          : "",
        저장공간: isOptionValue(row.storage, criteriaRuntime.storageValues)
          ? row.storage
          : "",
        최초통화일: normalizedFirstCallDate,
        기능검수자: currentUser.displayName,
        기능검수일시: nowSqlDateTime(),
      }),
      INSPECTION_RECORD_KINDS.function
    );
    setFunctionRowDraftBaselines((current) =>
      advanceFunctionRowDraftBaseline(current, row)
    );

    return true;
  }

  function handleApplyBarcode() {
    const parsed = parseBarcodeScans(scanValue);

    if (!parsed.ok) {
      showMessage(t("messages.invalidBarcode"), "warning");
      setScanValue("");
      return;
    }

    const nextRows =
      functionRows.length > 0 ? functionRows.map((row) => ({ ...row })) : [];
    let nextSelectedRowId = selectedFunctionRowId || nextRows[0]?.id || "";
    let completedCount = 0;

    if (nextRows.length === 0) {
      const row = createFunctionRow();
      nextRows.push(row);
      nextSelectedRowId = row.id;
    }

    for (const scan of parsed.scans) {
      const field = fieldForBarcodeScan(scan.target);
      let rowIndex = findRowIndexForBarcodeScan(
        nextRows,
        nextSelectedRowId,
        scan.target
      );

      if (rowIndex === undefined) {
        const row = createFunctionRow();
        nextRows.push(row);
        rowIndex = nextRows.length - 1;
      }

      const updatedRow = {
        ...nextRows[rowIndex],
        [field]: scan.value,
      };

      nextRows[rowIndex] = updatedRow;
      nextSelectedRowId = updatedRow.id;

      if (isCompleteFunctionRow(updatedRow)) {
        if (!commitFunctionRow(updatedRow)) {
          return;
        }

        completedCount += 1;

        let nextRowIndex = findNextIncompleteFunctionRowIndex(
          nextRows,
          rowIndex
        );

        if (nextRowIndex === undefined) {
          const row = createFunctionRow();
          nextRows.push(row);
          nextRowIndex = nextRows.length - 1;
        }

        nextSelectedRowId = nextRows[nextRowIndex].id;
      }
    }

    setFunctionRows(nextRows);
    setSelectedFunctionRowId(nextSelectedRowId);
    setScanValue("");
    showMessage(
      t("messages.scansApplied", { scans: parsed.scans.length }) +
        (completedCount > 0
          ? t("messages.scansRegistered", { count: completedCount })
          : "")
    );
  }

  function handleApplyFunctionDefect() {
    if (!selectedFunctionRow) {
      showMessage(t("messages.selectDefectRow"), "warning");
      return;
    }

    const updatedRow: FunctionRow = {
      ...selectedFunctionRow,
      functionDefect: functionDefectText,
      returnYn: hasActualDefectText(functionDefectText) ? "Y" : "N",
    };

    setFunctionRows((current) =>
      current.map((row) =>
        row.id === selectedFunctionRow.id ? updatedRow : row
      )
    );
    setFunctionDefects({});
    showMessage(t("messages.defectApplied"));

    if (updatedRow.pg && updatedRow.imei) {
      commitFunctionRow(updatedRow);
    }
  }

  function handleAddFunctionRow() {
    const row = createFunctionRow();
    setFunctionRows((current) => [...current, row]);
    setSelectedFunctionRowId(row.id);
    showMessage(t("messages.rowAdded"));
  }

  function handleDeleteFunctionRow() {
    if (!selectedFunctionRowId) {
      return;
    }

    const nextRows = functionRows.filter(
      (row) => row.id !== selectedFunctionRowId
    );
    const normalizedRows =
      nextRows.length > 0 ? nextRows : [createFunctionRow()];

    setFunctionRows(normalizedRows);
    setSelectedFunctionRowId(normalizedRows[0]?.id ?? "");
  }

  async function loadAdbDevices() {
    setIsLoadingDevices(true);
    showMessage(t("messages.refreshingDevices"));

    try {
      const response = await fetch("/api/adb/devices");
      const payload = (await response.json().catch(() => null)) as
        | AdbDevicesResponse
        | null;

      if (!response.ok || !payload?.ok) {
        const localized = isAdbClientApiCode(payload?.code) ? adbT(ADB_CLIENT_API_MESSAGE_KEYS[payload.code]) : legacyApiMessage(payload, t("messages.adbDeviceLoadFailed"));
        throw new Error(localized || t("messages.adbDeviceLoadFailed"));
      }

      const scannedDevices = payload.devices ?? [];
      const ignoredDevices = scannedDevices.filter(isAdbVirtualEmulatorPort);
      const devices = scannedDevices.filter(
        (device) => !isAdbVirtualEmulatorPort(device)
      );
      const rows = mergeFunctionRowsWithAdbDevices(
        functionRowsRef.current,
        devices,
        criteriaRuntime
      );
      const currentSelectedRowId = selectedFunctionRowIdRef.current;
      const nextSelectedRowId = rows.some(
        (row) => row.id === currentSelectedRowId
      )
        ? currentSelectedRowId
        : rows[0]?.id ?? "";
      const readyCount = devices.filter(
        (device) => device.connectionState === "device"
      ).length;

      setFunctionRows(rows);
      functionRowsRef.current = rows;
      setFunctionRowDraftBaselines(createFunctionRowDraftBaselines(rows));
      setSelectedFunctionRowId(nextSelectedRowId);
      selectedFunctionRowIdRef.current = nextSelectedRowId;
      setConnectedDeviceCount(devices.length);
      setReadyDeviceCount(readyCount);
      setIgnoredAdbDeviceCount(ignoredDevices.length);
      showMessage(
        t("messages.devicesLoaded", { devices: devices.length, ready: readyCount }) +
          (ignoredDevices.length > 0
            ? t("messages.virtualExcluded", { count: ignoredDevices.length })
            : "")
      );
    } catch (error) {
      showMessage(
        t("messages.raw", {
          message: error instanceof Error ? error.message : String(error),
        }),
        "warning"
      );
    } finally {
      setIsLoadingDevices(false);
    }
  }

  async function handleFunctionAction(action: FunctionAction) {
    if (action.id === "refresh") {
      runGuardedAction({
        intent: "internal-change",
        formIds: [INSPECTION_FUNCTION_DRAFT_FORM_ID],
        targetLabel: t("messages.adbRefresh"),
        action: () => {
          void loadAdbDevices();
        },
      });
      return;
    }

    if (action.id === "discount-check") {
      window.open(DISCOUNT_CHECK_URL, "_blank", "noopener,noreferrer");
      showMessage(t("messages.discountOpened"));
      return;
    }

    const serials = allDevices
      ? functionRows
          .filter(
            (row) => row.connectionState === "device" && row.serial.trim()
          )
          .map((row) => row.serial.trim())
      : selectedFunctionRow?.serial
        ? [selectedFunctionRow.serial.trim()]
        : [];

    if (serials.length === 0) {
      showMessage(t("messages.selectAdb"), "warning");
      return;
    }

    if (!allDevices && selectedFunctionRow?.connectionState !== "device") {
      showMessage(t("messages.connectedOnly"), "warning");
      return;
    }

    if (action.id === "reboot-recovery") {
      const preview = serials.slice(0, 5).join(", ");
      const suffix = serials.length > 5
        ? t("messages.recoveryRemainder", { count: serials.length - 5 })
        : "";
      const confirmed = window.confirm(
        t("messages.recoveryConfirm", { count: serials.length, preview, suffix })
      );
      if (!confirmed) {
        showMessage(t("messages.recoveryCanceled"));
        return;
      }
    }

    setIsRunningAdbAction(true);
    const localizedAction = actionLabel(action);
    showMessage(t("messages.actionRunning", { action: localizedAction }));

    try {
      const response = await fetch("/api/adb/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: action.id,
          serials,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | AdbActionResponse
        | null;

      if (!response.ok || !payload) {
        const localized = isAdbClientApiCode(payload?.code) ? adbT(ADB_CLIENT_API_MESSAGE_KEYS[payload.code]) : legacyApiMessage(payload, t("messages.adbActionFailed"));
        throw new Error(localized || t("messages.adbActionFailed"));
      }

      const handledCount = (payload.successCount ?? 0) + (payload.failCount ?? 0);
      showMessage(
        t("messages.actionComplete", {
          action: localizedAction,
          success: payload.successCount ?? 0,
          failed: payload.failCount ?? 0,
        }) + (handledCount === 0 ? t("messages.noActionableDevice") : ""),
        (payload.failCount ?? 0) > 0 || handledCount === 0
          ? "warning"
          : "success"
      );
    } catch (error) {
      showMessage(
        t("messages.actionFailed", {
          action: localizedAction,
          message: error instanceof Error ? error.message : String(error),
        }),
        "warning"
      );
    } finally {
      setIsRunningAdbAction(false);
    }
  }

  const toggleSelectedRecord = React.useCallback((recordId: string, checked: boolean) => {
    setSelectedRecordIds((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(recordId);
      } else {
        next.delete(recordId);
      }

      return next;
    });
  }, [setSelectedRecordIds]);

  const setVisibleRecordsSelected = React.useCallback((
    targetRecords: InspectionRecordWithStatus[],
    checked: boolean
  ) => {
    const targetRecordIds = targetRecords.map(
      (record) => record[CLIENT_RECORD_ID]
    );

    setSelectedRecordIds((current) => {
      const next = new Set(current);

      for (const recordId of targetRecordIds) {
        if (checked) {
          next.add(recordId);
        } else {
          next.delete(recordId);
        }
      }

      return next;
    });
  }, [setSelectedRecordIds]);

  const visibleRecordSelectionState = React.useCallback((
    targetRecords: InspectionRecordWithStatus[]
  ) => {
    const selectedCount = targetRecords.filter((record) =>
      selectedRecordIds.has(record[CLIENT_RECORD_ID])
    ).length;
    const totalCount = targetRecords.length;

    return {
      checked: totalCount > 0 && selectedCount === totalCount,
      indeterminate: selectedCount > 0 && selectedCount < totalCount,
      disabled: totalCount === 0 || isUploading,
    };
  }, [isUploading, selectedRecordIds]);

  const renderSelectionCell = React.useCallback((record: InspectionRecordWithStatus) => {
    return (
      <div className="flex h-full items-center justify-center">
        <TableSelectCheckbox
          checked={selectedRecordIds.has(record[CLIENT_RECORD_ID])}
          disabled={isUploading}
          ariaLabel={t("record.selectAria", { label: getRecordLabel(record) })}
          onCheckedChange={(checked) =>
            toggleSelectedRecord(
              record[CLIENT_RECORD_ID],
              checked
            )
          }
        />
      </div>
    );
  }, [isUploading, selectedRecordIds, t, toggleSelectedRecord]);

  function deleteSelectedRecords() {
    if (selectedRecordIds.size === 0) {
      showMessage(t("messages.selectDelete"), "warning");
      return;
    }

    setRecords((current) =>
      current.filter((record) => !selectedRecordIds.has(record[CLIENT_RECORD_ID]))
    );
    setSelectedRecordIds(new Set());
    showMessage(t("messages.deleteComplete"));
  }

  const updateAppearanceReturnYn = React.useCallback((recordId: string, value: "Y" | "N") => {
    setRecords((current) =>
      current.map((record) =>
        record[CLIENT_RECORD_ID] === recordId
          ? { ...record, 매입처반품유무: value, [UPLOAD_STATUS_COLUMN]: UPLOAD_STATUSES.pending }
          : record
      )
    );
    showMessage(t("messages.supplierReturn", { value }));
  }, [setRecords, showMessage, t]);

  async function uploadRecordIds(recordIds: string[], title: string) {
    if (recordIds.length === 0) {
      showMessage(t("messages.noUpload"), "warning");
      return;
    }

    const recordIdSet = new Set(recordIds);
    const uploadItems = records
      .filter((record) => recordIdSet.has(record[CLIENT_RECORD_ID]))
      .map((record) => ({
        id: record[CLIENT_RECORD_ID],
        record: recordForUpload(record),
      }));

    if (uploadItems.length === 0) {
      showMessage(t("messages.noUpload"), "warning");
      return;
    }

    setIsUploading(true);
    setRecords((current) =>
      current.map((record) =>
        recordIdSet.has(record[CLIENT_RECORD_ID])
          ? { ...record, [UPLOAD_STATUS_COLUMN]: UPLOAD_STATUSES.uploading }
          : record
      )
    );

    const uploadRecords = uploadItems.map((item) => item.record);

    try {
      const response = await fetch("/api/inspection-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: uploadRecords }),
      });
      const payload = (await response.json().catch(() => null)) as
        | UploadResponse
        | null;

      if (!response.ok || !payload) {
        throw new Error(t("message.invalidServerResponse"));
      }

      const resultsByRecordId = new Map(
        uploadItems.map((item, index) => [item.id, payload.results[index]])
      );

      setRecords((current) =>
        current.map((record) => {
          const result = resultsByRecordId.get(record[CLIENT_RECORD_ID]);

          if (!result) {
            return record;
          }

          return {
            ...record,
            [UPLOAD_STATUS_COLUMN]: result.ok
              ? UPLOAD_STATUSES.done
              : UPLOAD_STATUSES.failed,
          };
        })
      );
      setSelectedRecordIds(new Set());
      if (payload.successCount > 0) {
        await onUploadComplete?.();
      }
      showMessage(t("messages.uploadComplete", {
        title,
        success: payload.successCount,
        failed: payload.failCount,
      }), payload.failCount > 0 ? "warning" : "success");
    } catch (error) {
      setRecords((current) =>
        current.map((record) =>
          recordIdSet.has(record[CLIENT_RECORD_ID])
            ? { ...record, [UPLOAD_STATUS_COLUMN]: UPLOAD_STATUSES.failed }
            : record
        )
      );
      showMessage(
        t("messages.uploadFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
        "warning"
      );
    } finally {
      setIsUploading(false);
    }
  }

  function uploadAllRecords() {
    const recordIds = records
      .filter((record) => record[UPLOAD_STATUS_COLUMN] !== UPLOAD_STATUSES.done)
      .map((record) => record[CLIENT_RECORD_ID]);

    void uploadRecordIds(recordIds, t("records.uploadAll"));
  }

  function uploadSelectedRecords() {
    const recordById = new Map(
      records.map((record) => [record[CLIENT_RECORD_ID], record])
    );
    const recordIds = Array.from(selectedRecordIds).filter(
      (recordId) =>
        recordById.get(recordId)?.[UPLOAD_STATUS_COLUMN] !==
        UPLOAD_STATUSES.done
    );

    void uploadRecordIds(recordIds, t("records.uploadSelected"));
  }

  const pendingCount = records.filter(
    (record) => record[UPLOAD_STATUS_COLUMN] !== UPLOAD_STATUSES.done
  ).length;
  const appearancePendingRecords = records.filter(hasAppearanceRecordData);
  const functionPendingRecords = records.filter(hasFunctionRecordData);
  const appearanceHistoryRecords = React.useMemo(
    () =>
      records
        .filter((record) => record.외관검수일시)
        .slice()
        .reverse(),
    [records]
  );
  const appearanceHistoryColumns = useAppearanceHistoryColumns({
    updateAppearanceReturnYn,
  });
  const appearancePendingColumns = useAppearancePendingColumns({
    renderSelectionCell,
    setVisibleRecordsSelected,
    visibleRecordSelectionState,
  });
  const functionPendingColumns = useFunctionPendingColumns({
    renderSelectionCell,
    setVisibleRecordsSelected,
    visibleRecordSelectionState,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FunctionInspectionRemotePortal
        root={functionRemoteRoot}
        connectedDeviceCount={connectedDeviceCount}
        readyDeviceCount={readyDeviceCount}
        ignoredAdbDeviceCount={ignoredAdbDeviceCount}
        allDevices={allDevices}
        isLoadingDevices={isLoadingDevices}
        isRunningAdbAction={isRunningAdbAction}
        onAllDevicesChange={setAllDevices}
        onFunctionAction={handleFunctionAction}
        onClose={closeFunctionRemoteWindow}
      />
      <Tabs value={defaultTab} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b bg-background px-5 py-3 text-xs text-muted-foreground">
          <span
            key={message}
            className={cn(
              "rounded-md border px-3 py-1.5 font-medium",
              messageTone === "warning"
                ? "quickhack-status-flash-warning border-amber-300 bg-amber-50 text-amber-900"
                : "quickhack-status-flash-success border-emerald-300 bg-emerald-50 text-emerald-900"
            )}
          >
            {message}
          </span>
          <span className="hidden xl:inline">|</span>
          <span>{t("status.todayCount", { count: records.length })}</span>
          <span>{t("status.pendingCount", { count: pendingCount })}</span>
        </div>

        <TabsContent value="appearance" className="m-0 min-h-0 flex-1 p-5">
          <div className="grid h-full min-h-0 gap-4 xl:grid-rows-[auto_1fr]">
            <section className="grid gap-4 rounded-md border bg-background p-4 xl:grid-cols-[340px_1fr]">
              <div className="grid content-start gap-3">
                <h2 className="text-sm font-semibold">{t("appearance.title")}</h2>
                <FieldLabel label={t("batch")}>
                  <Input
                    inputMode="numeric"
                    value={batchNo}
                    onChange={(event) => setBatchNo(event.target.value)}
                  />
                </FieldLabel>
                <FieldLabel label="PG">
                  <Input
                    value={appearancePg}
                    onChange={(event) => setAppearancePg(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        handleAddAppearanceRecord();
                      }
                    }}
                  />
                </FieldLabel>
                <FieldLabel label={t("appearance.color")}>
                  <SearchCombobox
                    value={appearanceColor}
                    options={colorOptions}
                    isValidValue={(value) =>
                      isOptionValue(value, criteriaRuntime.colorValues)
                    }
                    placeholder={t("appearance.colorPlaceholder")}
                    searchPlaceholder={t("appearance.colorSearch")}
                    onValueChange={setAppearanceColor}
                  />
                </FieldLabel>
                <FieldLabel label={t("appearance.grade")}>
                  <Select
                    value={appearanceGrade}
                    onValueChange={setAppearanceGrade}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("appearance.grade")} />
                    </SelectTrigger>
                    <SelectContent>
                      {productCriteria.grades.map((grade) => (
                        <SelectItem key={grade} value={grade}>
                          {grade}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldLabel>
                <div className="flex gap-2 pt-2">
                  <Button type="button" onClick={handleAddAppearanceRecord}>
                    <Plus className="size-4" />
                    {t("appearance.register")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setAppearancePg("");
                      setAppearanceColor("");
                      setAppearanceGrade("A");
                      setAppearanceDefects({});
                      setAppearanceDraftBaseline(
                        createAppearanceDraftSnapshot({
                          batchNo,
                          pg: "",
                          color: "",
                          grade: "A",
                          defectText: "",
                        })
                      );
                    }}
                  >
                    {t("appearance.reset")}
                  </Button>
                </div>
              </div>

              <DefectSelector
                title={t("appearance.defect")}
                defectMap={productCriteria.appearanceDefectMap}
                selected={appearanceDefects}
                onSelectedChange={setAppearanceDefects}
                emptyLabel={t("appearance.defectEmpty")}
              />
            </section>

            <section className="min-h-0 overflow-hidden rounded-md border bg-popover">
              <VirtualizedDataGrid
                rows={appearanceHistoryRecords}
                columns={appearanceHistoryColumns}
                rowKey={(record) =>
                  `${record[CLIENT_RECORD_ID]}-${record.외관검수일시}`
                }
                emptyMessage={t("appearance.historyEmpty")}
                className="h-full rounded-none border-0"
                minWidth="950px"
                rowHeight={52}
              />
            </section>
          </div>
        </TabsContent>

        <TabsContent value="function" className="m-0 min-h-0 flex-1 p-5">
          <div className="grid h-full min-h-0 gap-4">
            <div className="grid min-h-0 gap-4 xl:grid-rows-[auto_auto_1fr]">
              <section className="grid gap-3 rounded-md border bg-background p-4">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
                  <FieldLabel label={t("function.scan")}>
                    <Input
                      className="xl:w-[520px]"
                      value={scanValue}
                      placeholder={t("function.scanPlaceholder")}
                      onChange={(event) => setScanValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          handleApplyBarcode();
                        }
                      }}
                    />
                  </FieldLabel>
                  <Button type="button" onClick={handleApplyBarcode}>
                    <Save className="size-4" />
                    {t("function.apply")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="xl:ml-auto"
                    aria-haspopup="dialog"
                    aria-expanded={isFunctionRemoteOpen}
                    onClick={openFunctionRemoteWindow}
                  >
                    <SlidersHorizontal className="size-4" />
                    {t("function.remote")}
                  </Button>
                </div>
              </section>

              <DefectSelector
                title={t("function.defect")}
                defectMap={productCriteria.functionDefectMap}
                selected={functionDefects}
                onSelectedChange={setFunctionDefects}
                emptyLabel={t("function.defectEmpty")}
                actionLabel={t("function.applyDefect")}
                onAction={handleApplyFunctionDefect}
              />

              <section className="min-h-0 overflow-auto rounded-md border bg-popover">
                <div className="flex items-center gap-2 border-b bg-background px-3 py-2">
                  <Button type="button" size="sm" onClick={handleAddFunctionRow}>
                    <Plus className="size-4" />
                    {t("function.addRow")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleDeleteFunctionRow}
                  >
                    <Trash2 className="size-4" />
                    {t("function.deleteRow")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (selectedFunctionRow) {
                        commitFunctionRow(selectedFunctionRow);
                      }
                    }}
                  >
                    {t("function.commit")}
                  </Button>
                </div>
                <FunctionInspectionEditTable
                  functionRows={functionRows}
                  selectedFunctionRowId={selectedFunctionRowId}
                  productCriteria={productCriteria}
                  criteriaRuntime={criteriaRuntime}
                  setSelectedFunctionRowId={setSelectedFunctionRowId}
                  updateFunctionRow={updateFunctionRow}
                  cameraCheckForProduct={cameraCheckForProduct}
                />
              </section>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="records" className="m-0 min-h-0 flex-1 p-5">
          <div className="grid h-full min-h-0 grid-rows-[auto_1fr] gap-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h2 className="text-sm font-semibold">{t("records.title")}</h2>
                <p className="text-xs text-muted-foreground">
                  {t("records.summary", { total: records.length, pending: pendingCount })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={deleteSelectedRecords}
                  disabled={isUploading}
                >
                  <Trash2 className="size-4" />
                  {t("records.deleteSelected")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={uploadSelectedRecords}
                  disabled={isUploading}
                >
                  {isUploading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                  {t("records.uploadSelected")}
                </Button>
                <Button
                  type="button"
                  onClick={uploadAllRecords}
                  disabled={isUploading}
                >
                  {isUploading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                  {t("records.uploadAll")}
                </Button>
              </div>
            </div>

            <div className="grid min-h-0 gap-4 overflow-auto">
              <section className="rounded-md border bg-popover">
                <div className="flex items-center justify-between border-b bg-background px-3 py-2">
                  <h3 className="text-sm font-semibold">{t("records.appearancePending")}</h3>
                  <span className="text-xs text-muted-foreground">
                    {t("records.count", { count: appearancePendingRecords.length })}
                  </span>
                </div>
                <VirtualizedDataGrid
                  rows={appearancePendingRecords}
                  columns={appearancePendingColumns}
                  rowKey={(record) => record[CLIENT_RECORD_ID]}
                  emptyMessage={t("records.appearanceEmpty")}
                  className="h-64 flex-none rounded-none border-0"
                  minWidth="1280px"
                  rowHeight={48}
                />
              </section>

              <section className="rounded-md border bg-popover">
                <div className="flex items-center justify-between border-b bg-background px-3 py-2">
                  <h3 className="text-sm font-semibold">{t("records.functionPending")}</h3>
                  <span className="text-xs text-muted-foreground">
                    {t("records.count", { count: functionPendingRecords.length })}
                  </span>
                </div>
                <VirtualizedDataGrid
                  rows={functionPendingRecords}
                  columns={functionPendingColumns}
                  rowKey={(record) => record[CLIENT_RECORD_ID]}
                  emptyMessage={t("records.functionEmpty")}
                  className="h-64 flex-none rounded-none border-0"
                  minWidth="1500px"
                  rowHeight={48}
                />
              </section>
            </div>
          </div>
        </TabsContent>
      </Tabs>

    </div>
  );
}
