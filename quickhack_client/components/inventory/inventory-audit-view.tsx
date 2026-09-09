// QuickHack note: 판매가능 재고의 실물 위치를 점검하고 inventory.location에 저장하는 재고 실사 화면입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
import { ClipboardCheck, PackageCheck, Printer, RefreshCcw, Save } from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { Input } from "@/quickhack_client/components/ui/input";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import {
  SummaryMetric as SummaryCard,
  SummaryStrip,
} from "@/quickhack_client/components/ui/summary-metric";
import { TableSelectCheckbox } from "@/quickhack_client/components/ui/table-select-checkbox";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  buildPrintHtmlDocument,
  escapePrintHtml,
  printHtmlDocument,
} from "@/quickhack_client/lib/printing/print-html";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import type { DeviceListRow } from "@/quickhack_shared/device/device-list-query";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import { cn } from "@/quickhack_shared/core/utils";
import { useUnsavedForm } from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { POST_WRITE_REFRESH_WARNING_KEY } from "@/quickhack_client/lib/post-write-refresh";
import { useDeviceListQuery } from "@/quickhack_client/components/shared/device-list-query-client";

type InventoryAuditApiResponse = {
  ok: boolean;
  message?: string;
  changedCount?: number;
  auditBaseDate?: string;
  auditPeriodFrom?: string;
  auditPeriodTo?: string;
};

type InventoryAuditLocation = "포장 완료" | "포장 대기" | "상품화 대기";
type InventoryAuditColumnKey =
  | "pgNo"
  | "modelSeq"
  | "model"
  | "saleGrade"
  | "location"
  | "packed"
  | "packingWaiting"
  | "productWaiting";

const INVENTORY_AUDIT_LOCATIONS: Array<{
  key: Extract<InventoryAuditColumnKey, "packed" | "packingWaiting" | "productWaiting">;
  value: InventoryAuditLocation;
}> = [
  { key: "packed", value: "포장 완료" },
  { key: "packingWaiting", value: "포장 대기" },
  { key: "productWaiting", value: "상품화 대기" },
];
const DEFAULT_INVENTORY_AUDIT_SCOPE = INVENTORY_AUDIT_LOCATIONS.slice(0, 2).map(
  (location) => location.value
);

const auditTableCellClassName = "flex h-full min-w-0 items-center px-3";
const auditCheckboxCellClassName =
  "flex h-full min-w-0 items-center justify-center px-3";
const INVENTORY_AUDIT_FORM_ID = "inventory.audit";

function normalizeLocation(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function normalizeScanValue(value: string) {
  return value.trim().toUpperCase();
}

function todayKstDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const partByType = new Map(parts.map((part) => [part.type, part.value]));

  return `${partByType.get("year")}-${partByType.get("month")}-${partByType.get("day")}`;
}

function deviceModelText(device: DeviceListRow) {
  return [device.model, device.storage, device.color].filter(Boolean).join(" ");
}

function compareAuditDevices(
  left: DeviceListRow,
  right: DeviceListRow,
  locale: string
) {
  return (
    String(left.model || "").localeCompare(String(right.model || ""), locale, {
      numeric: true,
      sensitivity: "base",
    }) ||
    String(left.saleGrade || "").localeCompare(String(right.saleGrade || ""), locale, {
      numeric: true,
      sensitivity: "base",
    }) ||
    Number(left.modelSeq ?? Number.MAX_SAFE_INTEGER) -
      Number(right.modelSeq ?? Number.MAX_SAFE_INTEGER) ||
    left.pgNo.localeCompare(right.pgNo, locale, {
      numeric: true,
      sensitivity: "base",
    })
  );
}

const inventoryAuditPrintStyles = `
  @page {
    size: A4 portrait;
    margin: 10mm;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    background: #ffffff;
    color: #111827;
    font-family: "Malgun Gothic", "Apple SD Gothic Neo", Arial, sans-serif;
  }

  .print-page {
    display: grid;
    gap: 10px;
  }

  .print-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    border-bottom: 2px solid #111827;
    padding-bottom: 10px;
  }

  .eyebrow {
    margin: 0 0 3px;
    color: #2563eb;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  h1 {
    margin: 0;
    font-size: 20px;
    line-height: 1.2;
  }

  .meta {
    display: grid;
    gap: 3px;
    color: #4b5563;
    font-size: 10px;
    text-align: right;
  }

  table {
    width: calc(100% - 1.5mm);
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 9px;
  }

  thead {
    display: table-header-group;
  }

  tfoot {
    display: table-footer-group;
  }

  th {
    border: 1px solid #9ca3af;
    background: #eef2f7;
    color: #374151;
    padding: 5px 4px;
    text-align: center;
    font-weight: 700;
  }

  td {
    border: 1px solid #c5ccd6;
    padding: 4px;
    vertical-align: middle;
  }

  tbody tr:nth-child(even) {
    background: #fbfdff;
  }

  .number-cell,
  .grade-cell,
  .check-cell {
    text-align: center;
  }

  .pg-cell {
    font-weight: 700;
  }

  .model-cell {
    overflow-wrap: anywhere;
  }

  .check-box {
    display: inline-flex;
    width: 14px;
    height: 14px;
    align-items: center;
    justify-content: center;
    border: 1.5px solid #6b7280;
    border-radius: 3px;
    color: #047857;
    font-size: 12px;
    font-weight: 900;
    line-height: 1;
  }

  .check-box.checked {
    border-color: #047857;
    background: #ecfdf5;
  }

  .sign-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding-top: 8px;
    page-break-inside: avoid;
  }

  .sign-box {
    height: 32px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 5px 7px;
    color: #6b7280;
    font-size: 10px;
  }

  .footer-cell {
    border: 0;
    padding: 0;
  }
`;

function printCheckBox(currentLocation: string, targetLocation: InventoryAuditLocation) {
  const checked = currentLocation === targetLocation;

  return `<span class="check-box${checked ? " checked" : ""}">${
    checked ? "✓" : ""
  }</span>`;
}


export function InventoryAuditView() {
  const feedbackT = useTranslations("common.feedback");
  const t = useTranslations("inventory.audit");
  const printT = useTranslations("common.printing");
  const locale = useLocale();
  const deviceList = useDeviceListQuery({
    endpoint: "/api/inventory/audit-candidates",
    queryString: "limit=100",
    autoLoadAll: true,
  });
  const devices = deviceList.items;
  const scanInputRef = React.useRef<HTMLInputElement>(null);
  const [locationOverrides, setLocationOverrides] = React.useState<
    Record<string, string>
  >({});
  const [selectedLocation, setSelectedLocation] =
    React.useState<InventoryAuditLocation>(INVENTORY_AUDIT_LOCATIONS[0].value);
  const [auditScopeLocations, setAuditScopeLocations] = React.useState<
    InventoryAuditLocation[]
  >(() => DEFAULT_INVENTORY_AUDIT_SCOPE);
  const [scanValue, setScanValue] = React.useState("");
  const [lastScannedPgNo, setLastScannedPgNo] = React.useState<string | null>(
    null
  );
  const [scannedPgNos, setScannedPgNos] = React.useState<Set<string>>(
    () => new Set()
  );
  const [showOnlyUnassigned, setShowOnlyUnassigned] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [auditBaseDate, setAuditBaseDate] = React.useState(todayKstDate);
  const [message, setMessage] = React.useState(() => t("status.idle"));
  const [messageTone, setMessageTone] = React.useState<
    "neutral" | "warning" | "success"
  >("neutral");
  const [postWriteRefreshWarning, setPostWriteRefreshWarning] =
    React.useState("");

  const auditScopeSet = React.useMemo(
    () => new Set(auditScopeLocations),
    [auditScopeLocations]
  );

  const sellableDevices = React.useMemo(
    () =>
      devices
        .filter((device) => device.inventory?.status === INVENTORY_STATUS.sellable)
        .sort((left, right) => compareAuditDevices(left, right, locale)),
    [devices, locale]
  );

  const sellableDeviceByScanValue = React.useMemo(() => {
    const result = new Map<string, DeviceListRow>();

    for (const device of sellableDevices) {
      result.set(normalizeScanValue(device.pgNo), device);

      if (device.imei) {
        result.set(normalizeScanValue(device.imei), device);
      }
    }

    return result;
  }, [sellableDevices]);

  const deviceByScanValue = React.useMemo(() => {
    const result = new Map<string, DeviceListRow>();

    for (const device of devices) {
      result.set(normalizeScanValue(device.pgNo), device);

      if (device.imei) {
        result.set(normalizeScanValue(device.imei), device);
      }
    }

    return result;
  }, [devices]);

  const getDraftLocation = React.useCallback(
    (device: DeviceListRow) =>
      Object.prototype.hasOwnProperty.call(locationOverrides, device.pgNo)
        ? normalizeLocation(locationOverrides[device.pgNo])
        : normalizeLocation(device.inventory?.location),
    [locationOverrides]
  );

  const changedItems = React.useMemo(
    () =>
      sellableDevices
        .map((device) => ({
          pgNo: device.pgNo,
          inventoryId: device.inventory?.id ?? -1,
          expectedRevision: device.inventory?.revision ?? -1,
          originalLocation: normalizeLocation(device.inventory?.location),
          location: getDraftLocation(device),
        }))
        .filter((item) => item.originalLocation !== item.location),
    [getDraftLocation, sellableDevices]
  );

  const discardAuditDraft = React.useCallback(() => {
    setLocationOverrides({});
    setScanValue("");
    setLastScannedPgNo(null);
    setScannedPgNos(new Set());
    setShowOnlyUnassigned(false);
    setMessage(t("status.idle"));
    setMessageTone("neutral");
  }, [t]);

  useUnsavedForm({
    id: INVENTORY_AUDIT_FORM_ID,
    label: t("unsaved"),
    isDirty: changedItems.length > 0,
    isBusy: isSaving,
    discard: discardAuditDraft,
  });

  const scopedChangedItems = React.useMemo(
    () =>
      changedItems.filter(
        (item) =>
          auditScopeSet.has(item.originalLocation as InventoryAuditLocation) ||
          auditScopeSet.has(item.location as InventoryAuditLocation)
      ),
    [auditScopeSet, changedItems]
  );

  const unassignedDevices = React.useMemo(
    () => sellableDevices.filter((device) => !getDraftLocation(device)),
    [getDraftLocation, sellableDevices]
  );

  const scopedUnassignedDevices = React.useMemo(
    () =>
      sellableDevices.filter((device) => {
        const originalLocation = normalizeLocation(device.inventory?.location);
        const draftLocation = getDraftLocation(device);

        return (
          !draftLocation &&
          auditScopeSet.has(originalLocation as InventoryAuditLocation)
        );
      }),
    [auditScopeSet, getDraftLocation, sellableDevices]
  );

  const displayedUnassignedDevices =
    scopedUnassignedDevices.length > 0 ? scopedUnassignedDevices : unassignedDevices;

  const displayedDevices = showOnlyUnassigned
    ? displayedUnassignedDevices
    : sellableDevices;

  const summary = React.useMemo(() => {
    const countByLocation = new Map<string, number>();

    for (const device of sellableDevices) {
      const location = getDraftLocation(device);
      countByLocation.set(location, (countByLocation.get(location) ?? 0) + 1);
    }

    return {
      total: sellableDevices.length,
      packed: countByLocation.get("포장 완료") ?? 0,
      packingWaiting: countByLocation.get("포장 대기") ?? 0,
      productWaiting: countByLocation.get("상품화 대기") ?? 0,
      unassigned: countByLocation.get("") ?? 0,
    };
  }, [getDraftLocation, sellableDevices]);

  React.useEffect(() => {
    scanInputRef.current?.focus();
  }, []);

  function focusScanInput() {
    window.setTimeout(() => scanInputRef.current?.focus(), 0);
  }

  const includeLocationInAuditScope = React.useCallback(
    (location: InventoryAuditLocation) => {
      setAuditScopeLocations((current) => {
        if (current.includes(location)) {
          return current;
        }

        const next = new Set(current);
        next.add(location);

        return INVENTORY_AUDIT_LOCATIONS.filter((item) =>
          next.has(item.value)
        ).map((item) => item.value);
      });
    },
    []
  );

  const setDeviceLocation = React.useCallback(
    (
      pgNo: string,
      location: InventoryAuditLocation,
      checked: boolean
    ) => {
      if (checked) {
        includeLocationInAuditScope(location);
      }

      setLocationOverrides((current) => ({
        ...current,
        [pgNo]: checked ? location : "",
      }));
    },
    [includeLocationInAuditScope]
  );

  function toggleAuditScopeLocation(
    location: InventoryAuditLocation,
    checked: boolean
  ) {
    setAuditScopeLocations((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(location);
      } else {
        next.delete(location);
      }

      if (next.size === 0) {
        return current;
      }

      return INVENTORY_AUDIT_LOCATIONS.filter((item) =>
        next.has(item.value)
      ).map((item) => item.value);
    });
  }

  function selectAuditLocation(location: InventoryAuditLocation) {
    setSelectedLocation(location);
    includeLocationInAuditScope(location);
    focusScanInput();
  }

  function handleScanSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const scannedValue = normalizeScanValue(scanValue);
    setScanValue("");
    focusScanInput();

    if (!scannedValue) {
      setMessage(t("status.scanRequired"));
      setMessageTone("warning");
      return;
    }

    const device = sellableDeviceByScanValue.get(scannedValue);

    if (!device) {
      const knownDevice = deviceByScanValue.get(scannedValue);
      setLastScannedPgNo(knownDevice?.pgNo ?? null);
      setMessage(
        knownDevice
          ? t("status.notSellable", { pg: knownDevice.pgNo })
          : t("status.notFound", { value: scannedValue })
      );
      setMessageTone("warning");
      return;
    }

    const currentLocation = getDraftLocation(device);
    setLastScannedPgNo(device.pgNo);
    setScannedPgNos((current) => new Set(current).add(device.pgNo));

    if (currentLocation === selectedLocation) {
      setMessage(t("status.alreadyLocated", { pg: device.pgNo, location: t(`locations.${INVENTORY_AUDIT_LOCATIONS.find((item) => item.value === selectedLocation)?.key ?? "unassigned"}`) }));
      setMessageTone("neutral");
      return;
    }

    setLocationOverrides((current) => ({
      ...current,
      [device.pgNo]: selectedLocation,
    }));
    includeLocationInAuditScope(selectedLocation);
    setMessage(t("status.locationMarked", { pg: device.pgNo, location: t(`locations.${INVENTORY_AUDIT_LOCATIONS.find((item) => item.value === selectedLocation)?.key ?? "unassigned"}`) }));
    setMessageTone("success");
  }

  function printAuditList() {
    const printedAt = new Intl.DateTimeFormat(locale, {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    const rows = sellableDevices
      .map((device, index) => {
        const location = getDraftLocation(device);

        return `
          <tr>
            <td class="number-cell">${index + 1}</td>
            <td class="pg-cell">${escapePrintHtml(device.pgNo)}</td>
            <td>${escapePrintHtml(formatModelSeqLabel(device.model, device.modelSeq))}</td>
            <td class="model-cell">${escapePrintHtml(deviceModelText(device))}</td>
            <td class="grade-cell">${escapePrintHtml(device.saleGrade ?? "")}</td>
            <td class="check-cell">${printCheckBox(location, "포장 완료")}</td>
            <td class="check-cell">${printCheckBox(location, "포장 대기")}</td>
            <td class="check-cell">${printCheckBox(location, "상품화 대기")}</td>
          </tr>
        `;
      })
      .join("");
    const body = `
      <main class="print-page">
        <header class="print-header">
          <div>
            <p class="eyebrow">QUICKHACK INVENTORY AUDIT</p>
            <h1>${escapePrintHtml(t("print.title"))}</h1>
          </div>
          <div class="meta">
            <div>${escapePrintHtml(t("print.baseDate"))} ${escapePrintHtml(auditBaseDate)}</div>
            <div>${escapePrintHtml(t("print.printedAt"))} ${escapePrintHtml(printedAt)}</div>
            <div>${escapePrintHtml(t("print.targets", { count: sellableDevices.length }))}</div>
            <div>${escapePrintHtml(t("print.sellable", { count: sellableDevices.length }))}</div>
          </div>
        </header>

        <table>
          <colgroup>
            <col style="width: 9mm" />
            <col style="width: 28mm" />
            <col style="width: 24mm" />
            <col style="width: 48mm" />
            <col style="width: 17mm" />
            <col style="width: 18mm" />
            <col style="width: 18mm" />
            <col style="width: 18mm" />
          </colgroup>
          <thead>
            <tr>
              <th>${escapePrintHtml(t("print.sequence"))}</th>
              <th>${escapePrintHtml(t("print.pg"))}</th>
              <th>${escapePrintHtml(t("print.uniqueNo"))}</th>
              <th>${escapePrintHtml(t("print.model"))}</th>
              <th>${escapePrintHtml(t("print.saleGrade"))}</th>
              <th>${escapePrintHtml(t("locations.packed"))}</th>
              <th>${escapePrintHtml(t("locations.packingWaiting"))}</th>
              <th>${escapePrintHtml(t("locations.productWaiting"))}</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows ||
              `<tr><td colspan="8" class="number-cell">${escapePrintHtml(t("print.empty"))}</td></tr>`
            }
          </tbody>
          <tfoot>
            <tr>
              <td colspan="8" class="footer-cell">
                <section class="sign-row">
                  <div class="sign-box">${escapePrintHtml(t("print.auditor"))}</div>
                  <div class="sign-box">${escapePrintHtml(t("print.reviewer"))}</div>
                  <div class="sign-box">${escapePrintHtml(t("print.note"))}</div>
                </section>
              </td>
            </tr>
          </tfoot>
        </table>
      </main>
    `;

    void printHtmlDocument({
      title: t("print.title"),
      html: buildPrintHtmlDocument({
        title: t("print.title"),
        locale,
        styles: inventoryAuditPrintStyles,
        body,
      }),
      messages: { browserOnly: printT("browserOnly"), documentUnavailable: printT("documentUnavailable") },
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    });
  }

  async function saveAuditResult() {
    if (isSaving) {
      return;
    }

    if (scopedUnassignedDevices.length > 0) {
      setShowOnlyUnassigned(true);
      setMessage(
        t("status.unassignedBlocked", { count: scopedUnassignedDevices.length })
      );
      setMessageTone("warning");
      focusScanInput();
      return;
    }

    if (scopedChangedItems.length === 0) {
      setMessage(t("status.noChanges"));
      setMessageTone("neutral");
      return;
    }

    if (!auditBaseDate) {
      setMessage(t("status.baseDateRequired"));
      setMessageTone("warning");
      return;
    }

    setIsSaving(true);
    setPostWriteRefreshWarning("");

    try {
      const response = await fetch("/api/inventory/audit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          auditBaseDate,
          auditScope: auditScopeLocations,
          items: scopedChangedItems.map((item) => ({
            pgNo: item.pgNo,
            inventoryId: item.inventoryId,
            expectedRevision: item.expectedRevision,
            expectedLocation: item.originalLocation,
            location: item.location,
          })),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | InventoryAuditApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("status.saveFailed")));
      }

      const savedPgNos = new Set(scopedChangedItems.map((item) => item.pgNo));
      setLocationOverrides((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([pgNo]) => !savedPgNos.has(pgNo))
        )
      );
      setLastScannedPgNo(null);
      setScannedPgNos(new Set());
      setShowOnlyUnassigned(false);
      setMessage(t("status.saved"));
      setMessageTone("success");

      try {
        await deviceList.reload();
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

  const columns = React.useMemo<
    DataGridColumn<InventoryAuditColumnKey, DeviceListRow>[]
  >(
    () => [
      {
        key: "pgNo",
        label: "PG",
        width: "170px",
        cellClassName: "flex h-full min-w-0 items-center pl-4 pr-3",
        text: (device) => device.pgNo,
        render: (device) => (
          <span className="truncate font-semibold">{device.pgNo}</span>
        ),
      },
      {
        key: "modelSeq",
        label: t("columns.modelSequence"),
        width: "150px",
        cellClassName: auditTableCellClassName,
        text: (device) => formatModelSeqLabel(device.model, device.modelSeq),
        render: (device) => (
          <span className="truncate">
            {formatModelSeqLabel(device.model, device.modelSeq)}
          </span>
        ),
      },
      {
        key: "model",
        label: t("columns.model"),
        width: "minmax(260px, 1fr)",
        cellClassName: auditTableCellClassName,
        text: deviceModelText,
        render: (device) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{device.model}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[device.storage, device.color].filter(Boolean).join(" / ") || "-"}
            </p>
          </div>
        ),
      },
      {
        key: "saleGrade",
        label: t("columns.saleGrade"),
        width: "110px",
        cellClassName: auditTableCellClassName,
        text: (device) => device.saleGrade ?? "",
        render: (device) => <SaleGradeBadge value={device.saleGrade} />,
      },
      {
        key: "location",
        label: t("columns.location"),
        width: "140px",
        cellClassName: auditTableCellClassName,
        text: (device) => getDraftLocation(device),
        render: (device) => {
          const location = getDraftLocation(device);

          return (
            <Badge variant={location ? "success" : "warning"}>
              {location
                ? t(`locations.${INVENTORY_AUDIT_LOCATIONS.find((item) => item.value === location)?.key ?? "unassigned"}`)
                : t("locations.unassigned")}
            </Badge>
          );
        },
      },
      ...INVENTORY_AUDIT_LOCATIONS.map((location) => ({
        key: location.key,
        label: t(`locations.${location.key}`),
        width: "120px",
        cellClassName: auditCheckboxCellClassName,
        sortable: false,
        filterable: false,
        render: (device: DeviceListRow) => (
          <TableSelectCheckbox
            checked={getDraftLocation(device) === location.value}
            ariaLabel={`${device.pgNo} ${t(`locations.${location.key}`)}`}
            onCheckedChange={(checked) =>
              setDeviceLocation(device.pgNo, location.value, checked)
            }
          />
        ),
      })),
    ],
    [getDraftLocation, setDeviceLocation, t]
  );

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <SummaryStrip className="grid-cols-2 xl:grid-cols-5">
        <SummaryCard icon={PackageCheck} label={t("summary.sellable")} value={summary.total} />
        <SummaryCard icon={ClipboardCheck} label={t("locations.packed")} value={summary.packed} />
        <SummaryCard
          icon={ClipboardCheck}
          label={t("locations.packingWaiting")}
          value={summary.packingWaiting}
        />
        <SummaryCard
          icon={ClipboardCheck}
          label={t("locations.productWaiting")}
          value={summary.productWaiting}
        />
        <SummaryCard icon={RefreshCcw} label={t("locations.unassigned")} value={summary.unassigned} />
      </SummaryStrip>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-popover">
        <div className="grid shrink-0 gap-2 border-b p-3 xl:grid-cols-[auto_380px_minmax(0,1fr)_auto] xl:items-end">
          <div className="flex flex-wrap items-center gap-2">
            {INVENTORY_AUDIT_LOCATIONS.map((location) => (
              <Button
                key={location.key}
                type="button"
                variant={
                  selectedLocation === location.value ? "default" : "outline"
                }
                onClick={() => selectAuditLocation(location.value)}
              >
                {t(`locations.${location.key}`)}
              </Button>
            ))}
          </div>
          <form
            className="min-w-[260px] max-w-[380px] xl:w-[380px]"
            onSubmit={handleScanSubmit}
          >
            <Input
              ref={scanInputRef}
              aria-label={t("fields.scanAria")}
              autoComplete="off"
              data-lpignore="true"
              inputMode="text"
              placeholder={t("fields.scanPlaceholder")}
              value={scanValue}
              onChange={(event) => setScanValue(event.target.value)}
            />
          </form>
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("fields.scope")}
            </span>
            {INVENTORY_AUDIT_LOCATIONS.map((location) => (
              <label
                key={location.key}
                className="flex items-center gap-1.5 text-sm"
              >
                <TableSelectCheckbox
                  checked={auditScopeSet.has(location.value)}
                  ariaLabel={t("fields.scopeAria", {
                    location: t(`locations.${location.key}`),
                  })}
                  onCheckedChange={(checked) =>
                    toggleAuditScopeLocation(location.value, checked)
                  }
                />
                <span>{t(`locations.${location.key}`)}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end justify-end gap-2">
            <label className="grid w-[160px] gap-1 text-xs font-medium text-muted-foreground">
              {t("fields.baseDate")}
              <Input
                type="date"
                value={auditBaseDate}
                onChange={(event) => setAuditBaseDate(event.target.value)}
              />
            </label>
            <Button type="button" variant="outline" onClick={printAuditList}>
              <Printer className="size-4" />
              {t("actions.print")}
            </Button>
            <Button
              type="button"
              disabled={isSaving}
              onClick={() => void saveAuditResult()}
            >
              <Save className="size-4" />
              {t("actions.save")}
            </Button>
          </div>
        </div>

        {postWriteRefreshWarning ? (
          <FeedbackBanner tone="warning" className="mx-4 my-2">
            {postWriteRefreshWarning}
          </FeedbackBanner>
        ) : null}
        {deviceList.error ? (
          <FeedbackBanner tone="danger" className="mx-4 my-2">
            {deviceList.error}
          </FeedbackBanner>
        ) : null}
        {deviceList.isLoading ? (
          <FeedbackBanner tone="info" className="mx-4 my-2">
            {t("loading")}
          </FeedbackBanner>
        ) : null}

        <div
          className={cn(
            "shrink-0 border-b px-4 py-2 text-sm",
            messageTone === "warning"
              ? "text-amber-700"
              : messageTone === "success"
                ? "text-emerald-700"
                : "text-muted-foreground"
          )}
        >
          {message}
          {scopedChangedItems.length > 0 ? (
            <span className="ml-2 font-medium text-primary">
              {t("status.saveTarget", { count: scopedChangedItems.length })}
            </span>
          ) : null}
          {changedItems.length > scopedChangedItems.length ? (
            <span className="ml-2 font-medium text-muted-foreground">
              {t("status.outOfScope", {
                count: changedItems.length - scopedChangedItems.length,
              })}
            </span>
          ) : null}
          {scannedPgNos.size > 0 ? (
            <span className="ml-2 font-medium text-sky-700">
              {t("status.scanned", { count: scannedPgNos.size })}
            </span>
          ) : null}
          {unassignedDevices.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-3"
              onClick={() => setShowOnlyUnassigned((current) => !current)}
            >
              {showOnlyUnassigned
                ? t("actions.showAll")
                : t("actions.showUnassigned")}
            </Button>
          ) : null}
        </div>

        <VirtualizedDataGrid
          rows={displayedDevices}
          columns={columns}
          rowKey={(device) => device.pgNo}
          emptyMessage={
            showOnlyUnassigned
              ? t("empty.unassigned")
              : t("empty.sellable")
          }
          getRowClassName={(device) =>
            device.pgNo === lastScannedPgNo
              ? "bg-sky-50/80"
              : normalizeLocation(device.inventory?.location) !==
                  getDraftLocation(device)
                ? "bg-emerald-50/40"
                : undefined
          }
          minWidth="1190px"
          rowHeight={56}
        />
      </section>
    </WorkspacePageFrame>
  );
}
