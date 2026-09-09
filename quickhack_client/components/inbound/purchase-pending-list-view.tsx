// QuickHack note: 검수 완료 기기와 매입가 기준을 결합해 매입 대기 목록, 엑셀 내보내기, 매입 확정을 처리합니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
import {
  AlertTriangle,
  BadgeDollarSign,
  Database,
  FileDown,
  ListChecks,
  PackageCheck,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react";
import type {
  StatusTone,
} from "@/quickhack_shared/device/types";
import type { DeviceListRow } from "@/quickhack_shared/device/device-list-query";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { Input } from "@/quickhack_client/components/ui/input";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  SummaryMetric as SummaryCell,
  SummaryStrip,
} from "@/quickhack_client/components/ui/summary-metric";
import {
  type DataGridColumn,
  type DataGridSortState,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  PurchaseConditionNoteInput,
  formatPrice,
  formatPriceInput,
  parsePriceInput,
  todayKstDate,
} from "@/quickhack_client/components/inbound/purchase-price-tools";
import {
  dangerousActionButtonClassName,
  type SensitiveAuthApiResponse,
} from "@/quickhack_client/components/security/sensitive-action-guards";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { POST_WRITE_REFRESH_WARNING_KEY } from "@/quickhack_client/lib/post-write-refresh";
import { SENSITIVE_ACTIONS } from "@/quickhack_shared/auth/sensitive-auth";
import {
  reconcilePurchaseConfirmResults,
  type PurchaseConfirmResultDto,
} from "@/quickhack_shared/inbound/purchase-confirm";
import { useDeviceListQuery } from "@/quickhack_client/components/shared/device-list-query-client";

type PurchaseConfirmApiResponse = {
  ok: boolean;
  message?: string;
  resultCode?: "PURCHASE_CONFIRM_RESULT" | "PURCHASE_CONFIRM_NO_TARGET";
  messageArguments?: {
    confirmedCount: number;
    recoveredCount: number;
    skippedCount: number;
    conflictCount: number;
  };
  confirmedCount?: number;
  recoveredCount?: number;
  skippedCount?: number;
  conflictCount?: number;
  results?: PurchaseConfirmResultDto[];
};

type PurchaseConfirmItem = {
  pgNo: string;
  expectedInboundId: number;
  expectedInboundRevision: number;
  purchasePrice: number;
  purchasePriceRateId: number | null;
  purchasePriceRateRevision: number | null;
  purchasePriceQueryContext: {
    priceDate: string;
    note: string;
  };
};

type PurchaseConfirmSnapshot = {
  items: PurchaseConfirmItem[];
  targetCount: number;
  excludedCount: number;
};

type PurchaseExportKind = "purchase-statement" | "jungabi-registration";

type PurchasePriceRateDto = {
  id: number;
  revision: number;
  modelOptionId: number;
  modelOptionKey: string;
  model: string;
  storageOptionId: number;
  storageOptionKey: string;
  storage: string;
  appearanceGradeOptionId: number;
  appearanceGradeOptionKey: string;
  appearanceGrade: string;
  priceDate: string;
  purchasePrice: number;
  note: string;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

type PurchasePriceApiResponse = {
  ok: boolean;
  message?: string;
  rates?: PurchasePriceRateDto[];
  notes?: string[];
  queryContext?: { priceDate: string; note: string };
};

type PurchasePendingColumnKey =
  | "pgNo"
  | "batchNo"
  | "supplierName"
  | "model"
  | "storage"
  | "appearanceGrade"
  | "saleGrade"
  | "appearanceDefect"
  | "functionDefect"
  | "purchasePrice";

type PurchasePendingColumnFilters = Record<PurchasePendingColumnKey, string>;
type PurchasePendingSortState = DataGridSortState<PurchasePendingColumnKey>;

const emptyPurchasePendingColumnFilters: PurchasePendingColumnFilters = {
  pgNo: "",
  batchNo: "",
  supplierName: "",
  model: "",
  storage: "",
  appearanceGrade: "",
  saleGrade: "",
  appearanceDefect: "",
  functionDefect: "",
  purchasePrice: "",
};

const PURCHASE_PENDING_PRICE_FORM_ID = "inbound.purchase-pending-prices";

function purchasePendingSearchableText(device: DeviceListRow) {
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

function comparePurchasePendingValues(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
  locale: string
) {
  const leftEmpty = left === null || left === undefined || left === "";
  const rightEmpty = right === null || right === undefined || right === "";

  if (leftEmpty && rightEmpty) {
    return 0;
  }

  if (leftEmpty) {
    return 1;
  }

  if (rightEmpty) {
    return -1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return String(left).localeCompare(String(right), locale, {
    numeric: true,
    sensitivity: "base",
  });
}

export function PurchasePendingListView({
  onOpenDevice,
}: {
  onOpenDevice: (pgNo: string) => void;
}) {
  const feedbackT = useTranslations("common.feedback");
  const t = useTranslations("inbound.purchasePending");
  const locale = useLocale();
  const deviceList = useDeviceListQuery({
    endpoint: "/api/inbound/purchase-pending",
    queryString: "limit=100",
    autoLoadAll: true,
  });
  const devices = deviceList.items;
  const [query, setQuery] = React.useState("");
  const [completedDate, setCompletedDate] = React.useState("");
  const [batchNo, setBatchNo] = React.useState("");
  const [priceDate, setPriceDate] = React.useState(todayKstDate);
  const [conditionNote, setConditionNote] = React.useState("");
  const [conditionNoteOptions, setConditionNoteOptions] = React.useState<string[]>(
    []
  );
  const [rates, setRates] = React.useState<PurchasePriceRateDto[]>([]);
  const [isLoadingRates, setIsLoadingRates] = React.useState(false);
  const [loadedQueryKey, setLoadedQueryKey] = React.useState<string | null>(null);
  const rateRequestGenerationRef = React.useRef(0);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<StatusTone>("neutral");
  const [postWriteRefreshWarning, setPostWriteRefreshWarning] =
    React.useState("");
  const [purchasePriceDrafts, setPurchasePriceDrafts] = React.useState<
    Record<string, string>
  >({});
  const [isPurchaseConfirmOpen, setIsPurchaseConfirmOpen] = React.useState(false);
  const [purchaseConfirmSnapshot, setPurchaseConfirmSnapshot] =
    React.useState<PurchaseConfirmSnapshot | null>(null);
  const [purchaseConfirmOtpCode, setPurchaseConfirmOtpCode] =
    React.useState("");
  const [isPurchaseConfirming, setIsPurchaseConfirming] = React.useState(false);
  const [exportingKind, setExportingKind] =
    React.useState<PurchaseExportKind | null>(null);
  const [columnFilters, setColumnFilters] =
    React.useState<PurchasePendingColumnFilters>(() => ({
      ...emptyPurchasePendingColumnFilters,
    }));
  const [sort, setSort] = React.useState<PurchasePendingSortState>(null);
  const { runGuardedAction } = useUnsavedChanges();
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedBatchNo = batchNo.trim();
  const currentQueryKey = `${priceDate}\u001f${conditionNote}`;
  const priceQueryReady = loadedQueryKey === currentQueryKey;
  const inspectedDevices = React.useMemo(
    () => devices.filter((device) => device.inbound?.status === "INSPECTED"),
    [devices]
  );
  const rateForDevice = React.useCallback(
    (device: DeviceListRow) => {
      if (!device.storage || !device.appearanceGrade) {
        return null;
      }

      const matches = rates.filter(
        (rate) =>
          (device.modelCode
            ? rate.modelOptionKey === device.modelCode
            : rate.model === device.model) &&
          (rate.storageOptionKey === device.storage ||
            rate.storage === device.storage) &&
          (rate.appearanceGradeOptionKey === device.appearanceGrade ||
            rate.appearanceGrade === device.appearanceGrade)
      );

      return matches.length === 1 ? matches[0] : null;
    },
    [rates]
  );
  const changedPurchasePriceDraftEntries = React.useMemo(
    () =>
      Object.entries(purchasePriceDrafts).filter(([pgNo, value]) => {
        const device = inspectedDevices.find((item) => item.pgNo === pgNo);
        if (!device) {
          return true;
        }

        const originalPrice = rateForDevice(device)?.purchasePrice ?? null;
        return parsePriceInput(value) !== originalPrice;
      }),
    [inspectedDevices, purchasePriceDrafts, rateForDevice]
  );
  const discardPurchasePriceDrafts = React.useCallback(() => {
    setPurchasePriceDrafts({});
    setIsPurchaseConfirmOpen(false);
    setPurchaseConfirmSnapshot(null);
    setPurchaseConfirmOtpCode("");
    setMessage("");
  }, []);

  useUnsavedForm({
    id: PURCHASE_PENDING_PRICE_FORM_ID,
    label: t("unsaved"),
    isDirty: changedPurchasePriceDraftEntries.length > 0,
    isBusy: isPurchaseConfirming,
    discard: discardPurchasePriceDrafts,
  });
  const baseFilteredDevices = React.useMemo(() => {
    return inspectedDevices.filter((device) => {
      const deviceCompletedDate =
        device.inspectionCompletedAt?.slice(0, 10) ||
        device.updatedAt.slice(0, 10);

      if (completedDate && deviceCompletedDate !== completedDate) {
        return false;
      }

      if (
        normalizedBatchNo &&
        !String(device.inbound?.batchNo ?? "").includes(normalizedBatchNo)
      ) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return purchasePendingSearchableText(device).includes(normalizedQuery);
    });
  }, [completedDate, inspectedDevices, normalizedBatchNo, normalizedQuery]);

  React.useEffect(() => {
    let ignore = false;

    async function loadRates() {
      const generation = ++rateRequestGenerationRef.current;
      setIsLoadingRates(true);
      setLoadedQueryKey(null);
      setRates([]);
      setPurchasePriceDrafts({});
      setPurchaseConfirmSnapshot(null);
      setIsPurchaseConfirmOpen(false);

      try {
        const response = await fetch(
          `/api/inbound/purchase-prices?priceDate=${encodeURIComponent(priceDate)}&note=${encodeURIComponent(conditionNote)}`,
          { cache: "no-store" }
        );
        const payload = (await response.json().catch(() => null)) as
          | PurchasePriceApiResponse
          | null;

        if (!response.ok || !payload?.ok) {
          throw new Error(legacyApiMessage(payload, t("fallback.rateLoadFailed")));
        }

        if (
          payload.queryContext?.priceDate !== priceDate ||
          payload.queryContext.note !== conditionNote
        ) {
          throw new Error(t("fallback.rateQueryMismatch"));
        }

        if (!ignore && rateRequestGenerationRef.current === generation) {
          setRates(payload.rates ?? []);
          setConditionNoteOptions(payload.notes ?? []);
          setLoadedQueryKey(`${priceDate}\u001f${conditionNote}`);
          setMessage("");
        }
      } catch (error) {
        if (!ignore && rateRequestGenerationRef.current === generation) {
          setMessage(error instanceof Error ? error.message : String(error));
          setMessageTone("warning");
        }
      } finally {
        if (!ignore && rateRequestGenerationRef.current === generation) {
          setIsLoadingRates(false);
        }
      }
    }

    void loadRates();

    return () => {
      ignore = true;
    };
  }, [conditionNote, priceDate, t]);

  function resetFilters() {
    setQuery("");
    setCompletedDate("");
    setBatchNo("");
    setPriceDate(todayKstDate());
    setConditionNote("");
    setColumnFilters({ ...emptyPurchasePendingColumnFilters });
    setSort(null);
  }

  function requestPriceDateChange(value: string) {
    if (value === priceDate) return;

    runGuardedAction({
      intent: "internal-change",
      formIds: [PURCHASE_PENDING_PRICE_FORM_ID],
      targetLabel: t("navigation.openDate", { date: value || t("navigation.unspecified") }),
      action: () => setPriceDate(value),
    });
  }

  function requestConditionNoteChange(value: string) {
    if (value === conditionNote) return;

    runGuardedAction({
      intent: "internal-change",
      formIds: [PURCHASE_PENDING_PRICE_FORM_ID],
      targetLabel: t("navigation.openCondition", { condition: value || t("navigation.defaultCondition") }),
      action: () => setConditionNote(value),
    });
  }

  const purchasePriceDraftForDevice = React.useCallback(
    (device: DeviceListRow, rate: PurchasePriceRateDto | null) => {
      const draft = purchasePriceDrafts[device.pgNo];

      if (draft !== undefined) {
        return draft;
      }

      return rate ? formatPriceInput(String(rate.purchasePrice), locale) : "";
    },
    [locale, purchasePriceDrafts]
  );

  const updatePurchasePriceDraft = React.useCallback(
    (pgNo: string, value: string) => {
      setPurchasePriceDrafts((current) => ({
        ...current,
        [pgNo]: formatPriceInput(value, locale),
      }));
    },
    [locale]
  );

  function hasPurchasePriceForDevice(device: DeviceListRow) {
    const rate = rateForDevice(device);

    return parsePriceInput(purchasePriceDraftForDevice(device, rate)) !== null;
  }

  const purchasePendingColumnText = React.useCallback(
    (device: DeviceListRow, key: PurchasePendingColumnKey) => {
      const rate = rateForDevice(device);

      switch (key) {
        case "pgNo":
          return device.pgNo;
        case "batchNo":
          return device.inbound?.batchNo === null ||
            device.inbound?.batchNo === undefined
            ? ""
            : String(device.inbound.batchNo);
        case "supplierName":
          return device.inbound?.supplierName ?? "";
        case "model":
          return [device.model, device.imei].filter(Boolean).join(" ");
        case "storage":
          return device.storage ?? "";
        case "appearanceGrade":
          return device.appearanceGrade ?? "";
        case "saleGrade":
          return device.saleGrade ?? "";
        case "appearanceDefect":
          return device.appearanceDefect ?? "";
        case "functionDefect":
          return device.functionDefect ?? "";
        case "purchasePrice": {
          const draft = purchasePriceDrafts[device.pgNo];
          return draft !== undefined
            ? draft
            : rate
              ? formatPrice(rate.purchasePrice, locale)
              : "";
        }
        default:
          return "";
      }
    },
    [locale, purchasePriceDrafts, rateForDevice]
  );
  const visibleDevices = React.useMemo(() => {
    const activeFilters = Object.entries(columnFilters)
      .map(
        ([key, value]) =>
          [key as PurchasePendingColumnKey, value.trim().toLowerCase()] as const
      )
      .filter(([, value]) => value !== "");
    const filteredRows =
      activeFilters.length === 0
        ? baseFilteredDevices
        : baseFilteredDevices.filter((device) =>
            activeFilters.every(([key, value]) =>
              purchasePendingColumnText(device, key).toLowerCase().includes(value)
            )
          );

    if (!sort) {
      return filteredRows;
    }

    return [...filteredRows].sort((left, right) => {
      const result = comparePurchasePendingValues(
        sort.key === "batchNo"
          ? left.inbound?.batchNo
          : sort.key === "purchasePrice"
            ? parsePriceInput(purchasePendingColumnText(left, sort.key))
            : purchasePendingColumnText(left, sort.key),
        sort.key === "batchNo"
          ? right.inbound?.batchNo
          : sort.key === "purchasePrice"
            ? parsePriceInput(purchasePendingColumnText(right, sort.key))
            : purchasePendingColumnText(right, sort.key),
        locale
      );

      return sort.direction === "asc" ? result : -result;
    });
  }, [
    baseFilteredDevices,
    columnFilters,
    locale,
    purchasePendingColumnText,
    sort,
  ]);
  const pricedVisibleCount = visibleDevices.filter((device) =>
    hasPurchasePriceForDevice(device)
  ).length;
  const missingPriceVisibleCount = visibleDevices.length - pricedVisibleCount;

  function purchaseConfirmItemsForDevices(
    devicesForConfirm: DeviceListRow[]
  ): PurchaseConfirmItem[] {
    return devicesForConfirm
      .map((device) => {
        const rate = rateForDevice(device);
        const purchasePrice = parsePriceInput(
          purchasePriceDraftForDevice(device, rate)
        );

        return purchasePrice === null || !device.inbound
          ? null
          : {
              pgNo: device.pgNo,
              expectedInboundId: device.inbound.id,
              expectedInboundRevision: device.inbound.revision,
              purchasePrice,
              purchasePriceRateId: rate?.id ?? null,
              purchasePriceRateRevision: rate?.revision ?? null,
              purchasePriceQueryContext: {
                priceDate,
                note: conditionNote,
              },
            };
      })
      .filter((item): item is PurchaseConfirmItem => item !== null);
  }

  function purchaseConfirmItems() {
    return purchaseConfirmItemsForDevices(visibleDevices);
  }

  function exportFilenameFromResponse(
    response: Response,
    fallbackLabel: string
  ) {
    const disposition = response.headers.get("content-disposition") || "";
    const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);

    if (encodedMatch?.[1]) {
      return decodeURIComponent(encodedMatch[1].replace(/^"|"$/g, ""));
    }

    const plainMatch = disposition.match(/filename="?([^";]+)"?/i);

    if (plainMatch?.[1]) {
      return plainMatch[1];
    }

    return `${fallbackLabel}.xlsx`;
  }

  async function downloadPurchaseExport(
    kind: PurchaseExportKind,
    label: string
  ) {
    if (exportingKind) {
      return;
    }

    if (!priceQueryReady) {
      setMessage(t("message.ratesRequiredForExport"));
      setMessageTone("warning");
      return;
    }

    if (visibleDevices.length === 0) {
      setMessage(t("message.noExportDevices"));
      setMessageTone("warning");
      return;
    }

    if (pricedVisibleCount === 0) {
      setMessage(t("message.noPricedExportDevices"));
      setMessageTone("warning");
      return;
    }

    setExportingKind(kind);
    setMessage("");

    try {
      const response = await fetch("/api/inbound/purchase-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          purchaseDate: priceDate,
          batchNo,
          conditionNote,
          items: purchaseConfirmItems(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;

        throw new Error(legacyApiMessage(payload, t("message.exportFailed", { label })));
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");

      anchor.href = url;
      anchor.download = exportFilenameFromResponse(response, label);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      setMessage(t("message.exported", { label }));
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setExportingKind(null);
    }
  }

  function openPurchaseConfirm() {
    if (!priceQueryReady) {
      setMessage(t("message.ratesRequiredForConfirm"));
      setMessageTone("warning");
      return;
    }

    if (visibleDevices.length === 0) {
      setMessage(t("message.noConfirmDevices"));
      setMessageTone("warning");
      return;
    }

    const snapshotItems = purchaseConfirmItemsForDevices(visibleDevices);

    if (snapshotItems.length === 0) {
      setMessage(t("message.noPricedConfirmDevices"));
      setMessageTone("warning");
      return;
    }

    setPurchaseConfirmSnapshot({
      items: snapshotItems,
      targetCount: snapshotItems.length,
      excludedCount: visibleDevices.length - snapshotItems.length,
    });
    setPurchaseConfirmOtpCode("");
    setIsPurchaseConfirmOpen(true);
    setMessage("");
  }

  async function verifyPurchaseConfirm() {
    if (!purchaseConfirmOtpCode || isPurchaseConfirming) {
      return;
    }

    if (!purchaseConfirmSnapshot || purchaseConfirmSnapshot.items.length === 0) {
      setMessage(t("message.confirmTargetsMissing"));
      setMessageTone("warning");
      setIsPurchaseConfirmOpen(false);
      setPurchaseConfirmOtpCode("");
      setPurchaseConfirmSnapshot(null);
      return;
    }

    setIsPurchaseConfirming(true);
    setMessage("");
    setPostWriteRefreshWarning("");

    try {
      const response = await fetch("/api/auth/sensitive-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          otpCode: purchaseConfirmOtpCode,
          sensitiveAction: SENSITIVE_ACTIONS.inboundPurchaseConfirm,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | SensitiveAuthApiResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.sensitiveAuthenticated) {
        throw new Error(legacyApiMessage(payload, t("message.authFailed")));
      }

      const confirmResponse = await fetch("/api/inbound/purchase-confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: purchaseConfirmSnapshot.items }),
      });
      const confirmPayload = (await confirmResponse.json().catch(() => null)) as
        | PurchaseConfirmApiResponse
        | null;

      if (!confirmResponse.ok || !confirmPayload?.ok) {
        throw new Error(confirmPayload?.message || t("message.confirmFailed"));
      }

      const reconciliation = reconcilePurchaseConfirmResults(
        purchaseConfirmSnapshot.items.map((item) => item.pgNo),
        confirmPayload.results
      );
      if (reconciliation.complete) {
        setPurchasePriceDrafts((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([pgNo]) => !reconciliation.completedPgNos.has(pgNo)
            )
          )
        );
      }
      setIsPurchaseConfirmOpen(false);
      setPurchaseConfirmOtpCode("");
      setPurchaseConfirmSnapshot(null);
      const conflicts = reconciliation.conflicts;
      const resultMessage =
        confirmPayload.resultCode === "PURCHASE_CONFIRM_NO_TARGET"
          ? t("message.noConfirmTarget")
          : confirmPayload.resultCode === "PURCHASE_CONFIRM_RESULT" &&
              confirmPayload.messageArguments
            ? t("message.confirmResult", confirmPayload.messageArguments)
            : t("message.processed");
      setMessage(
        !reconciliation.complete
          ? t("message.resultIncomplete")
          : conflicts.length > 0
            ? `${resultMessage} ${conflicts
                .map((item) => `${item.pgNo}: ${item.reason || t("message.targetChanged")}`)
                .join(" / ")}`
            : resultMessage || t("message.completed")
      );
      setMessageTone(
        !reconciliation.complete || conflicts.length > 0 ? "warning" : "success"
      );

      try {
        await deviceList.reload();
      } catch {
        setPostWriteRefreshWarning(feedbackT(POST_WRITE_REFRESH_WARNING_KEY));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsPurchaseConfirming(false);
    }
  }

  const updateColumnFilter = React.useCallback(
    (key: PurchasePendingColumnKey, value: string) => {
      setColumnFilters((current) => ({
        ...current,
        [key]: value,
      }));
    },
    []
  );
  const purchasePendingColumns = React.useMemo<
    DataGridColumn<PurchasePendingColumnKey, DeviceListRow>[]
  >(
    () => [
      {
        key: "pgNo",
        label: "PG",
        width: "120px",
        placeholder: t("placeholders.pg"),
        cellClassName: "flex items-center px-3 font-semibold",
        render: (device) => device.pgNo,
        text: (device) => purchasePendingColumnText(device, "pgNo"),
      },
      {
        key: "batchNo",
        label: t("columns.batch"),
        width: "70px",
        placeholder: t("columns.batch"),
        cellClassName: "flex items-center px-3",
        render: (device) => device.inbound?.batchNo ?? "-",
        text: (device) => purchasePendingColumnText(device, "batchNo"),
        sortValue: (device) => device.inbound?.batchNo,
      },
      {
        key: "supplierName",
        label: t("columns.supplier"),
        width: "110px",
        placeholder: t("columns.supplier"),
        cellClassName: "flex items-center px-3",
        render: (device) => device.inbound?.supplierName || "-",
        text: (device) => purchasePendingColumnText(device, "supplierName"),
      },
      {
        key: "model",
        label: t("columns.model"),
        width: "minmax(170px,1fr)",
        placeholder: t("placeholders.model"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (device) => (
          <>
            <div className="truncate font-medium" title={device.model}>
              {device.model}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              IMEI {device.imei || "-"}
            </div>
          </>
        ),
        text: (device) => purchasePendingColumnText(device, "model"),
      },
      {
        key: "storage",
        label: t("columns.storage"),
        width: "86px",
        placeholder: t("columns.storage"),
        cellClassName: "flex items-center px-3",
        render: (device) => device.storage || "-",
        text: (device) => purchasePendingColumnText(device, "storage"),
      },
      {
        key: "appearanceGrade",
        label: t("columns.appearanceGrade"),
        width: "105px",
        placeholder: t("columns.appearanceGrade"),
        cellClassName: "flex items-center px-3",
        render: (device) =>
          device.appearanceGrade ? (
            <Badge variant="neutral">{device.appearanceGrade}</Badge>
          ) : (
            "-"
          ),
        text: (device) => purchasePendingColumnText(device, "appearanceGrade"),
      },
      {
        key: "saleGrade",
        label: t("columns.saleGrade"),
        width: "100px",
        placeholder: t("columns.saleGrade"),
        cellClassName: "flex items-center px-3",
        render: (device) => <SaleGradeBadge value={device.saleGrade} />,
        text: (device) => purchasePendingColumnText(device, "saleGrade"),
      },
      {
        key: "appearanceDefect",
        label: t("columns.appearanceDefect"),
        width: "160px",
        placeholder: t("columns.appearanceDefect"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (device) => (
          <div className="truncate" title={device.appearanceDefect || undefined}>
            {device.appearanceDefect || "-"}
          </div>
        ),
        text: (device) => purchasePendingColumnText(device, "appearanceDefect"),
      },
      {
        key: "functionDefect",
        label: t("columns.functionDefect"),
        width: "160px",
        placeholder: t("columns.functionDefect"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (device) => (
          <div className="truncate" title={device.functionDefect || undefined}>
            {device.functionDefect || "-"}
          </div>
        ),
        text: (device) => purchasePendingColumnText(device, "functionDefect"),
      },
      {
        key: "purchasePrice",
        label: t("columns.price"),
        width: "130px",
        placeholder: t("columns.price"),
        headerClassName: "justify-end",
        cellClassName: "flex items-center px-3",
        render: (device) => {
          const rate = rateForDevice(device);

          return (
            <Input
              className="h-8 text-right"
              inputMode="numeric"
              value={purchasePriceDraftForDevice(device, rate)}
              placeholder={rate ? formatPrice(rate.purchasePrice, locale) : "0"}
              onClick={(event) => {
                event.stopPropagation();
              }}
              onChange={(event) =>
                updatePurchasePriceDraft(device.pgNo, event.target.value)
              }
            />
          );
        },
        text: (device) => purchasePendingColumnText(device, "purchasePrice"),
        sortValue: (device) =>
          parsePriceInput(purchasePendingColumnText(device, "purchasePrice")),
      },
    ],
    [
      locale,
      purchasePendingColumnText,
      purchasePriceDraftForDevice,
      rateForDevice,
      t,
      updatePurchasePriceDraft,
    ]
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 p-5">
      <SummaryStrip className="grid-cols-4">
        <SummaryCell
          icon={PackageCheck}
          label={t("summary.inspected")}
          value={inspectedDevices.length}
        />
        <SummaryCell icon={ListChecks} label={t("summary.visible")} value={visibleDevices.length} />
        <SummaryCell icon={BadgeDollarSign} label={t("summary.priced")} value={pricedVisibleCount} />
        <SummaryCell icon={Database} label={t("summary.missingPrice")} value={missingPriceVisibleCount} />
      </SummaryStrip>

      <section className="grid gap-3 rounded-md border bg-popover p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid w-[170px] gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              {t("filters.completedDate")}
            </span>
            <Input
              type="date"
              value={completedDate}
              onChange={(event) => setCompletedDate(event.target.value)}
            />
          </label>
          <label className="grid w-[150px] gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("filters.batch")}</span>
            <Input
              value={batchNo}
              placeholder={t("filters.batchPlaceholder")}
              onChange={(event) => setBatchNo(event.target.value)}
            />
          </label>
          <label className="grid w-[170px] gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              {t("filters.priceDate")}
            </span>
            <Input
              type="date"
              value={priceDate}
              onChange={(event) => requestPriceDateChange(event.target.value)}
            />
          </label>
          <PurchaseConditionNoteInput
            value={conditionNote}
            options={conditionNoteOptions}
            onChange={requestConditionNoteChange}
          />
          <SearchInput
            label={t("filters.query")}
            wrapperClassName="min-w-[280px] flex-1"
            placeholder={t("filters.queryPlaceholder")}
            value={query}
            name="quickhack_purchase_pending_search"
            data-form-type="search"
            data-lpignore="true"
            data-1p-ignore="true"
            onValueChange={setQuery}
          />
          <Button variant="outline" onClick={resetFilters}>
            <RefreshCcw className="size-4" />
            {t("actions.reset")}
          </Button>
        </div>

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
      </section>

      <section className="grid shrink-0 gap-3 rounded-md border bg-popover px-4 py-3 2xl:grid-cols-[minmax(0,1fr)_auto] 2xl:items-center">
        <div className="text-sm text-muted-foreground">
          {t("summary.result", {
            missing: missingPriceVisibleCount,
            priced: pricedVisibleCount,
            visible: visibleDevices.length,
          })}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void downloadPurchaseExport(
                "purchase-statement",
                t("exportLabel.statement")
              )
            }
            disabled={exportingKind !== null}
          >
            <FileDown className="size-4" />
            {exportingKind === "purchase-statement"
              ? t("actions.exporting")
              : t("actions.exportStatement")}
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void downloadPurchaseExport(
                "jungabi-registration",
                t("exportLabel.jungabi")
              )
            }
            disabled={exportingKind !== null}
          >
            <FileDown className="size-4" />
            {exportingKind === "jungabi-registration"
              ? t("actions.exporting")
              : t("actions.exportJungabi")}
          </Button>
          <div className="mx-1 hidden h-6 w-px bg-border md:block" />
          <Button
            variant="outline"
            className={dangerousActionButtonClassName}
            onClick={openPurchaseConfirm}
          >
            <ShieldCheck className="size-4" />
            {t("actions.confirm")}
          </Button>
        </div>
      </section>

      {isPurchaseConfirmOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
          <div className="grid w-full max-w-md gap-4 rounded-md border border-red-200 bg-popover p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-red-100 text-red-700">
                <AlertTriangle className="size-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-red-700">
                  {t("confirmation.title")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("confirmation.description")}
                </p>
              </div>
            </div>

            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
              {t("confirmation.summary", {
                excluded: purchaseConfirmSnapshot?.excludedCount ?? 0,
                target: purchaseConfirmSnapshot?.targetCount ?? 0,
              })}
            </div>

            <label className="grid gap-1.5 text-sm font-medium">
              {t("confirmation.otp")}
              <input
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                name="quickhack_purchase_confirm_username"
                autoComplete="username"
                data-form-type="username"
                value="quickhack"
                readOnly
              />
              <Input
                type="text"
                inputMode="numeric"
                name="quickhack_purchase_confirm_otp"
                autoComplete="one-time-code"
                data-form-type="one-time-code"
                value={purchaseConfirmOtpCode}
                disabled={isPurchaseConfirming}
                onChange={(event) =>
                  setPurchaseConfirmOtpCode(event.target.value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void verifyPurchaseConfirm();
                  }
                }}
              />
            </label>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setIsPurchaseConfirmOpen(false);
                  setPurchaseConfirmOtpCode("");
                  setPurchaseConfirmSnapshot(null);
                }}
                disabled={isPurchaseConfirming}
              >
                {t("actions.cancel")}
              </Button>
              <Button
                variant="outline"
                className={dangerousActionButtonClassName}
                onClick={verifyPurchaseConfirm}
                disabled={
                  !purchaseConfirmOtpCode ||
                  !purchaseConfirmSnapshot ||
                  isPurchaseConfirming
                }
              >
                <ShieldCheck className="size-4" />
                {isPurchaseConfirming
                  ? t("actions.confirming")
                  : t("actions.verifyAndConfirm")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <VirtualizedDataGrid
        rows={visibleDevices}
        columns={purchasePendingColumns}
        rowKey={(device) => device.pgNo}
        emptyMessage={t("empty")}
        onRowClick={(device) => onOpenDevice(device.pgNo)}
        filters={columnFilters}
        sort={sort}
        onFilterChange={updateColumnFilter}
        onSortChange={setSort}
        minWidth="1250px"
        rowHeight={64}
      />

      {deviceList.isLoading ? (
        <div className="text-xs text-muted-foreground">
          {t("loading.devices")}
        </div>
      ) : null}

      {isLoadingRates ? (
        <div className="text-xs text-muted-foreground">
          {t("loading.rates")}
        </div>
      ) : null}
    </section>
  );
}
