// QuickHack note: 판매가능 재고의 실물 위치를 점검하고 inventory.location에 저장하는 재고 실사 화면입니다.
"use client";

import * as React from "react";
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
import { POST_WRITE_REFRESH_WARNING } from "@/quickhack_client/lib/post-write-refresh";
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
  label: InventoryAuditLocation;
}> = [
  { key: "packed", label: "포장 완료" },
  { key: "packingWaiting", label: "포장 대기" },
  { key: "productWaiting", label: "상품화 대기" },
];
const DEFAULT_INVENTORY_AUDIT_SCOPE = INVENTORY_AUDIT_LOCATIONS.slice(0, 2).map(
  (location) => location.label
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
  const parts = new Intl.DateTimeFormat("ko-KR", {
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

function compareAuditDevices(left: DeviceListRow, right: DeviceListRow) {
  return (
    String(left.model || "").localeCompare(String(right.model || ""), "ko-KR", {
      numeric: true,
      sensitivity: "base",
    }) ||
    String(left.saleGrade || "").localeCompare(String(right.saleGrade || ""), "ko-KR", {
      numeric: true,
      sensitivity: "base",
    }) ||
    Number(left.modelSeq ?? Number.MAX_SAFE_INTEGER) -
      Number(right.modelSeq ?? Number.MAX_SAFE_INTEGER) ||
    left.pgNo.localeCompare(right.pgNo, "ko-KR", {
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
    React.useState<InventoryAuditLocation>(INVENTORY_AUDIT_LOCATIONS[0].label);
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
  const [message, setMessage] = React.useState("판매 가능 재고의 실사 위치를 확인합니다.");
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
        .sort(compareAuditDevices),
    [devices]
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
    setMessage("판매 가능 재고의 실사 위치를 확인합니다.");
  }, []);

  useUnsavedForm({
    id: INVENTORY_AUDIT_FORM_ID,
    label: "재고 실사",
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
          next.has(item.label)
        ).map((item) => item.label);
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
        next.has(item.label)
      ).map((item) => item.label);
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
      setMessage("스캔할 PG 또는 IMEI를 입력하세요.");
      return;
    }

    const device = sellableDeviceByScanValue.get(scannedValue);

    if (!device) {
      const knownDevice = deviceByScanValue.get(scannedValue);
      setLastScannedPgNo(knownDevice?.pgNo ?? null);
      setMessage(
        knownDevice
          ? `${knownDevice.pgNo}는 판매 가능 재고가 아니므로 실사 대상이 아닙니다.`
          : `${scannedValue}와 일치하는 판매 가능 재고를 찾지 못했습니다.`
      );
      return;
    }

    const currentLocation = getDraftLocation(device);
    setLastScannedPgNo(device.pgNo);
    setScannedPgNos((current) => new Set(current).add(device.pgNo));

    if (currentLocation === selectedLocation) {
      setMessage(`${device.pgNo}는 이미 ${selectedLocation} 상태입니다.`);
      return;
    }

    setLocationOverrides((current) => ({
      ...current,
      [device.pgNo]: selectedLocation,
    }));
    includeLocationInAuditScope(selectedLocation);
    setMessage(`${device.pgNo}를 ${selectedLocation} 위치로 표시했습니다.`);
  }

  function printAuditList() {
    const printedAt = new Intl.DateTimeFormat("ko-KR", {
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
            <h1>재고 실사 목록</h1>
          </div>
          <div class="meta">
            <div>실사 기준일 ${escapePrintHtml(auditBaseDate)}</div>
            <div>출력일시 ${escapePrintHtml(printedAt)}</div>
            <div>출력 대상 ${sellableDevices.length.toLocaleString()}건</div>
            <div>판매 가능 재고 ${sellableDevices.length.toLocaleString()}건</div>
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
              <th>순번</th>
              <th>PG</th>
              <th>고유번호</th>
              <th>모델</th>
              <th>판매등급</th>
              <th>포장 완료</th>
              <th>포장 대기</th>
              <th>상품화 대기</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows ||
              `<tr><td colspan="8" class="number-cell">출력할 판매 가능 재고가 없습니다.</td></tr>`
            }
          </tbody>
          <tfoot>
            <tr>
              <td colspan="8" class="footer-cell">
                <section class="sign-row">
                  <div class="sign-box">실사 담당자</div>
                  <div class="sign-box">확인자</div>
                  <div class="sign-box">비고</div>
                </section>
              </td>
            </tr>
          </tfoot>
        </table>
      </main>
    `;

    void printHtmlDocument({
      title: "재고 실사 목록",
      html: buildPrintHtmlDocument({
        title: "재고 실사 목록",
        styles: inventoryAuditPrintStyles,
        body,
      }),
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }

  async function saveAuditResult() {
    if (isSaving) {
      return;
    }

    if (scopedUnassignedDevices.length > 0) {
      setShowOnlyUnassigned(true);
      setMessage(
        `선택한 실사 범위 안에서 위치가 비워진 재고가 ${scopedUnassignedDevices.length.toLocaleString()}건 있습니다. 해당 기기를 확인한 뒤 위치를 등록하세요.`
      );
      focusScanInput();
      return;
    }

    if (scopedChangedItems.length === 0) {
      setMessage("선택한 실사 범위에 저장할 변경사항이 없습니다.");
      return;
    }

    if (!auditBaseDate) {
      setMessage("실사 기준일을 입력하세요.");
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
        throw new Error(payload?.message || "재고 실사 결과를 저장하지 못했습니다.");
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
      setMessage(payload.message || "재고 실사 결과를 저장했습니다.");

      try {
        await deviceList.reload();
      } catch {
        setPostWriteRefreshWarning(POST_WRITE_REFRESH_WARNING);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
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
        label: "고유번호",
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
        label: "모델",
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
        label: "판매등급",
        width: "110px",
        cellClassName: auditTableCellClassName,
        text: (device) => device.saleGrade ?? "",
        render: (device) => <SaleGradeBadge value={device.saleGrade} />,
      },
      {
        key: "location",
        label: "위치",
        width: "140px",
        cellClassName: auditTableCellClassName,
        text: (device) => getDraftLocation(device),
        render: (device) => {
          const location = getDraftLocation(device);

          return (
            <Badge variant={location ? "success" : "warning"}>
              {location || "미지정"}
            </Badge>
          );
        },
      },
      ...INVENTORY_AUDIT_LOCATIONS.map((location) => ({
        key: location.key,
        label: location.label,
        width: "120px",
        cellClassName: auditCheckboxCellClassName,
        sortable: false,
        filterable: false,
        render: (device: DeviceListRow) => (
          <TableSelectCheckbox
            checked={getDraftLocation(device) === location.label}
            ariaLabel={`${device.pgNo} ${location.label}`}
            onCheckedChange={(checked) =>
              setDeviceLocation(device.pgNo, location.label, checked)
            }
          />
        ),
      })),
    ],
    [getDraftLocation, setDeviceLocation]
  );

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <SummaryStrip className="grid-cols-2 xl:grid-cols-5">
        <SummaryCard icon={PackageCheck} label="판매 가능 재고" value={summary.total} />
        <SummaryCard icon={ClipboardCheck} label="포장 완료" value={summary.packed} />
        <SummaryCard
          icon={ClipboardCheck}
          label="포장 대기"
          value={summary.packingWaiting}
        />
        <SummaryCard
          icon={ClipboardCheck}
          label="상품화 대기"
          value={summary.productWaiting}
        />
        <SummaryCard icon={RefreshCcw} label="미지정" value={summary.unassigned} />
      </SummaryStrip>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-popover">
        <div className="grid shrink-0 gap-2 border-b p-3 xl:grid-cols-[auto_380px_minmax(0,1fr)_auto] xl:items-end">
          <div className="flex flex-wrap items-center gap-2">
            {INVENTORY_AUDIT_LOCATIONS.map((location) => (
              <Button
                key={location.key}
                type="button"
                variant={
                  selectedLocation === location.label ? "default" : "outline"
                }
                onClick={() => selectAuditLocation(location.label)}
              >
                {location.label}
              </Button>
            ))}
          </div>
          <form
            className="min-w-[260px] max-w-[380px] xl:w-[380px]"
            onSubmit={handleScanSubmit}
          >
            <Input
              ref={scanInputRef}
              aria-label="재고 실사 스캔"
              autoComplete="off"
              data-lpignore="true"
              inputMode="text"
              placeholder="PG 또는 IMEI 스캔"
              value={scanValue}
              onChange={(event) => setScanValue(event.target.value)}
            />
          </form>
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">
              이번 실사 범위
            </span>
            {INVENTORY_AUDIT_LOCATIONS.map((location) => (
              <label
                key={location.key}
                className="flex items-center gap-1.5 text-sm"
              >
                <TableSelectCheckbox
                  checked={auditScopeSet.has(location.label)}
                  ariaLabel={`${location.label} 실사 범위 포함`}
                  onCheckedChange={(checked) =>
                    toggleAuditScopeLocation(location.label, checked)
                  }
                />
                <span>{location.label}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end justify-end gap-2">
            <label className="grid w-[160px] gap-1 text-xs font-medium text-muted-foreground">
              실사 기준일
              <Input
                type="date"
                value={auditBaseDate}
                onChange={(event) => setAuditBaseDate(event.target.value)}
              />
            </label>
            <Button type="button" variant="outline" onClick={printAuditList}>
              <Printer className="size-4" />
              실사 목록 출력
            </Button>
            <Button
              type="button"
              disabled={isSaving}
              onClick={() => void saveAuditResult()}
            >
              <Save className="size-4" />
              실사 결과 저장
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
            재고 실사 대상을 불러오는 중입니다.
          </FeedbackBanner>
        ) : null}

        <div
          className={cn(
            "shrink-0 border-b px-4 py-2 text-sm",
            message.includes("못했습니다") || message.includes("없습니다")
              ? "text-amber-700"
              : "text-muted-foreground"
          )}
        >
          {message}
          {scopedChangedItems.length > 0 ? (
            <span className="ml-2 font-medium text-primary">
              저장 대상 {scopedChangedItems.length.toLocaleString()}건
            </span>
          ) : null}
          {changedItems.length > scopedChangedItems.length ? (
            <span className="ml-2 font-medium text-muted-foreground">
              범위 밖 변경 {(
                changedItems.length - scopedChangedItems.length
              ).toLocaleString()}건
            </span>
          ) : null}
          {scannedPgNos.size > 0 ? (
            <span className="ml-2 font-medium text-sky-700">
              스캔 {scannedPgNos.size.toLocaleString()}건
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
              {showOnlyUnassigned ? "전체 보기" : "미지정만 보기"}
            </Button>
          ) : null}
        </div>

        <VirtualizedDataGrid
          rows={displayedDevices}
          columns={columns}
          rowKey={(device) => device.pgNo}
          emptyMessage={
            showOnlyUnassigned
              ? "위치가 등록되지 않은 판매 가능 재고가 없습니다."
              : "판매 가능 재고가 없습니다."
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
