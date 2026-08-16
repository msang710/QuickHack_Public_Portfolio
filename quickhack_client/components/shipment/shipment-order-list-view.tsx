"use client";

import * as React from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Printer,
  RefreshCcw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import {
  useGuardedDialogClose,
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import { TableSelectCheckbox } from "@/quickhack_client/components/ui/table-select-checkbox";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/quickhack_client/components/ui/tabs";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import { statusMap } from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  buildPrintHtmlDocument,
  escapePrintHtml,
  printHtmlDocument,
} from "@/quickhack_client/lib/printing/print-html";
import { renderLogenLabelBitmap } from "@/quickhack_client/printing/logen-label-renderer";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import {
  mutationWakeDeferred,
  type MutationReceipt,
} from "@/quickhack_shared/core/mutation-receipt";
import {
  INVENTORY_STATUS,
  inventoryStatusLabel,
} from "@/quickhack_shared/inventory/inventory-status";
import {
  channelOrderMappingFailureReasonLabel,
  inventoryMatchFailureReasonLabel,
  inventoryMatchStatusLabel,
} from "@/quickhack_shared/sales-channel/order-matching";
import {
  firstShipmentPackageGroupRows,
  shipmentPackageCandidateKey,
  shipmentPackageGroupRows,
} from "@/quickhack_shared/shipment/package-group";
import type { ShipmentPrintBatchStatus } from "@/quickhack_shared/shipment/shipment-print-batch-status";
import type {
  LogenLabelBlocker,
  LogenLabelDto,
} from "@/quickhack_shared/shipment/logen-label";
import {
  isMatchedWarrantyTabKey,
  selectInvoiceIssueBatch,
  type MatchedWarrantyTabKey,
  type ShipmentOutputFocus,
  type ShipmentOutputReturnMenuId,
} from "@/quickhack_client/components/shipment/shipment-output-focus";
import {
  failedLabelSelectionIsDirty,
  normalizeFailedLabelIds,
  printerCalibrationSettingsSnapshotsEqual,
  shipmentLabelConfirmationFormId,
} from "@/quickhack_client/components/shipment/shipment-label-draft-state";

type ShipmentOrderListMode = "all" | "matched";

type ShipmentOrderRow = {
  id: number;
  channel: string;
  externalOrderId: string;
  externalShipmentId: string;
  orderedAt: string | null;
  paidAt: string | null;
  syncedAt: string;
  channelStatus: string | null;
  orderWorkStatus: string;
  shippingWorkStatus: string;
  invoiceStatus: string;
  receiverName: string;
  receiverSafeNumber: string;
  receiverAddress: string;
  externalVendorItemId: string;
  vendorItemName: string | null;
  sellerProductName: string | null;
  sellerProductItemName: string | null;
  externalVendorSkuCode: string | null;
  displayProductName: string;
  displayRequiredOption: string;
  shippingCount: number;
  holdCountForCancel: number;
  cancelCount: number;
  canceled: boolean;
  availableQuantity: number;
  mappingStatus: string;
  salesOfferId: number | null;
  salesOfferCode: string | null;
  requiredStorage: string | null;
  requiredColor: string | null;
  requiredWarrantyGroup: string | null;
  matchingFailureReason: string | null;
  inventoryMatchStatus: string;
  inventoryMatchingFailureReason: string | null;
  inventoryMatchedAt: string | null;
  matchedQuantity: number;
  matchedPgNos: string[];
  matchedPgText: string;
  matchedDevices: ShipmentMatchedDevice[];
  writeReviewRequired?: boolean;
  writeRequestId?: number | null;
};

type ShipmentMatchedDevice = {
  allocationId: number;
  allocationStatus: string;
  pgNo: string;
  model: string;
  modelSeq: number | null;
  storage: string | null;
  color: string | null;
  saleGrade: string | null;
  warranty: string | null;
  inventoryStatus: string | null;
  matchedAt: string | null;
  shipmentListPrintedAt: string | null;
  shipmentListPrintBatchId: number | null;
  shipmentListPrintBatchNo: number | null;
  shipmentListPrintBatchLabel: string | null;
  packageGroupKey: string;
  packageGroupSize: number;
};

type ShipmentOrdersApiResponse = {
  ok: boolean;
  message?: string;
  summary?: {
    orderCount: number;
    orderItemCount: number;
    matchedOrderItemCount: number;
    fullyMatchedOrderItemCount: number;
    matchedDeviceCount: number;
    packageGroupCount?: number;
  };
  items?: ShipmentOrderRow[];
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
};

type ShipmentListPrintApiResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  batchId?: number;
  batchNo?: number;
  batchLabel?: string;
  batchStatus?: ShipmentPrintBatchStatus;
  printedAt?: string;
  printedCount?: number;
  packageGroupCount?: number;
  items?: ShipmentPrintItem[];
  conflicts?: ShipmentReturnConflict[];
};

type ShipmentReturnConflict = {
  returnRawId: number;
  externalReceiptId: string;
  externalOrderId: string;
  externalShipmentId: string | null;
  externalVendorItemIds: string[];
  vendorItemNames: string[];
  cancelCount: number;
  receiptStatus: string | null;
  releaseStatus: string | null;
  allocationIds: number[];
  pgNos: string[];
  scopeIncomplete: boolean;
};

type ShipmentPrintItem = {
  allocationId: number;
  batchId: number | null;
  batchNo: number | null;
  batchLabel: string;
  printLineNo: number | null;
  printedAt: string;
  orderedAt: string | null;
  pgNo: string;
  uniqueNo: string;
  warranty: string;
  saleGrade: string;
  model: string;
  storage: string | null;
  color: string | null;
  receiverName: string;
  receiverAddress: string;
  allocationStatus: string;
  inventoryStatus: string | null;
  returnExcluded: boolean;
  exclusionReason: string | null;
  packageGroupId: number | null;
  packageGroupKey: string;
  packageGroupSize: number;
  packageGroupMemberSequence: number | null;
};

type ShipmentPrintBatch = {
  batchId: number;
  batchNo: number;
  batchLabel: string;
  tabKey: string;
  tabLabel: string;
  batchStatus: ShipmentPrintBatchStatus;
  printedAt: string;
  printDialogClosedAt: string | null;
  confirmedAt: string | null;
  canceledAt: string | null;
  itemCount: number;
  packageGroupCount: number;
  effectiveItemCount: number;
  returnExcludedCount: number;
  items: ShipmentPrintItem[];
};

type ShipmentPrintBatchesApiResponse = {
  ok: boolean;
  message?: string;
  batches?: ShipmentPrintBatch[];
  focusBatchFound?: boolean;
};

type ShipmentPrintBatchActionResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  batch?: ShipmentPrintBatch;
  conflicts?: ShipmentReturnConflict[];
  details?: {
    currentStatus?: ShipmentPrintBatchStatus;
    requestedStatus?: ShipmentPrintBatchStatus;
  };
};

type CarrierInvoiceIssueItem = {
  issueItemId: number;
  packageGroupId: number;
  issueSequence: number;
  status: string;
  trackingNumber: string | null;
  packageGroupStatus: string;
  carrierRegistration: {
    workId: number;
    status: string;
    errorCode?: string | null;
    errorMessage?: string | null;
  } | null;
};

type CarrierInvoiceIssueBatch = {
  issueBatchId: number;
  shipmentListPrintBatchId: number;
  issueType: string;
  status: string;
  requestedPackageGroupCount: number;
  allocatedPackageGroupCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  reviewRequiredAt: string | null;
  items: CarrierInvoiceIssueItem[];
};

type CarrierInvoiceIssueResponse = {
  ok: boolean;
  message?: string;
  issueBatch?: CarrierInvoiceIssueBatch;
  issueBatches?: CarrierInvoiceIssueBatch[];
  receipt?: MutationReceipt<unknown>;
};

type LabelPrintItem = {
  issueItemId: number;
  issueSequence: number;
  packageGroupId: number;
  trackingNumber: string | null;
  printStatus: string;
  printCount: number;
};

type LabelPrintView = {
  issueBatchId: number;
  labelPrintStatus: string;
  activeRequestKey: string | null;
  printAttemptCount: number;
  payloadHash: string | null;
  printerName: string | null;
  ready: boolean;
  blockers: LogenLabelBlocker[];
  labels: LogenLabelDto[];
  targetIssueItemIds: number[];
  items: LabelPrintItem[];
};

type LabelPrintApiResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  blockers?: LogenLabelBlocker[];
  labelPrint?: LabelPrintView & {
    requestKey?: string;
    payloadHash?: string | null;
  };
};

type LocalPrinter = {
  name: string;
  isDefault: boolean;
  isOffline: boolean;
  status: string;
};

type PrinterSettings = {
  printerName: string;
  sensorType: "GAP" | "BLINE";
  gapMm: number;
  gapOffsetMm: number;
  direction: 0 | 1;
  referenceX: number;
  referenceY: number;
  shiftX: number;
  shiftY: number;
  speed: number;
  density: number;
};

function defaultPrinterSettings(printerName: string): PrinterSettings {
  return {
    printerName,
    sensorType: "GAP",
    gapMm: 3,
    gapOffsetMm: 0,
    direction: 1,
    referenceX: 0,
    referenceY: 0,
    shiftX: 0,
    shiftY: 0,
    speed: 3,
    density: 8,
  };
}

type PrintersApiResponse = {
  ok: boolean;
  message?: string;
  printers?: LocalPrinter[];
  settings?: PrinterSettings;
};

type LocalPrintJob = {
  requestKey: string;
  payloadHash: string;
  printerName: string;
  status: "SPOOLED" | "FAILED" | "UNKNOWN";
  labelCount: number;
  errorCode: string | null;
  errorMessage: string | null;
};

type LocalPrintApiResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  job?: LocalPrintJob | null;
};

class ReturnProcessingRequiredClientError extends Error {
  constructor(
    message: string,
    readonly conflicts: ShipmentReturnConflict[]
  ) {
    super(message);
    this.name = "ReturnProcessingRequiredClientError";
  }
}

class ShipmentPrintBatchStateConflictClientError extends Error {
  constructor(
    message: string,
    readonly currentStatus: ShipmentPrintBatchStatus | null
  ) {
    super(message);
    this.name = "ShipmentPrintBatchStateConflictClientError";
  }
}

const SHIPMENT_PRINT_BATCH_REFRESH_CONFLICT_CODES = new Set([
  "SHIPMENT_PRINT_BATCH_STATE_CONFLICT",
  "SHIPMENT_PRINT_BATCH_SNAPSHOT_INVALID",
  "SHIPMENT_PACKAGE_GROUP_STATE_CONFLICT",
  "INVENTORY_STATE_CONFLICT",
  "INVENTORY_STATE_CONCURRENT_CHANGE",
]);

type ShipmentOrderColumnKey =
  | "inventoryMatchStatus"
  | "inventoryStatus"
  | "matchedPg"
  | "uniqueNo"
  | "externalOrderId"
  | "product"
  | "quantity"
  | "receiverName"
  | "receiverAddress";

type MatchedShipmentRow = {
  id: string;
  allocationId: number;
  allocationStatus: string;
  shipmentListPrintedAt: string | null;
  shipmentListPrintBatchId: number | null;
  shipmentListPrintBatchNo: number | null;
  shipmentListPrintBatchLabel: string | null;
  printLineNo: number | null;
  orderedAt: string | null;
  pgNo: string;
  uniqueNo: string;
  warranty: string;
  saleGrade: string;
  model: string;
  storage: string;
  color: string;
  inventoryStatus: string | null;
  receiverName: string;
  receiverAddress: string;
  packageGroupId: number | null;
  packageGroupKey: string;
  packageGroupSize: number;
  packageGroupMemberSequence: number | null;
};

type MatchedShipmentColumnKey =
  | "select"
  | "packageGroup"
  | "pg"
  | "uniqueNo"
  | "warranty"
  | "saleGrade"
  | "model"
  | "storage"
  | "color"
  | "receiverName"
  | "receiverAddress";

type MatchedWarrantyTab = {
  key: MatchedWarrantyTabKey;
  label: string;
  warrantyKeyword: "2년" | "1년";
  source: "coupang" | "external";
};

const MATCHED_WARRANTY_TABS: MatchedWarrantyTab[] = [
  {
    key: "coupang-2y",
    label: "2년 보증",
    warrantyKeyword: "2년",
    source: "coupang",
  },
  {
    key: "coupang-1y",
    label: "1년 보증",
    warrantyKeyword: "1년",
    source: "coupang",
  },
  {
    key: "external-2y",
    label: "2년 보증(쿠팡 외)",
    warrantyKeyword: "2년",
    source: "external",
  },
  {
    key: "external-1y",
    label: "1년 보증(쿠팡 외)",
    warrantyKeyword: "1년",
    source: "external",
  },
];

const PRINT_READY_ALLOCATION_STATUSES = new Set(["API_ACKED"]);

const MODE_LABELS: Record<ShipmentOrderListMode, string> = {
  all: "\uC804\uCCB4 \uC8FC\uBB38 \uAC74",
  matched: "\uB9E4\uCE6D \uC644\uB8CC",
};
const SHIPMENT_LIST_SELECT_LIMIT = 30;

const PRINT_BATCH_STATUS_LABELS: Record<ShipmentPrintBatchStatus, string> = {
  PENDING: "출력 대기",
  PRINT_DIALOG_CLOSED: "확인 대기",
  CONFIRMED: "확정",
  CANCELED: "차수 폐기",
};

function isActivePrintBatchStatus(status: ShipmentPrintBatchStatus) {
  return status !== "CANCELED";
}

function canFinalizePrintBatch(status: ShipmentPrintBatchStatus) {
  return status !== "CONFIRMED" && status !== "CANCELED";
}

function printBatchStatusVariant(status: ShipmentPrintBatchStatus) {
  if (status === "CONFIRMED") {
    return "success" as const;
  }

  if (status === "CANCELED") {
    return "neutral" as const;
  }

  return "warning" as const;
}

function statusVariant(value: string) {
  if (["MAPPED", "MATCHED"].includes(value)) {
    return "success" as const;
  }

  if (["PARTIAL", "PARTIAL_MATCHED"].includes(value)) {
    return "warning" as const;
  }

  if (["FAILED", "MATCH_FAILED"].includes(value)) {
    return "danger" as const;
  }

  return "neutral" as const;
}

function inventoryMatchStatusText(row: ShipmentOrderRow) {
  return [
    inventoryMatchStatusLabel(row.inventoryMatchStatus),
    inventoryMatchReasonText(row),
  ]
    .filter(Boolean)
    .join(" ");
}

function inventoryMatchReasonText(row: ShipmentOrderRow) {
  const inventoryReason = inventoryMatchFailureReasonLabel(
    row.inventoryMatchingFailureReason
  );

  if (inventoryReason) {
    return inventoryReason;
  }

  const mappingReason = channelOrderMappingFailureReasonLabel(
    row.matchingFailureReason
  );

  if (mappingReason) {
    return mappingReason;
  }

  if (row.mappingStatus !== "MAPPED" || !row.salesOfferId) {
    return "SKU 매핑 없음";
  }

  return "";
}

function quantityText(row: ShipmentOrderRow) {
  return `${row.availableQuantity}/${row.shippingCount}`;
}

function productText(row: ShipmentOrderRow) {
  return [
    row.displayProductName,
    row.sellerProductName,
    row.displayRequiredOption,
  ]
    .filter(Boolean)
    .join(" ");
}

function textOrDash(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return text || "-";
}

function lineText(values: Array<string | number | null | undefined>) {
  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function matchedPgLineText(row: ShipmentOrderRow) {
  return lineText(row.matchedPgNos);
}

function matchedUniqueNoLineText(row: ShipmentOrderRow) {
  return lineText(
    row.matchedDevices
      .map((device) => formatModelSeqLabel(device.model, device.modelSeq))
      .filter((value) => value !== "-")
  );
}

function matchedInventoryStatusLineText(row: ShipmentOrderRow) {
  return lineText(
    row.matchedDevices
      .map((device) => inventoryStatusLabel(device.inventoryStatus))
      .filter((value) => value !== "-")
  );
}

function InventoryStatusBadgeList({ row }: { row: ShipmentOrderRow }) {
  const statuses = row.matchedDevices
    .map((device) => String(device.inventoryStatus ?? "").trim())
    .filter(Boolean);

  if (statuses.length === 0) {
    return <span>-</span>;
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1 leading-4">
      {statuses.map((status, index) => {
        const mapped = statusMap[status];
        const label = mapped?.label ?? inventoryStatusLabel(status);

        return (
          <Badge
            key={`${status}:${index}`}
            variant={mapped?.tone ?? "neutral"}
            className="max-w-full truncate"
          >
            {label}
          </Badge>
        );
      })}
    </div>
  );
}

function LineList({ value }: { value: string }) {
  const lines = value.split("\n").filter(Boolean);

  if (lines.length === 0) {
    return <span>-</span>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-0.5 leading-4">
      {lines.map((line, index) => (
        <div key={`${line}:${index}`} className="truncate">
          {line}
        </div>
      ))}
    </div>
  );
}

function toMatchedShipmentRows(rows: ShipmentOrderRow[]): MatchedShipmentRow[] {
  return rows.flatMap((row) =>
    row.matchedDevices.map((device, index) => ({
      id: `${row.id}:${device.pgNo}:${device.allocationId}:${index}`,
      allocationId: device.allocationId,
      allocationStatus: device.allocationStatus,
      shipmentListPrintedAt: device.shipmentListPrintedAt,
      shipmentListPrintBatchId: device.shipmentListPrintBatchId,
      shipmentListPrintBatchNo: device.shipmentListPrintBatchNo,
      shipmentListPrintBatchLabel: device.shipmentListPrintBatchLabel,
      printLineNo: null,
      orderedAt: row.orderedAt,
      pgNo: device.pgNo,
      uniqueNo: formatModelSeqLabel(device.model, device.modelSeq),
      warranty: textOrDash(device.warranty),
      saleGrade: textOrDash(device.saleGrade),
      model: textOrDash(device.model),
      storage: textOrDash(device.storage),
      color: textOrDash(device.color),
      inventoryStatus: device.inventoryStatus,
      receiverName: textOrDash(row.receiverName),
      receiverAddress: textOrDash(row.receiverAddress),
      packageGroupId: null,
      packageGroupKey:
        device.packageGroupKey ||
        shipmentPackageCandidateKey({
          receiverName: row.receiverName,
          receiverAddress: row.receiverAddress,
          fallbackKey: `allocation:${device.allocationId}`,
        }),
      packageGroupSize: device.packageGroupSize || 1,
      packageGroupMemberSequence: null,
    }))
  );
}

function hasWarrantyKeyword(row: MatchedShipmentRow, keyword: "2년" | "1년") {
  const warranty = row.warranty.replace(/\s+/g, "").toUpperCase();
  const keywordText = keyword.replace(/\s+/g, "");

  if (warranty.includes(keywordText)) {
    return true;
  }

  return keyword === "2년" ? warranty === "2Y" : warranty === "1Y";
}

function isPrintReadyAllocationStatus(status: string) {
  return PRINT_READY_ALLOCATION_STATUSES.has(status);
}

function compareNullableText(left: string | null, right: string | null) {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();

  if (!leftText && !rightText) {
    return 0;
  }

  if (!leftText) {
    return 1;
  }

  if (!rightText) {
    return -1;
  }

  return leftText.localeCompare(rightText);
}

function matchedShipmentGroupKey(row: MatchedShipmentRow) {
  return (
    row.packageGroupKey ||
    shipmentPackageCandidateKey({
      receiverName: row.receiverName,
      receiverAddress: row.receiverAddress,
      fallbackKey: `allocation:${row.allocationId}`,
    })
  );
}

function sortMatchedShipmentRowsByOrderedAt(rows: MatchedShipmentRow[]) {
  const groupOrder = new Map<
    string,
    {
      firstAllocationId: number;
      firstOrderedAt: string | null;
    }
  >();

  for (const row of rows) {
    const groupKey = matchedShipmentGroupKey(row);
    const current = groupOrder.get(groupKey);

    if (
      !current ||
      compareNullableText(row.orderedAt, current.firstOrderedAt) < 0 ||
      (compareNullableText(row.orderedAt, current.firstOrderedAt) === 0 &&
        row.allocationId < current.firstAllocationId)
    ) {
      groupOrder.set(groupKey, {
        firstAllocationId: row.allocationId,
        firstOrderedAt: row.orderedAt,
      });
    }
  }

  return [...rows].sort((left, right) => {
    const leftGroupKey = matchedShipmentGroupKey(left);
    const rightGroupKey = matchedShipmentGroupKey(right);
    const leftGroup = groupOrder.get(leftGroupKey);
    const rightGroup = groupOrder.get(rightGroupKey);
    const groupOrderResult = compareNullableText(
      leftGroup?.firstOrderedAt ?? null,
      rightGroup?.firstOrderedAt ?? null
    );

    if (groupOrderResult !== 0) {
      return groupOrderResult;
    }

    if (leftGroupKey !== rightGroupKey) {
      return (leftGroup?.firstAllocationId ?? left.allocationId) -
        (rightGroup?.firstAllocationId ?? right.allocationId);
    }

    const orderedAtResult = compareNullableText(left.orderedAt, right.orderedAt);

    if (orderedAtResult !== 0) {
      return orderedAtResult;
    }

    return left.allocationId - right.allocationId;
  });
}

function printItemToMatchedRow(item: ShipmentPrintItem): MatchedShipmentRow {
  return {
    id: `print:${item.batchId ?? "none"}:${item.allocationId}`,
    allocationId: item.allocationId,
    allocationStatus: item.allocationStatus,
    shipmentListPrintedAt: item.printedAt || null,
    shipmentListPrintBatchId: item.batchId,
    shipmentListPrintBatchNo: item.batchNo,
    shipmentListPrintBatchLabel: item.batchLabel,
    printLineNo: item.printLineNo,
    orderedAt: item.orderedAt,
    pgNo: item.pgNo,
    uniqueNo: textOrDash(item.uniqueNo),
    warranty: textOrDash(item.warranty),
    saleGrade: textOrDash(item.saleGrade),
    model: textOrDash(item.model),
    storage: textOrDash(item.storage),
    color: textOrDash(item.color),
    inventoryStatus: item.inventoryStatus,
    receiverName: textOrDash(item.receiverName),
    receiverAddress: textOrDash(item.receiverAddress),
    packageGroupId: item.packageGroupId,
    packageGroupKey: item.packageGroupKey,
    packageGroupSize: item.packageGroupSize,
    packageGroupMemberSequence: item.packageGroupMemberSequence,
  };
}

function formatPrintDateTime(value: string) {
  return value.replace("T", " ").slice(0, 19);
}

function buildShipmentListPrintHtml({
  rows,
  printedAt,
  tabLabel,
  batchLabel,
}: {
  rows: MatchedShipmentRow[];
  printedAt: string;
  tabLabel: string;
  batchLabel: string;
}) {
  const bodyRows = rows
    .map(
      (row, index) => `
        <tr>
          <td class="number-cell"><span>${row.printLineNo ?? index + 1}</span></td>
          <td class="mono-cell"><span>${escapePrintHtml(row.pgNo)}</span></td>
          <td class="mono-cell"><span>${escapePrintHtml(row.uniqueNo)}</span></td>
          <td><span>${escapePrintHtml(row.warranty)}</span></td>
          <td><span>${escapePrintHtml(row.saleGrade)}</span></td>
          <td><span>${escapePrintHtml(row.model)}</span></td>
          <td><span>${escapePrintHtml(row.storage)}</span></td>
          <td><span>${escapePrintHtml(row.color)}</span></td>
          <td><span>${escapePrintHtml(row.receiverName)}</span></td>
          <td class="address-cell"><span>${escapePrintHtml(row.receiverAddress)}</span></td>
        </tr>`
    )
    .join("");

  return buildPrintHtmlDocument({
    title: "출고 목록",
    styles: `
      @page { size: A4 landscape; margin: 8mm; }
      * { box-sizing: border-box; }
      body {
        color: #111827;
        font-family: "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
        font-size: 9pt;
        margin: 0;
      }
      .print-page { width: 100%; }
      .print-header {
        align-items: flex-end;
        border-bottom: 2px solid #111827;
        display: flex;
        justify-content: space-between;
        margin-bottom: 5mm;
        padding-bottom: 3mm;
      }
      h1 { font-size: 17pt; line-height: 1.15; margin: 0; }
      .print-header > div:first-child > div { font-size: 10pt; margin-top: 1mm; }
      .meta { color: #4b5563; font-size: 8.5pt; line-height: 1.45; text-align: right; }
      table {
        border-collapse: collapse;
        table-layout: fixed;
        width: 100%;
      }
      col.no { width: 7mm; }
      col.pg { width: 23mm; }
      col.unique { width: 20mm; }
      col.warranty { width: 16mm; }
      col.grade { width: 16mm; }
      col.model { width: 28mm; }
      col.storage { width: 13mm; }
      col.color { width: 18mm; }
      col.receiver { width: 17mm; }
      col.address { width: auto; }
      thead { display: table-header-group; }
      tr {
        height: 5.35mm;
        page-break-inside: avoid;
      }
      th, td {
        border: 1px solid #9ca3af;
        line-height: 1.15;
        overflow: hidden;
        padding: 0.7mm 1mm;
        text-align: left;
        vertical-align: middle;
      }
      th {
        background: #e5e7eb;
        font-size: 8.6pt;
        font-weight: 700;
        height: 6mm;
        white-space: nowrap;
      }
      td > span {
        display: block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .number-cell { text-align: right; }
      .mono-cell { font-family: Consolas, "Malgun Gothic", monospace; }
      .address-cell { font-size: 8.3pt; }
    `,
    body: `
      <main class="print-page">
        <header class="print-header">
          <div>
            <h1>출고 목록</h1>
            <div>${escapePrintHtml(batchLabel || tabLabel)}</div>
          </div>
          <div class="meta">
            <div>출력일시 ${escapePrintHtml(formatPrintDateTime(printedAt))}</div>
            <div>출력 대상 ${rows.length.toLocaleString("ko-KR")}건</div>
          </div>
        </header>
        <table>
          <colgroup>
            <col class="no" />
            <col class="pg" />
            <col class="unique" />
            <col class="warranty" />
            <col class="grade" />
            <col class="model" />
            <col class="storage" />
            <col class="color" />
            <col class="receiver" />
            <col class="address" />
          </colgroup>
          <thead>
            <tr>
              <th>No</th>
              <th>PG</th>
              <th>고유번호</th>
              <th>보증서</th>
              <th>판매등급</th>
              <th>기종</th>
              <th>용량</th>
              <th>색상</th>
              <th>수신인</th>
              <th>주소</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </main>
    `,
  });
}

function shipmentPrintBatchRows(batch: ShipmentPrintBatch) {
  return batch.items
    .filter((item) => !item.returnExcluded)
    .map(printItemToMatchedRow);
}

export function ShipmentOrderListView({
  mode,
  focusedOutput,
  onFocusedOutputConsumed,
  onReturnFromFocusedOutput,
  onOpenPreShipmentReturns,
  onOpenWriteReview,
}: {
  mode: ShipmentOrderListMode;
  focusedOutput?: ShipmentOutputFocus | null;
  onFocusedOutputConsumed?: () => void;
  onReturnFromFocusedOutput?: (
    returnMenuId: ShipmentOutputReturnMenuId
  ) => void;
  onOpenPreShipmentReturns?: () => void;
  onOpenWriteReview?: (requestId: number) => void;
}) {
  const [rows, setRows] = React.useState<ShipmentOrderRow[]>([]);
  const [summary, setSummary] =
    React.useState<ShipmentOrdersApiResponse["summary"]>(undefined);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [isPrintBatchLoading, setIsPrintBatchLoading] = React.useState(false);
  const [isPrinting, setIsPrinting] = React.useState(false);
  const [isReprinting, setIsReprinting] = React.useState(false);
  const [isPrintBatchUpdating, setIsPrintBatchUpdating] = React.useState(false);
  const [isInvoiceWorkflowLoading, setIsInvoiceWorkflowLoading] =
    React.useState(false);
  const [isLabelPrinting, setIsLabelPrinting] = React.useState(false);
  const [isPrinterLoading, setIsPrinterLoading] = React.useState(false);
  const [isPrinterSaving, setIsPrinterSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [returnConflictMessage, setReturnConflictMessage] = React.useState("");
  const [returnConflicts, setReturnConflicts] = React.useState<
    ShipmentReturnConflict[]
  >([]);
  const [printConfirmationBatch, setPrintConfirmationBatch] =
    React.useState<ShipmentPrintBatch | null>(null);
  const [selectedMatchedTab, setSelectedMatchedTab] =
    React.useState<MatchedWarrantyTabKey>(
      focusedOutput && isMatchedWarrantyTabKey(focusedOutput.tabKey)
        ? focusedOutput.tabKey
        : "coupang-2y"
    );
  const [selectedPrintBatchKey, setSelectedPrintBatchKey] =
    React.useState("current");
  const [printBatches, setPrintBatches] = React.useState<ShipmentPrintBatch[]>([]);
  const [activeOutputFocus, setActiveOutputFocus] =
    React.useState<ShipmentOutputFocus | null>(focusedOutput ?? null);
  const [pendingOutputFocus, setPendingOutputFocus] =
    React.useState<ShipmentOutputFocus | null>(focusedOutput ?? null);
  const [outputFocusError, setOutputFocusError] = React.useState("");
  const [invoiceIssueBatch, setInvoiceIssueBatch] =
    React.useState<CarrierInvoiceIssueBatch | null>(null);
  const [labelPrint, setLabelPrint] = React.useState<LabelPrintView | null>(null);
  const [printers, setPrinters] = React.useState<LocalPrinter[]>([]);
  const [printerSettings, setPrinterSettings] =
    React.useState<PrinterSettings | null>(null);
  const [persistedPrinterSettings, setPersistedPrinterSettings] =
    React.useState<PrinterSettings | null>(null);
  const [labelConfirmationOpen, setLabelConfirmationOpen] =
    React.useState(false);
  const [failedLabelIds, setFailedLabelIds] = React.useState<number[]>([]);
  const { runGuardedAction } = useUnsavedChanges();
  const printerCalibrationDirty =
    !printerCalibrationSettingsSnapshotsEqual(
      persistedPrinterSettings,
      printerSettings
    );
  const labelConfirmationFormId = shipmentLabelConfirmationFormId(
    invoiceIssueBatch?.issueBatchId
  );
  const closeLabelConfirmation = React.useCallback(() => {
    setFailedLabelIds([]);
    setLabelConfirmationOpen(false);
  }, []);
  const labelConfirmationFormIds = React.useMemo(
    () => [labelConfirmationFormId],
    [labelConfirmationFormId]
  );
  const requestLabelConfirmationClose = useGuardedDialogClose({
    formIds: labelConfirmationFormIds,
    targetLabel: "송장 실물 출력 확인",
    onClose: closeLabelConfirmation,
  });

  useUnsavedForm({
    id: "shipment.printer-calibration",
    label: "TSC DA200 송장 출력 교정 설정",
    enabled: Boolean(
      persistedPrinterSettings || printerSettings || isPrinterSaving
    ),
    isDirty: printerCalibrationDirty,
    isBusy: isPrinterSaving,
    discard: () => setPrinterSettings(persistedPrinterSettings),
  });

  useUnsavedForm({
    id: labelConfirmationFormId,
    label: invoiceIssueBatch
      ? `송장 출력 작업 #${invoiceIssueBatch.issueBatchId} 실패 선택`
      : "송장 출력 실패 선택",
    enabled: Boolean(labelConfirmationOpen && invoiceIssueBatch),
    isDirty: failedLabelSelectionIsDirty(failedLabelIds),
    isBusy: isLabelPrinting,
    discard: closeLabelConfirmation,
  });
  const [selectedAllocationIdsByTab, setSelectedAllocationIdsByTab] = React.useState<
    Record<MatchedWarrantyTabKey, number[]>
  >({
    "coupang-2y": [],
    "coupang-1y": [],
    "external-2y": [],
    "external-1y": [],
  });

  React.useEffect(() => {
    if (
      mode !== "matched" ||
      !focusedOutput ||
      !isMatchedWarrantyTabKey(focusedOutput.tabKey)
    ) {
      return;
    }

    const timerId = window.setTimeout(() => {
      setActiveOutputFocus(focusedOutput);
      setPendingOutputFocus(focusedOutput);
      setOutputFocusError("");
      setSelectedMatchedTab(focusedOutput.tabKey);
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [focusedOutput, mode]);

  const loadRows = React.useCallback(async (
    cursor: string | null = null,
    append = false
  ) => {
    if (append) setIsLoadingMore(true);
    else setIsLoading(true);
    setMessage("");

    try {
      const params = new URLSearchParams({ mode, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/coupang/orders?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | ShipmentOrdersApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "주문 목록을 불러오지 못했습니다.");
      }

      const nextRows = payload.items ?? [];
      setRows((current) => {
        if (!append) return nextRows;
        const byId = new Map(current.map((row) => [row.id, row]));
        for (const row of nextRows) byId.set(row.id, row);
        return [...byId.values()];
      });
      setSummary(payload.summary);
      setNextCursor(payload.hasMore ? payload.nextCursor ?? null : null);
    } catch (error) {
      if (!append) {
        setRows([]);
        setSummary(undefined);
        setNextCursor(null);
      }
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (append) setIsLoadingMore(false);
      else setIsLoading(false);
    }
  }, [mode]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadRows();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadRows]);

  const matchedRows = React.useMemo(() => toMatchedShipmentRows(rows), [rows]);
  const selectedMatchedTabInfo =
    MATCHED_WARRANTY_TABS.find((tab) => tab.key === selectedMatchedTab) ??
    MATCHED_WARRANTY_TABS[0];
  const activePrintBatchAllocationIds = React.useMemo(() => {
    const ids = new Set<number>();

    for (const batch of printBatches) {
      if (!isActivePrintBatchStatus(batch.batchStatus)) {
        continue;
      }

      for (const item of batch.items) {
        ids.add(item.allocationId);
      }
    }

    return ids;
  }, [printBatches]);
  const allCurrentRows = React.useMemo(
    () => {
      const candidates = matchedRows.filter(
        (row) =>
          !row.shipmentListPrintBatchId &&
          !row.shipmentListPrintedAt &&
          row.inventoryStatus === INVENTORY_STATUS.reserved &&
          isPrintReadyAllocationStatus(row.allocationStatus) &&
          !activePrintBatchAllocationIds.has(row.allocationId)
      );
      const packageGroups = shipmentPackageGroupRows(
        candidates,
        matchedShipmentGroupKey
      );

      return sortMatchedShipmentRowsByOrderedAt(
        candidates.map((row) => ({
          ...row,
          packageGroupSize:
            packageGroups.get(matchedShipmentGroupKey(row))?.length ?? 1,
        }))
      );
    },
    [activePrintBatchAllocationIds, matchedRows]
  );
  const currentRowsByTab = React.useMemo<
    Record<MatchedWarrantyTabKey, MatchedShipmentRow[]>
  >(
    () => ({
      "coupang-2y": allCurrentRows.filter((row) =>
        hasWarrantyKeyword(row, "2년")
      ),
      "coupang-1y": allCurrentRows.filter((row) =>
        hasWarrantyKeyword(row, "1년")
      ),
      "external-2y": [],
      "external-1y": [],
    }),
    [allCurrentRows]
  );
  const selectedCurrentRows = React.useMemo(
    () => currentRowsByTab[selectedMatchedTab] ?? [],
    [currentRowsByTab, selectedMatchedTab]
  );
  const selectedPrintBatch = React.useMemo(
    () =>
      printBatches.find(
        (batch) => String(batch.batchId) === selectedPrintBatchKey
      ),
    [printBatches, selectedPrintBatchKey]
  );
  const selectedCurrentAllocationIds = React.useMemo(
    () => new Set(selectedAllocationIdsByTab[selectedMatchedTab] ?? []),
    [selectedMatchedTab, selectedAllocationIdsByTab]
  );
  const selectedVisibleRows = React.useMemo(
    () =>
      selectedPrintBatch
        ? selectedPrintBatch.items.map(printItemToMatchedRow)
        : selectedCurrentRows,
    [selectedCurrentRows, selectedPrintBatch]
  );
  const selectedCurrentRowsForPrint = React.useMemo(
    () =>
      allCurrentRows.filter((row) =>
        selectedCurrentAllocationIds.has(row.allocationId)
      ),
    [allCurrentRows, selectedCurrentAllocationIds]
  );
  const selectedCurrentPackageGroupCount = React.useMemo(
    () =>
      shipmentPackageGroupRows(
        selectedCurrentRowsForPrint,
        matchedShipmentGroupKey
      ).size,
    [selectedCurrentRowsForPrint]
  );
  const selectedPrintBatchStatus = selectedPrintBatch?.batchStatus ?? null;
  const canConfirmPrintBatch =
    selectedPrintBatchStatus
      ? canFinalizePrintBatch(selectedPrintBatchStatus) &&
        !isPrintBatchUpdating &&
        !isPrinting
      : false;
  const canCancelPrintBatch =
    selectedPrintBatchStatus
      ? canFinalizePrintBatch(selectedPrintBatchStatus) &&
        !isPrintBatchUpdating &&
        !isPrinting
      : false;
  const canPrintShipmentList =
    mode === "matched" &&
    selectedMatchedTabInfo.source === "coupang" &&
    (selectedPrintBatch
      ? selectedPrintBatch.effectiveItemCount > 0
      : selectedPrintBatchKey === "current" &&
        selectedCurrentRowsForPrint.length > 0) &&
    !isLoading &&
    !isPrintBatchUpdating &&
    !isPrinting &&
    !isReprinting;
  const shipmentListPrintButtonLabel = selectedPrintBatch
    ? "출고 목록 재출력"
    : "출고 목록 출력";

  const loadPrintBatches = React.useCallback(async () => {
    if (mode !== "matched" || selectedMatchedTabInfo.source !== "coupang") {
      setPrintBatches([]);
      if (
        pendingOutputFocus &&
        pendingOutputFocus.tabKey === selectedMatchedTab
      ) {
        setSelectedPrintBatchKey("current");
        setOutputFocusError(
          "재발급 송장 출력은 쿠팡 매칭 완료 탭에서만 열 수 있습니다."
        );
        setPendingOutputFocus(null);
        onFocusedOutputConsumed?.();
      }
      return;
    }

    setIsPrintBatchLoading(true);

    try {
      const params = new URLSearchParams({
        mode: "batches",
        tabKey: selectedMatchedTab,
        limit: "100",
      });
      if (
        activeOutputFocus &&
        activeOutputFocus.tabKey === selectedMatchedTab
      ) {
        params.set(
          "focusBatchId",
          String(activeOutputFocus.shipmentListPrintBatchId)
        );
      }
      const response = await fetch(
        `/api/coupang/shipment-list-print?${params.toString()}`,
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as
        | ShipmentPrintBatchesApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "출력 차수 목록을 불러오지 못했습니다.");
      }

      const nextBatches = payload.batches ?? [];
      setPrintBatches(nextBatches);
      if (
        pendingOutputFocus &&
        pendingOutputFocus.tabKey === selectedMatchedTab
      ) {
        const targetKey = String(
          pendingOutputFocus.shipmentListPrintBatchId
        );
        const targetFound =
          payload.focusBatchFound !== false &&
          nextBatches.some((batch) => String(batch.batchId) === targetKey);
        if (targetFound) {
          setSelectedPrintBatchKey(targetKey);
          setOutputFocusError("");
        } else {
          setSelectedPrintBatchKey("current");
          setOutputFocusError(
            `${pendingOutputFocus.batchLabel}을 찾지 못했습니다. 차수가 폐기됐거나 현재 계정에서 조회할 수 없습니다.`
          );
        }
        setPendingOutputFocus(null);
        onFocusedOutputConsumed?.();
      } else {
        setSelectedPrintBatchKey((current) =>
          current === "current" ||
          nextBatches.some((batch) => String(batch.batchId) === current)
            ? current
            : "current"
        );
      }
    } catch (error) {
      setPrintBatches([]);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      setMessage(errorMessage);
      if (
        pendingOutputFocus &&
        pendingOutputFocus.tabKey === selectedMatchedTab
      ) {
        setSelectedPrintBatchKey("current");
        setOutputFocusError(errorMessage);
        setPendingOutputFocus(null);
        onFocusedOutputConsumed?.();
      }
    } finally {
      setIsPrintBatchLoading(false);
    }
  }, [
    activeOutputFocus,
    mode,
    onFocusedOutputConsumed,
    pendingOutputFocus,
    selectedMatchedTab,
    selectedMatchedTabInfo.source,
  ]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadPrintBatches();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadPrintBatches]);

  const loadPrinters = React.useCallback(async () => {
    setIsPrinterLoading(true);
    try {
      const response = await fetch("/api/client/printers", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | PrintersApiResponse
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(
          payload?.message || "Windows 프린터 목록을 불러오지 못했습니다."
        );
      }
      setPrinters(payload.printers ?? []);
      setPrinterSettings(payload.settings ?? null);
      setPersistedPrinterSettings(payload.settings ?? null);
    } catch (error) {
      setPrinters([]);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPrinterLoading(false);
    }
  }, []);

  const loadInvoiceWorkflow = React.useCallback(
    async (
      shipmentListPrintBatchId: number,
      quiet = false,
      preferredIssueBatchId?: number | null
    ) => {
      if (!quiet) setIsInvoiceWorkflowLoading(true);
      try {
        const response = await fetch(
          `/api/invoices/issue-batches?shipmentListPrintBatchId=${shipmentListPrintBatchId}`,
          { cache: "no-store" }
        );
        const payload = (await response.json().catch(() => null)) as
          | CarrierInvoiceIssueResponse
          | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(
            payload?.message || "송장 처리 상태를 불러오지 못했습니다."
          );
        }
        const issueBatches = payload.issueBatches ?? [];
        const issueBatch = selectInvoiceIssueBatch(
          issueBatches,
          preferredIssueBatchId
        );
        if (preferredIssueBatchId && !issueBatch) {
          throw new Error(
            `재발급 송장 작업 #${preferredIssueBatchId}을 출력 차수에서 찾지 못했습니다.`
          );
        }
        setInvoiceIssueBatch(issueBatch);
        if (!issueBatch) {
          setLabelPrint(null);
          return null;
        }

        const labelResponse = await fetch(
          `/api/invoices/issue-batches/${issueBatch.issueBatchId}/label-print`,
          { cache: "no-store" }
        );
        const labelPayload = (await labelResponse.json().catch(() => null)) as
          | LabelPrintApiResponse
          | null;
        if (!labelResponse.ok || !labelPayload?.ok || !labelPayload.labelPrint) {
          throw new Error(
            labelPayload?.message || "송장 출력 상태를 불러오지 못했습니다."
          );
        }
        setLabelPrint(labelPayload.labelPrint);
        if (labelPayload.labelPrint.labelPrintStatus === "SPOOLED") {
          setLabelConfirmationOpen(true);
        }
        return issueBatch;
      } catch (error) {
        if (!quiet) {
          setMessage(error instanceof Error ? error.message : String(error));
        }
        return null;
      } finally {
        if (!quiet) setIsInvoiceWorkflowLoading(false);
      }
    },
    []
  );

  const startInvoiceWorkflow = React.useCallback(
    async (shipmentListPrintBatchId: number) => {
      setIsInvoiceWorkflowLoading(true);
      try {
        const response = await fetch("/api/invoices/issue-batches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shipmentListPrintBatchId }),
        });
        const payload = (await response.json().catch(() => null)) as
          | CarrierInvoiceIssueResponse
          | null;
        if (!payload?.issueBatch) {
          throw new Error(
            payload?.message || "송장 채번 작업을 시작하지 못했습니다."
          );
        }
        setInvoiceIssueBatch(payload.issueBatch);
        await loadInvoiceWorkflow(shipmentListPrintBatchId, true);
        if (mutationWakeDeferred(payload.receipt)) {
          setMessage(
            "송장 작업은 저장되었습니다. 백그라운드 후속 작업은 다음 실행 주기에 계속됩니다."
          );
        }
        if (!response.ok && response.status !== 202) {
          throw new Error(
            payload.message || "송장 처리 과정에서 오류가 발생했습니다."
          );
        }
        return payload.issueBatch;
      } finally {
        setIsInvoiceWorkflowLoading(false);
      }
    },
    [loadInvoiceWorkflow]
  );

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      setInvoiceIssueBatch(null);
      setLabelPrint(null);
      setFailedLabelIds([]);
      setLabelConfirmationOpen(false);
      if (selectedPrintBatch?.batchStatus === "CONFIRMED") {
        const preferredIssueBatchId =
          activeOutputFocus?.shipmentListPrintBatchId ===
          selectedPrintBatch.batchId
            ? activeOutputFocus.issueBatchId
            : null;
        void loadInvoiceWorkflow(
          selectedPrintBatch.batchId,
          false,
          preferredIssueBatchId
        ).then((issueBatch) => {
          if (preferredIssueBatchId && !issueBatch) {
            setOutputFocusError(
              `재발급 송장 작업 #${preferredIssueBatchId}을 출력 차수에서 찾지 못했습니다.`
            );
          } else if (preferredIssueBatchId) {
            setOutputFocusError("");
          }
        });
      }
    }, 0);
    return () => window.clearTimeout(timerId);
  }, [activeOutputFocus, loadInvoiceWorkflow, selectedPrintBatch]);

  React.useEffect(() => {
    if (
      !selectedPrintBatch ||
      !invoiceIssueBatch ||
      labelPrint?.labelPrintStatus === "CONFIRMED" ||
      labelPrint?.labelPrintStatus === "UNKNOWN"
    ) {
      return;
    }
    const timerId = window.setInterval(() => {
      void loadInvoiceWorkflow(
        selectedPrintBatch.batchId,
        true,
        invoiceIssueBatch.issueBatchId
      );
    }, 2500);
    return () => window.clearInterval(timerId);
  }, [
    invoiceIssueBatch,
    labelPrint?.labelPrintStatus,
    loadInvoiceWorkflow,
    selectedPrintBatch,
  ]);

  React.useEffect(() => {
    if (
      selectedPrintBatch?.batchStatus !== "CONFIRMED" ||
      printers.length > 0 ||
      isPrinterLoading
    ) {
      return;
    }
    const timerId = window.setTimeout(() => {
      void loadPrinters();
    }, 0);
    return () => window.clearTimeout(timerId);
  }, [
    isPrinterLoading,
    loadPrinters,
    printers.length,
    selectedPrintBatch?.batchStatus,
  ]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      setSelectedAllocationIdsByTab((current) => {
        let changed = false;
        const next = { ...current };

        for (const tab of MATCHED_WARRANTY_TABS) {
          const availableIds = new Set(
            (tab.source === "coupang" ? allCurrentRows : []).map(
              (row) => row.allocationId
            )
          );
          const filteredIds = (current[tab.key] ?? []).filter((id) =>
            availableIds.has(id)
          );

          if (filteredIds.length !== (current[tab.key] ?? []).length) {
            next[tab.key] = filteredIds;
            changed = true;
          }
        }

        return changed ? next : current;
      });
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [allCurrentRows]);

  const toggleMatchedRowSelection = React.useCallback(
    (allocationId: number, checked: boolean) => {
      const selectedRow = allCurrentRows.find(
        (row) => row.allocationId === allocationId
      );

      if (!selectedRow) return;

      const packageGroupAllocationIds = (
        shipmentPackageGroupRows(allCurrentRows, matchedShipmentGroupKey).get(
          matchedShipmentGroupKey(selectedRow)
        ) ?? []
      ).map((row) => row.allocationId);

      setSelectedAllocationIdsByTab((current) => {
        const currentIds = current[selectedMatchedTab] ?? [];
        const nextIds = checked
          ? Array.from(new Set([...currentIds, ...packageGroupAllocationIds]))
          : currentIds.filter(
              (id) => !packageGroupAllocationIds.includes(id)
            );

        return {
          ...current,
          [selectedMatchedTab]: nextIds,
        };
      });
    },
    [allCurrentRows, selectedMatchedTab]
  );

  const toggleTopMatchedRows = React.useCallback(
    (displayRows: MatchedShipmentRow[], checked: boolean) => {
      const topGroupRows = firstShipmentPackageGroupRows(
        displayRows,
        matchedShipmentGroupKey,
        SHIPMENT_LIST_SELECT_LIMIT
      );
      const topGroupKeys = new Set(
        topGroupRows.map(matchedShipmentGroupKey)
      );
      const packageGroupAllocationIds = allCurrentRows
        .filter((row) => topGroupKeys.has(matchedShipmentGroupKey(row)))
        .map((row) => row.allocationId);

      setSelectedAllocationIdsByTab((current) => ({
        ...current,
        [selectedMatchedTab]: checked
          ? packageGroupAllocationIds
          : [],
      }));
    },
    [allCurrentRows, selectedMatchedTab]
  );

  const updatePrintBatch = React.useCallback(
    async (batchId: number, action: "dialogClosed" | "confirm" | "cancel") => {
      const response = await fetch("/api/coupang/shipment-list-print", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batchId,
          action,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | ShipmentPrintBatchActionResponse
        | null;

      if (!response.ok || !payload?.ok) {
        if (
          response.status === 409 &&
          payload?.code === "RETURN_PROCESSING_REQUIRED" &&
          payload.conflicts
        ) {
          throw new ReturnProcessingRequiredClientError(
            payload.message || "반품 처리가 필요한 주문이 포함되어 있습니다.",
            payload.conflicts
          );
        }

        if (
          response.status === 409 &&
          payload?.code &&
          SHIPMENT_PRINT_BATCH_REFRESH_CONFLICT_CODES.has(payload.code)
        ) {
          throw new ShipmentPrintBatchStateConflictClientError(
            payload.message ||
              "출고 출력 차수 상태가 변경되었습니다. 최신 상태를 다시 불러옵니다.",
            payload.details?.currentStatus ?? null
          );
        }

        throw new Error(payload?.message || "출력 차수 상태를 바꾸지 못했습니다.");
      }

      if (!payload.batch) {
        throw new Error("출력 차수 정보를 받지 못했습니다.");
      }

      return payload.batch;
    },
    []
  );

  const printShipmentBatchDocument = React.useCallback(
    async (batch: ShipmentPrintBatch) => {
      await printHtmlDocument({
        title: "출고 목록",
        html: buildShipmentListPrintHtml({
          rows: shipmentPrintBatchRows(batch),
          printedAt: batch.printedAt,
          tabLabel: batch.tabLabel,
          batchLabel: batch.batchLabel,
        }),
      });
    },
    []
  );

  const printShipmentList = React.useCallback(async () => {
    if (selectedMatchedTabInfo.source !== "coupang") {
      setMessage("쿠팡 외 플랫폼은 아직 출고 목록 출력을 지원하지 않습니다.");
      return;
    }

    if (selectedCurrentRowsForPrint.length === 0) {
      setMessage("출력할 출고 목록을 체크해주세요.");
      return;
    }

    setIsPrinting(true);
    setMessage("");
    setReturnConflictMessage("");
    setReturnConflicts([]);

    try {
      const response = await fetch("/api/coupang/shipment-list-print", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tabKey: selectedMatchedTab,
          allocationIds: selectedCurrentRowsForPrint.map(
            (row) => row.allocationId
          ),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | ShipmentListPrintApiResponse
        | null;

      if (
        response.status === 409 &&
        payload?.code === "RETURN_PROCESSING_REQUIRED" &&
        payload.conflicts
      ) {
        throw new ReturnProcessingRequiredClientError(
          payload.message || "반품 처리가 필요한 주문이 포함되어 있습니다.",
          payload.conflicts
        );
      }

      if (!response.ok || !payload?.ok || !payload.printedAt || !payload.batchId) {
        throw new Error(payload?.message || "출고 목록 출력 시각을 기록하지 못했습니다.");
      }

      const printRows =
        payload.items && payload.items.length > 0
          ? payload.items.map(printItemToMatchedRow)
          : selectedCurrentRowsForPrint;

      await printHtmlDocument({
        title: "출고 목록",
        html: buildShipmentListPrintHtml({
          rows: printRows,
          printedAt: payload.printedAt,
          tabLabel: selectedMatchedTabInfo.label,
          batchLabel: payload.batchLabel ?? selectedMatchedTabInfo.label,
        }),
      });

      const updatedBatch = await updatePrintBatch(payload.batchId, "dialogClosed");

      setMessage(
        `${updatedBatch.batchLabel} 합포장 ${payload.packageGroupCount ?? updatedBatch.packageGroupCount}박스 · PG ${payload.printedCount ?? printRows.length}대를 출력했습니다. 출력물 확인을 완료해주세요.`
      );
      setSelectedAllocationIdsByTab((current) => ({
        ...current,
        [selectedMatchedTab]: [],
      }));
      setPrintConfirmationBatch(updatedBatch);
      setSelectedPrintBatchKey(String(updatedBatch.batchId));
      await loadPrintBatches();
      await loadRows();
    } catch (error) {
      if (error instanceof ReturnProcessingRequiredClientError) {
        setReturnConflictMessage(error.message);
        setReturnConflicts(error.conflicts);
        return;
      }

      if (error instanceof ShipmentPrintBatchStateConflictClientError) {
        setPrintConfirmationBatch(null);
        await Promise.all([loadPrintBatches(), loadRows()]);
        setMessage(error.message);
        return;
      }

      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPrinting(false);
    }
  }, [
    loadPrintBatches,
    loadRows,
    selectedCurrentRowsForPrint,
    selectedMatchedTab,
    selectedMatchedTabInfo,
    updatePrintBatch,
  ]);

  const confirmPrintBatch = React.useCallback(async (batchToConfirm: ShipmentPrintBatch) => {
    setIsPrintBatchUpdating(true);
    setMessage("");

    try {
      const batch = await updatePrintBatch(batchToConfirm.batchId, "confirm");
      let invoiceMessage = " 송장 채번과 채널 등록을 시작했습니다.";
      try {
        await startInvoiceWorkflow(batch.batchId);
      } catch (error) {
        invoiceMessage = ` 송장 처리는 시작하지 못했습니다: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      setMessage(
        `${batch.batchLabel}을 출력 완료로 확정했습니다.${invoiceMessage}${
          batch.returnExcludedCount > 0
            ? ` 반품 ${batch.returnExcludedCount.toLocaleString("ko-KR")}대는 상태 변경에서 제외했습니다.`
            : ""
        }`
      );
      setPrintConfirmationBatch((current) =>
        current?.batchId === batchToConfirm.batchId ? null : current
      );
      setSelectedPrintBatchKey(String(batch.batchId));
      await loadPrintBatches();
      await loadRows();
    } catch (error) {
      if (error instanceof ReturnProcessingRequiredClientError) {
        setReturnConflictMessage(error.message);
        setReturnConflicts(error.conflicts);
        return;
      }

      if (error instanceof ShipmentPrintBatchStateConflictClientError) {
        setPrintConfirmationBatch(null);
        await Promise.all([loadPrintBatches(), loadRows()]);
        setMessage(error.message);
        return;
      }

      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPrintBatchUpdating(false);
    }
  }, [
    loadPrintBatches,
    loadRows,
    startInvoiceWorkflow,
    updatePrintBatch,
  ]);

  const confirmSelectedPrintBatch = React.useCallback(async () => {
    if (!selectedPrintBatch) {
      return;
    }

    await confirmPrintBatch(selectedPrintBatch);
  }, [confirmPrintBatch, selectedPrintBatch]);

  const persistPrinterSettings = React.useCallback(
    async (nextSettings: PrinterSettings) => {
      setIsPrinterSaving(true);
      try {
        const response = await fetch("/api/client/printer-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nextSettings),
        });
        const payload = (await response.json().catch(() => null)) as
          | { ok: boolean; message?: string; settings?: PrinterSettings }
          | null;
        if (!response.ok || !payload?.ok || !payload.settings) {
          throw new Error(
            payload?.message || "프린터 설정을 저장하지 못했습니다."
          );
        }
        setPrinterSettings(payload.settings);
        setPersistedPrinterSettings(payload.settings);
        return payload.settings;
      } finally {
        setIsPrinterSaving(false);
      }
    },
    []
  );

  const requestPrinterChange = React.useCallback(
    (printerName: string) => {
      runGuardedAction({
        intent: "internal-change",
        formIds: ["shipment.printer-calibration"],
        targetLabel: "다른 송장 프린터",
        action: () => {
          const nextSettings = {
            ...(persistedPrinterSettings ??
              printerSettings ??
              defaultPrinterSettings(printerName)),
            printerName,
          };
          setPrinterSettings(nextSettings);
          void persistPrinterSettings(nextSettings).catch((error) =>
            setMessage(error instanceof Error ? error.message : String(error))
          );
        },
      });
    },
    [
      persistedPrinterSettings,
      persistPrinterSettings,
      printerSettings,
      runGuardedAction,
    ]
  );

  const requestLoadPrinters = React.useCallback(() => {
    runGuardedAction({
      intent: "internal-change",
      formIds: ["shipment.printer-calibration"],
      targetLabel: "프린터 목록 새로고침",
      action: () => void loadPrinters(),
    });
  }, [loadPrinters, runGuardedAction]);

  const requestMatchedTabChange = React.useCallback(
    (nextTab: MatchedWarrantyTabKey) => {
      if (nextTab === selectedMatchedTab) return;
      runGuardedAction({
        intent: "internal-change",
        formIds: [labelConfirmationFormId],
        targetLabel: "다른 매칭 완료 탭",
        action: () => setSelectedMatchedTab(nextTab),
      });
    },
    [labelConfirmationFormId, runGuardedAction, selectedMatchedTab]
  );

  const requestPrintBatchChange = React.useCallback(
    (nextBatchKey: string) => {
      if (nextBatchKey === selectedPrintBatchKey) return;
      runGuardedAction({
        intent: "internal-change",
        formIds: [labelConfirmationFormId],
        targetLabel: "다른 송장 출력 차수",
        action: () => setSelectedPrintBatchKey(nextBatchKey),
      });
    },
    [labelConfirmationFormId, runGuardedAction, selectedPrintBatchKey]
  );

  const requestRetryOutputFocus = React.useCallback(() => {
    if (!activeOutputFocus) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: [labelConfirmationFormId],
      targetLabel: "재발급 송장 출력 대상 다시 찾기",
      action: () => {
        setOutputFocusError("");
        setPendingOutputFocus(activeOutputFocus);
        setSelectedMatchedTab(activeOutputFocus.tabKey);
      },
    });
  }, [activeOutputFocus, labelConfirmationFormId, runGuardedAction]);

  const savePrinterCalibration = React.useCallback(async () => {
    if (!printerSettings) return;
    try {
      await persistPrinterSettings(printerSettings);
      setMessage("프린터 교정값을 저장했습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [persistPrinterSettings, printerSettings]);

  const printCalibration = React.useCallback(async () => {
    const printerName = printerSettings?.printerName.trim();
    if (!printerName) {
      setMessage("먼저 TSC DA200 Windows 프린터를 선택하세요.");
      return;
    }
    setIsLabelPrinting(true);
    try {
      const response = await fetch("/api/client/printer-calibration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printerName }),
      });
      const payload = (await response.json().catch(() => null)) as
        | LocalPrintApiResponse
        | null;
      if (!payload?.job || payload.job.status !== "SPOOLED") {
        throw new Error(
          payload?.job?.errorMessage ||
            payload?.message ||
            "송장 출력 교정본을 인쇄 대기열에 전달하지 못했습니다."
        );
      }
      setMessage(
        "송장 출력 교정본을 전송했습니다. 간격과 원점이 맞는지 출력물을 확인하세요."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLabelPrinting(false);
    }
  }, [printerSettings?.printerName]);

  const updateCentralLabelPrint = React.useCallback(
    async (
      issueBatchId: number,
      action: "SPOOLED" | "CONFIRM" | "FAILED" | "UNKNOWN",
      requestKey: string,
      payloadHash: string,
      expectedPrintAttemptCount: number,
      extra?: Record<string, unknown>
    ) => {
      const response = await fetch(
        `/api/invoices/issue-batches/${issueBatchId}/label-print`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            requestKey,
            payloadHash,
            expectedPrintAttemptCount,
            ...extra,
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | LabelPrintApiResponse
        | null;
      if (!response.ok || !payload?.ok || !payload.labelPrint) {
        if (response.status === 409) {
          const latestResponse = await fetch(
            `/api/invoices/issue-batches/${issueBatchId}/label-print`,
            { cache: "no-store" }
          );
          const latestPayload = (await latestResponse.json().catch(() => null)) as
            | LabelPrintApiResponse
            | null;
          if (latestResponse.ok && latestPayload?.ok && latestPayload.labelPrint) {
            setLabelPrint(latestPayload.labelPrint);
            setFailedLabelIds([]);
            setLabelConfirmationOpen(
              latestPayload.labelPrint.labelPrintStatus === "SPOOLED"
            );
          }
        }
        throw new Error(
          payload?.message || "중앙 서버에 송장 출력 결과를 반영하지 못했습니다."
        );
      }
      setLabelPrint(payload.labelPrint);
      return payload.labelPrint;
    },
    []
  );

  const acknowledgeLocalLabelPrint = React.useCallback(
    async (
      requestKey: string,
      resolution: "CONFIRMED" | "PRINTED" | "NOT_PRINTED"
    ) => {
      const response = await fetch(
        `/api/client/label-print/${encodeURIComponent(requestKey)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolution }),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | LocalPrintApiResponse
        | null;
      if (!response.ok || !payload?.ok || !payload.job) {
        throw new Error(
          payload?.message || "로컬 출력 확인 기록을 저장하지 못했습니다."
        );
      }
      return payload.job;
    },
    []
  );

  const resolveUnknownLabelPrint = React.useCallback(
    async (printed: boolean) => {
      if (!invoiceIssueBatch || !labelPrint) return;
      const requestKey = labelPrint.activeRequestKey;
      const confirmed = window.confirm(
        printed
          ? "관리자 판정으로 이 작업의 송장이 실제 출력되었다고 확정합니다. 같은 송장을 다시 출력하지 않습니다. 계속할까요?"
          : "관리자 판정으로 이 작업의 송장이 출력되지 않았다고 확정합니다. 동일 송장번호 복구 출력 대상으로 되돌릴까요?"
      );
      if (!confirmed) return;

      setIsLabelPrinting(true);
      try {
        const response = await fetch(
          `/api/invoices/issue-batches/${invoiceIssueBatch.issueBatchId}/label-print`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: printed ? "RESOLVE_PRINTED" : "RESOLVE_NOT_PRINTED",
              expectedPrintAttemptCount: labelPrint.printAttemptCount,
            }),
          }
        );
        const payload = (await response.json().catch(() => null)) as
          | LabelPrintApiResponse
          | null;
        if (!response.ok || !payload?.ok || !payload.labelPrint) {
          throw new Error(
            payload?.message || "불명확한 출력 결과를 판정하지 못했습니다."
          );
        }
        setLabelPrint(payload.labelPrint);
        let localWarning = "";
        try {
          if (!requestKey) {
            throw new Error("Legacy UNKNOWN has no local request identity.");
          }
          await acknowledgeLocalLabelPrint(
            requestKey,
            printed ? "PRINTED" : "NOT_PRINTED"
          );
        } catch {
          localWarning =
            " 로컬 확인 기록은 저장되지 않아 관련 파일을 자동 삭제하지 않습니다.";
        }
        setMessage((
          printed
            ? "관리자 판정으로 실물 출력 완료를 확정했습니다."
            : "관리자 판정으로 출력되지 않음을 확정하고 복구 출력 대상으로 되돌렸습니다."
        ) + localWarning);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setIsLabelPrinting(false);
      }
    },
    [acknowledgeLocalLabelPrint, invoiceIssueBatch, labelPrint]
  );

  const printLogenLabels = React.useCallback(async () => {
    if (!invoiceIssueBatch || !labelPrint?.ready) {
      setMessage("아직 송장을 출력할 수 없습니다.");
      return;
    }
    const printerName = printerSettings?.printerName.trim();
    if (!printerName) {
      setMessage("먼저 TSC DA200 Windows 프린터를 선택하세요.");
      return;
    }

    setIsLabelPrinting(true);
    setMessage("");
    let activeRequest:
      | {
          requestKey: string;
          payloadHash: string;
          printAttemptCount: number;
          labels: LogenLabelDto[];
        }
      | undefined;
    try {
      const startResponse = await fetch(
        `/api/invoices/issue-batches/${invoiceIssueBatch.issueBatchId}/label-print`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ printerName }),
        }
      );
      const startPayload = (await startResponse.json().catch(() => null)) as
        | LabelPrintApiResponse
        | null;
      const start = startPayload?.labelPrint;
      const requestKey = start?.requestKey || start?.activeRequestKey;
      const payloadHash = start?.payloadHash;
      const printAttemptCount = Number(start?.printAttemptCount);
      if (
        !startResponse.ok ||
        !startPayload?.ok ||
        !start ||
        !requestKey ||
        !payloadHash ||
        !Number.isSafeInteger(printAttemptCount) ||
        printAttemptCount <= 0
      ) {
        throw new Error(
          startPayload?.message || "송장 출력 요청을 준비하지 못했습니다."
        );
      }
      activeRequest = {
        requestKey,
        payloadHash,
        printAttemptCount,
        labels: start.labels,
      };
      setLabelPrint(start);
      const rendered = start.labels.map(renderLogenLabelBitmap);
      const localResponse = await fetch("/api/client/label-print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestKey,
          payloadHash,
          printerName,
          labels: rendered.map((label) => ({
            issueItemId: label.issueItemId,
            issueSequence: label.issueSequence,
            trackingNumber: label.trackingNumber,
            bitmapBase64: label.bitmapBase64,
          })),
        }),
      });
      const localPayload = (await localResponse.json().catch(() => null)) as
        | LocalPrintApiResponse
        | null;
      const job = localPayload?.job;
      if (job?.status === "SPOOLED") {
        const view = await updateCentralLabelPrint(
          invoiceIssueBatch.issueBatchId,
          "SPOOLED",
          requestKey,
          payloadHash,
          printAttemptCount
        );
        setFailedLabelIds([]);
        setLabelConfirmationOpen(true);
        setMessage(
          `${view.items.filter((item) => item.printStatus === "SPOOLED").length}장 전송을 완료했습니다. 실물 출력 결과를 확인하세요.`
        );
        return;
      }
      const uncertain = job?.status === "UNKNOWN";
      await updateCentralLabelPrint(
        invoiceIssueBatch.issueBatchId,
        uncertain ? "UNKNOWN" : "FAILED",
        requestKey,
        payloadHash,
        printAttemptCount,
        {
          errorCode: job?.errorCode || localPayload?.code,
          errorMessage: job?.errorMessage || localPayload?.message,
        }
      );
      throw new Error(
        job?.errorMessage ||
          localPayload?.message ||
          "송장 출력에 실패했습니다."
      );
    } catch (error) {
      if (activeRequest) {
        try {
          const localResultResponse = await fetch(
            `/api/client/label-print/${encodeURIComponent(
              activeRequest.requestKey
            )}`,
            { cache: "no-store" }
          );
          const localResult = (await localResultResponse
            .json()
            .catch(() => null)) as LocalPrintApiResponse | null;
          if (localResult?.job) {
            const action =
              localResult.job.status === "SPOOLED"
                ? "SPOOLED"
                : localResult.job.status === "UNKNOWN"
                  ? "UNKNOWN"
                  : "FAILED";
            const view = await updateCentralLabelPrint(
              invoiceIssueBatch.issueBatchId,
              action,
              activeRequest.requestKey,
              activeRequest.payloadHash,
              activeRequest.printAttemptCount,
              {
                errorCode: localResult.job.errorCode,
                errorMessage: localResult.job.errorMessage,
              }
            );
            if (view.labelPrintStatus === "SPOOLED") {
              setLabelConfirmationOpen(true);
            }
          } else {
            await updateCentralLabelPrint(
              invoiceIssueBatch.issueBatchId,
              "UNKNOWN",
              activeRequest.requestKey,
              activeRequest.payloadHash,
              activeRequest.printAttemptCount,
              {
                errorCode: "LOCAL_RESULT_UNAVAILABLE",
                errorMessage:
                  "로컬 출력 결과를 확인하지 못해 자동 재출력을 차단했습니다.",
              }
            );
          }
        } catch {
          // The active request remains visible for manual reconciliation.
        }
      }
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLabelPrinting(false);
    }
  }, [
    invoiceIssueBatch,
    labelPrint?.ready,
    printerSettings?.printerName,
    updateCentralLabelPrint,
  ]);

  const confirmPhysicalLabels = React.useCallback(async () => {
    if (
      !invoiceIssueBatch ||
      !labelPrint?.activeRequestKey ||
      !labelPrint.payloadHash
    ) {
      return;
    }
    setIsLabelPrinting(true);
    try {
      const requestKey = labelPrint.activeRequestKey;
      const view = await updateCentralLabelPrint(
        invoiceIssueBatch.issueBatchId,
        "CONFIRM",
        labelPrint.activeRequestKey,
        labelPrint.payloadHash,
        labelPrint.printAttemptCount,
        { failedIssueItemIds: normalizeFailedLabelIds(failedLabelIds) }
      );
      let localWarning = "";
      try {
        await acknowledgeLocalLabelPrint(requestKey, "CONFIRMED");
      } catch {
        localWarning =
          " 로컬 확인 기록은 저장되지 않아 관련 파일을 자동 삭제하지 않습니다.";
      }
      closeLabelConfirmation();
      setMessage(
        view.labelPrintStatus === "CONFIRMED"
          ? `모든 송장의 실물 출력을 확인했습니다.${localWarning}`
          : `출력에 실패한 송장 ${failedLabelIds.length}장을 복구 출력 대상으로 남겼습니다.${localWarning}`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLabelPrinting(false);
    }
  }, [
    failedLabelIds,
    invoiceIssueBatch,
    labelPrint,
    acknowledgeLocalLabelPrint,
    closeLabelConfirmation,
    updateCentralLabelPrint,
  ]);

  React.useEffect(() => {
    if (
      !invoiceIssueBatch ||
      !labelPrint?.activeRequestKey ||
      !labelPrint.payloadHash ||
      labelPrint.labelPrintStatus === "SPOOLED"
    ) {
      return;
    }
    let canceled = false;
    const reconcile = async () => {
      try {
        const response = await fetch(
          `/api/client/label-print/${encodeURIComponent(
            labelPrint.activeRequestKey as string
          )}`,
          { cache: "no-store" }
        );
        const payload = (await response.json().catch(() => null)) as
          | LocalPrintApiResponse
          | null;
        if (canceled || !payload?.job) return;
        const action =
          payload.job.status === "SPOOLED"
            ? "SPOOLED"
            : payload.job.status === "UNKNOWN"
              ? "UNKNOWN"
              : "FAILED";
        const view = await updateCentralLabelPrint(
          invoiceIssueBatch.issueBatchId,
          action,
          labelPrint.activeRequestKey as string,
          labelPrint.payloadHash as string,
          labelPrint.printAttemptCount,
          {
            errorCode: payload.job.errorCode,
            errorMessage: payload.job.errorMessage,
          }
        );
        if (!canceled && view.labelPrintStatus === "SPOOLED") {
          setLabelConfirmationOpen(true);
        }
      } catch {
        // Keep the active request visible; never retry a physical side effect blindly.
      }
    };
    void reconcile();
    return () => {
      canceled = true;
    };
  }, [
    invoiceIssueBatch,
    labelPrint?.activeRequestKey,
    labelPrint?.labelPrintStatus,
    labelPrint?.payloadHash,
    labelPrint?.printAttemptCount,
    updateCentralLabelPrint,
  ]);

  const cancelPrintBatch = React.useCallback(async (batchToCancel: ShipmentPrintBatch) => {
    setIsPrintBatchUpdating(true);
    setMessage("");

    try {
      const batch = await updatePrintBatch(batchToCancel.batchId, "cancel");
      setMessage(`${batch.batchLabel}을 폐기했습니다.`);
      setPrintConfirmationBatch((current) =>
        current?.batchId === batchToCancel.batchId ? null : current
      );
      await loadPrintBatches();
      await loadRows();
      setSelectedPrintBatchKey("current");
    } catch (error) {
      if (error instanceof ShipmentPrintBatchStateConflictClientError) {
        setPrintConfirmationBatch(null);
        await Promise.all([loadPrintBatches(), loadRows()]);
        setSelectedPrintBatchKey("current");
        setMessage(error.message);
        return;
      }

      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPrintBatchUpdating(false);
    }
  }, [loadPrintBatches, loadRows, updatePrintBatch]);

  const cancelSelectedPrintBatch = React.useCallback(async () => {
    if (!selectedPrintBatch) {
      return;
    }

    await cancelPrintBatch(selectedPrintBatch);
  }, [cancelPrintBatch, selectedPrintBatch]);

  const reprintShipmentBatch = React.useCallback(
    async (batchToPrint: ShipmentPrintBatch) => {
      setIsReprinting(true);
      setMessage("");

      try {
        await printShipmentBatchDocument(batchToPrint);
        setMessage(`${batchToPrint.batchLabel}을 다시 출력했습니다. 출력물 확인을 완료해주세요.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setIsReprinting(false);
      }
    },
    [printShipmentBatchDocument]
  );

  const handleShipmentListPrint = React.useCallback(async () => {
    if (selectedPrintBatch) {
      await reprintShipmentBatch(selectedPrintBatch);
      return;
    }

    await printShipmentList();
  }, [printShipmentList, reprintShipmentBatch, selectedPrintBatch]);

  const matchedColumns = React.useMemo<
    DataGridColumn<MatchedShipmentColumnKey, MatchedShipmentRow>[]
  >(
    () => [
      {
        key: "select",
        label: "선택",
        width: "109px",
        headerClassName: "justify-center px-2",
        cellClassName: "flex items-center justify-center px-0",
        sortable: false,
        filterable: false,
        headerRender: ({ displayRows }) => {
          const topGroupRows = firstShipmentPackageGroupRows(
            displayRows,
            matchedShipmentGroupKey,
            SHIPMENT_LIST_SELECT_LIMIT
          );
          const allPackageGroups = shipmentPackageGroupRows(
            allCurrentRows,
            matchedShipmentGroupKey
          );
          const selectedTopCount = topGroupRows.filter((row) =>
            (allPackageGroups.get(matchedShipmentGroupKey(row)) ?? []).every(
              (member) =>
                selectedCurrentAllocationIds.has(member.allocationId)
            )
          ).length;
          const disabled =
            Boolean(selectedPrintBatch) || topGroupRows.length === 0;

          return (
            <div className="flex items-center gap-1.5">
              <TableSelectCheckbox
                checked={
                  !disabled &&
                  topGroupRows.length > 0 &&
                  selectedTopCount === topGroupRows.length
                }
                indeterminate={
                  !disabled &&
                  selectedTopCount > 0 &&
                  selectedTopCount < topGroupRows.length
                }
                disabled={disabled}
                ariaLabel={`위에서부터 합포장 그룹 ${SHIPMENT_LIST_SELECT_LIMIT}개 선택`}
                title={`위에서부터 합포장 그룹 ${SHIPMENT_LIST_SELECT_LIMIT}개 선택`}
                onCheckedChange={(checked) =>
                  toggleTopMatchedRows(displayRows, checked)
                }
              />
              <span className="whitespace-nowrap pr-0.5 text-[11px] italic text-muted-foreground">
                #최대 30박스
              </span>
            </div>
          );
        },
        text: () => "",
        render: (row) =>
          selectedPrintBatch && row.allocationStatus === "CANCELED" ? (
            <Badge variant="warning">반품 제외</Badge>
          ) : (
            <TableSelectCheckbox
              checked={
                !selectedPrintBatch &&
                selectedCurrentAllocationIds.has(row.allocationId)
              }
              disabled={Boolean(selectedPrintBatch)}
              ariaLabel={`${row.pgNo} 선택`}
              onCheckedChange={(checked) =>
                toggleMatchedRowSelection(row.allocationId, checked)
              }
            />
          ),
      },
      {
        key: "packageGroup",
        label: "합포장",
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) =>
          row.packageGroupSize > 1
            ? `합포장 ${row.packageGroupSize}대`
            : "단독",
        render: (row) =>
          row.packageGroupSize > 1 ? (
            <Badge variant="secondary">합포장 {row.packageGroupSize}대</Badge>
          ) : (
            <span className="text-muted-foreground">단독</span>
          ),
      },
      {
        key: "pg",
        label: "PG",
        width: "150px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.pgNo,
        render: (row) => <span className="truncate">{row.pgNo}</span>,
      },
      {
        key: "uniqueNo",
        label: "고유번호",
        width: "120px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.uniqueNo,
        render: (row) => <span className="truncate">{row.uniqueNo}</span>,
      },
      {
        key: "warranty",
        label: "보증서",
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.warranty,
        render: (row) => <span className="truncate">{row.warranty}</span>,
      },
      {
        key: "saleGrade",
        label: "판매등급",
        width: "110px",
        cellClassName: "flex items-center px-3",
        text: (row) => row.saleGrade,
        render: (row) =>
          row.saleGrade === "-" ? "-" : <SaleGradeBadge value={row.saleGrade} />,
      },
      {
        key: "model",
        label: "기종",
        width: "minmax(160px,1fr)",
        cellClassName: "flex min-w-0 items-center px-3",
        text: (row) => row.model,
        render: (row) => <span className="truncate">{row.model}</span>,
      },
      {
        key: "storage",
        label: "용량",
        width: "100px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.storage,
        render: (row) => <span className="truncate">{row.storage}</span>,
      },
      {
        key: "color",
        label: "색상",
        width: "120px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.color,
        render: (row) => <span className="truncate">{row.color}</span>,
      },
      {
        key: "receiverName",
        label: "수신인",
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverName,
        render: (row) => <span className="truncate">{row.receiverName}</span>,
      },
      {
        key: "receiverAddress",
        label: "주소",
        width: "minmax(280px,1.5fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverAddress,
        render: (row) => <span className="truncate">{row.receiverAddress}</span>,
      },
    ],
    [
      allCurrentRows,
      selectedCurrentAllocationIds,
      selectedPrintBatch,
      toggleMatchedRowSelection,
      toggleTopMatchedRows,
    ]
  );

  const columns = React.useMemo<
    DataGridColumn<ShipmentOrderColumnKey, ShipmentOrderRow>[]
  >(
    () => [
      {
        key: "inventoryMatchStatus",
        label: "재고 매칭",
        width: "150px",
        cellClassName: "min-w-0 px-3 py-2",
        text: inventoryMatchStatusText,
        render: (row) => {
          const reasonText = inventoryMatchReasonText(row);

          return (
            <div className="min-w-0">
              {row.writeReviewRequired && row.writeRequestId ? (
                <button
                  type="button"
                  className="mb-1 flex max-w-full items-center gap-1 text-xs font-semibold text-red-700 hover:underline"
                  onClick={() => onOpenWriteReview?.(row.writeRequestId!)}
                >
                  <TriangleAlert className="size-3.5 shrink-0" />
                  <span className="truncate">API 확인 필요</span>
                </button>
              ) : null}
              <Badge variant={statusVariant(row.inventoryMatchStatus)}>
                {inventoryMatchStatusLabel(row.inventoryMatchStatus)}
              </Badge>
              {reasonText ? (
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {reasonText}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        key: "inventoryStatus",
        label: "상태",
        width: "140px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: matchedInventoryStatusLineText,
        render: (row) => <InventoryStatusBadgeList row={row} />,
      },
      {
        key: "matchedPg",
        label: "PG",
        width: "170px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: matchedPgLineText,
        render: (row) => <LineList value={matchedPgLineText(row)} />,
      },
      {
        key: "uniqueNo",
        label: "고유번호",
        width: "140px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: matchedUniqueNoLineText,
        render: (row) => <LineList value={matchedUniqueNoLineText(row)} />,
      },
      {
        key: "externalOrderId",
        label: "주문번호",
        width: "170px",
        cellClassName: "flex min-w-0 items-center px-3 font-mono text-xs",
        text: (row) => row.externalOrderId,
        render: (row) => <span className="truncate">{row.externalOrderId}</span>,
      },
      {
        key: "product",
        label: "상품",
        width: "minmax(300px,1.15fr)",
        cellClassName: "min-w-0 px-3 py-2",
        text: productText,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.displayProductName}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.displayRequiredOption || "-"}
            </div>
          </div>
        ),
      },
      {
        key: "quantity",
        label: "수량",
        width: "80px",
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3 tabular-nums",
        text: quantityText,
        sortValue: (row) => row.availableQuantity,
        render: quantityText,
      },
      {
        key: "receiverName",
        label: "수신인",
        width: "110px",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverName,
        render: (row) => <span className="truncate">{row.receiverName || "-"}</span>,
      },
      {
        key: "receiverAddress",
        label: "주소",
        width: "minmax(300px,1fr)",
        cellClassName: "flex min-w-0 items-center px-3 text-xs",
        text: (row) => row.receiverAddress,
        render: (row) => (
          <span className="truncate">{row.receiverAddress || "-"}</span>
        ),
      },
    ],
    [onOpenWriteReview]
  );

  const renderMatchedTabContent = (tab: MatchedWarrantyTab) => {
    if (tab.source === "external") {
      return (
        <div className="grid min-h-0 flex-1 place-items-center px-4 py-10 text-sm text-muted-foreground">
          다른 플랫폼 연동 후 표시됩니다.
        </div>
      );
    }
    const displayRows =
      tab.key === selectedMatchedTab
        ? selectedVisibleRows
        : currentRowsByTab[tab.key];
    const emptyText = selectedPrintBatch
      ? `${selectedPrintBatch.batchLabel}에 포함된 PG가 없습니다.`
      : `${tab.label} 출력 대기 PG가 없습니다.`;

    return (
      <VirtualizedDataGrid
        rows={displayRows}
        columns={matchedColumns}
        rowKey={(row) => row.id}
        emptyMessage={
          isLoading
            ? "매칭 완료 목록을 불러오는 중입니다."
            : emptyText
        }
        minWidth="1260px"
        rowHeight={44}
        className="rounded-none border-0"
      />
    );
  };

  return (
    <WorkspacePageFrame className="p-5">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{MODE_LABELS[mode]} 목록</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === "matched"
              ? selectedPrintBatch
                ? `${selectedPrintBatch.batchLabel} \u00B7 합포장 ${selectedPrintBatch.packageGroupCount}박스 \u00B7 원 출력 ${selectedPrintBatch.itemCount}대 \u00B7 반품 제외 ${selectedPrintBatch.returnExcludedCount}대 \u00B7 작업 대상 ${selectedPrintBatch.effectiveItemCount}대`
                : `주문 ${summary?.orderCount ?? 0}건 \u00B7 출력 가능 PG ${summary?.matchedDeviceCount ?? 0}대 \u00B7 표시 ${matchedRows.length}대 \u00B7 출력 선택 ${selectedCurrentPackageGroupCount}박스 / ${selectedCurrentRowsForPrint.length}대`
              : `주문 ${summary?.orderCount ?? 0}건 \u00B7 주문 아이템 ${summary?.orderItemCount ?? rows.length}건 \u00B7 매칭 PG ${summary?.matchedDeviceCount ?? 0}대`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {mode === "matched" && selectedPrintBatch && selectedPrintBatchStatus ? (
            <Badge variant={printBatchStatusVariant(selectedPrintBatchStatus)}>
              {PRINT_BATCH_STATUS_LABELS[selectedPrintBatchStatus]}
            </Badge>
          ) : null}
          {mode === "matched" && canConfirmPrintBatch ? (
            <Button
              type="button"
              onClick={confirmSelectedPrintBatch}
              disabled={!canConfirmPrintBatch}
            >
              <CheckCircle2 className="size-4" />
              출력 완료 확정
            </Button>
          ) : null}
          {mode === "matched" && canCancelPrintBatch ? (
            <Button
              type="button"
              variant="outline"
              onClick={cancelSelectedPrintBatch}
              disabled={!canCancelPrintBatch}
            >
              <XCircle className="size-4" />
              출력한 차수 폐기
            </Button>
          ) : null}
          {mode === "matched" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleShipmentListPrint()}
              disabled={!canPrintShipmentList}
            >
              <Printer className="size-4" />
              {shipmentListPrintButtonLabel}
            </Button>
          ) : null}
          {nextCursor ? (
            <Button
              variant="outline"
              onClick={() => void loadRows(nextCursor, true)}
              disabled={isLoading || isLoadingMore}
            >
              {isLoadingMore ? "불러오는 중" : "다음 대상 불러오기"}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => void loadRows()}
            disabled={isLoading}
          >
            <RefreshCcw className="size-4" />
            목록 새로고침
          </Button>
        </div>
      </div>

      {mode === "matched" && activeOutputFocus ? (
        <div
          className={
            outputFocusError
              ? "mb-3 flex shrink-0 flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
              : "mb-3 flex shrink-0 flex-wrap items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
          }
        >
          <div className="min-w-0 flex-1">
            <div className="font-semibold">
              송장 재발급 #{activeOutputFocus.replacementWorkId} ·{" "}
              {activeOutputFocus.batchLabel}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              송장번호 {activeOutputFocus.trackingNumber}
              {outputFocusError ? ` · ${outputFocusError}` : ""}
            </div>
          </div>
          {outputFocusError ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPrintBatchLoading}
              onClick={requestRetryOutputFocus}
            >
              <RefreshCcw className="size-4" />
              대상 다시 찾기
            </Button>
          ) : null}
          {onReturnFromFocusedOutput ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                onReturnFromFocusedOutput(activeOutputFocus.returnMenuId)
              }
            >
              <ArrowLeft className="size-4" />
              재발급 진행 화면으로 돌아가기
            </Button>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <FeedbackBanner tone="warning" className="mb-3">
          {message}
        </FeedbackBanner>
      ) : null}

      {mode === "matched" &&
      selectedPrintBatch?.batchStatus === "CONFIRMED" ? (
        <div className="mb-3 grid shrink-0 gap-3 rounded-md border bg-popover p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">로젠 송장 처리·출력</div>
              <div className="mt-1 text-xs text-muted-foreground">
                출고 차수의 합포장 순서대로 채번·채널 반영·로젠 등록·송장 출력을
                진행합니다.
              </div>
            </div>
            {!invoiceIssueBatch ? (
              <Button
                type="button"
                onClick={() =>
                  void startInvoiceWorkflow(selectedPrintBatch.batchId).catch(
                    (error) =>
                      setMessage(
                        error instanceof Error ? error.message : String(error)
                      )
                  )
                }
                disabled={isInvoiceWorkflowLoading}
              >
                <RefreshCcw className="size-4" />
                {isInvoiceWorkflowLoading
                  ? "송장 처리 시작 중"
                  : "송장 처리 시작"}
              </Button>
            ) : (
              <Badge
                variant={
                  labelPrint?.labelPrintStatus === "CONFIRMED"
                    ? "success"
                    : labelPrint?.labelPrintStatus === "UNKNOWN"
                      ? "warning"
                      : "neutral"
                }
              >
                송장 출력 {labelPrint?.labelPrintStatus ?? "준비 중"}
              </Badge>
            )}
          </div>

          {invoiceIssueBatch ? (
            <>
              <div className="grid gap-2 text-xs sm:grid-cols-4">
                <div className="rounded border bg-secondary px-3 py-2">
                  <div className="text-muted-foreground">송장 채번</div>
                  <div className="mt-1 font-semibold">
                    {invoiceIssueBatch.allocatedPackageGroupCount} /{" "}
                    {invoiceIssueBatch.requestedPackageGroupCount}
                  </div>
                </div>
                <div className="rounded border bg-secondary px-3 py-2">
                  <div className="text-muted-foreground">쿠팡 등록·검증</div>
                  <div className="mt-1 font-semibold">
                    {
                      invoiceIssueBatch.items.filter(
                        (item) => item.packageGroupStatus === "READY"
                      ).length
                    }{" "}
                    / {invoiceIssueBatch.items.length}
                  </div>
                </div>
                <div className="rounded border bg-secondary px-3 py-2">
                  <div className="text-muted-foreground">로젠 주문 등록</div>
                  <div className="mt-1 font-semibold">
                    {
                      invoiceIssueBatch.items.filter(
                        (item) =>
                          item.carrierRegistration?.status === "REGISTERED"
                      ).length
                    }{" "}
                    / {invoiceIssueBatch.items.length}
                  </div>
                </div>
                <div className="rounded border bg-secondary px-3 py-2">
                  <div className="text-muted-foreground">실물 출력 확인</div>
                  <div className="mt-1 font-semibold">
                    {labelPrint?.items.filter(
                      (item) => item.printStatus === "CONFIRMED"
                    ).length ?? 0}{" "}
                    / {labelPrint?.items.length ?? invoiceIssueBatch.items.length}
                  </div>
                </div>
              </div>

              {labelPrint?.blockers?.length ? (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {labelPrint.blockers.slice(0, 3).map((item) => (
                    <div key={`${item.code}-${item.issueItemId ?? "batch"}`}>
                      {item.issueSequence ? `${item.issueSequence}번 · ` : ""}
                      {item.message}
                    </div>
                  ))}
                  {labelPrint.blockers.length > 3 ? (
                    <div>외 {labelPrint.blockers.length - 3}건</div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="h-9 min-w-64 rounded-md border bg-background px-3 text-sm"
                  value={printerSettings?.printerName ?? ""}
                  onChange={(event) => requestPrinterChange(event.target.value)}
                  disabled={
                    isPrinterLoading || isLabelPrinting || isPrinterSaving
                  }
                >
                  <option value="">TSC DA200 프린터 선택</option>
                  {printers.map((printer) => (
                    <option key={printer.name} value={printer.name}>
                      {printer.name}
                      {printer.isDefault ? " · 기본" : ""}
                      {printer.isOffline ? " · 오프라인" : ""}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={requestLoadPrinters}
                  disabled={
                    isPrinterLoading || isLabelPrinting || isPrinterSaving
                  }
                >
                  <RefreshCcw className="size-4" />
                  프린터 새로고침
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void printCalibration()}
                  disabled={
                    isLabelPrinting ||
                    isPrinterSaving ||
                    printerCalibrationDirty ||
                    !printerSettings?.printerName.trim()
                  }
                >
                  <Printer className="size-4" />
                  송장 출력 교정본
                </Button>
                {labelPrint?.labelPrintStatus === "SPOOLED" ? (
                  <Button
                    type="button"
                    onClick={() => setLabelConfirmationOpen(true)}
                  >
                    <CheckCircle2 className="size-4" />
                    출력 결과 확인
                  </Button>
                ) : labelPrint?.labelPrintStatus !== "CONFIRMED" &&
                  labelPrint?.labelPrintStatus !== "UNKNOWN" ? (
                  <Button
                    type="button"
                    onClick={() => void printLogenLabels()}
                    disabled={
                      !labelPrint?.ready ||
                      isLabelPrinting ||
                      isPrinterSaving ||
                      printerCalibrationDirty ||
                      !printerSettings?.printerName.trim()
                    }
                  >
                    <Printer className="size-4" />
                    {isLabelPrinting
                      ? "송장 출력 전송 중"
                      : labelPrint?.labelPrintStatus === "PARTIAL" ||
                          labelPrint?.labelPrintStatus === "FAILED"
                        ? `실패 ${labelPrint.targetIssueItemIds.length}장 복구 출력`
                        : `${labelPrint?.targetIssueItemIds.length ?? 0}장 일괄 출력`}
                  </Button>
                ) : null}
              </div>

              {printerSettings?.printerName ? (
                <div className="grid gap-2 rounded border bg-secondary/40 p-3 text-xs">
                  <div className="font-semibold">TSC DA200 교정 설정</div>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <label className="grid gap-1">
                      <span className="text-muted-foreground">센서</span>
                      <select
                        className="h-8 rounded border bg-background px-2"
                        value={printerSettings.sensorType}
                        onChange={(event) =>
                          setPrinterSettings((current) =>
                            current
                              ? {
                                  ...current,
                                  sensorType: event.target.value as
                                    | "GAP"
                                    | "BLINE",
                                }
                              : current
                          )
                        }
                        disabled={isLabelPrinting || isPrinterSaving}
                      >
                        <option value="GAP">GAP</option>
                        <option value="BLINE">BLINE</option>
                      </select>
                    </label>
                    {(
                      [
                        ["gapMm", "간격 mm", 0.1],
                        ["gapOffsetMm", "간격 보정 mm", 0.1],
                        ["referenceX", "기준 X dot", 1],
                        ["referenceY", "기준 Y dot", 1],
                        ["shiftX", "이동 X dot", 1],
                        ["shiftY", "이동 Y dot", 1],
                        ["speed", "속도", 1],
                        ["density", "농도", 1],
                      ] as const
                    ).map(([key, label, step]) => (
                      <label key={key} className="grid gap-1">
                        <span className="text-muted-foreground">{label}</span>
                        <input
                          className="h-8 rounded border bg-background px-2"
                          type="number"
                          step={step}
                          value={printerSettings[key]}
                          onChange={(event) =>
                            setPrinterSettings((current) =>
                              current
                                ? {
                                    ...current,
                                    [key]: Number(event.target.value),
                                  }
                                : current
                            )
                          }
                          disabled={isLabelPrinting || isPrinterSaving}
                        />
                      </label>
                    ))}
                    <label className="grid gap-1">
                      <span className="text-muted-foreground">방향</span>
                      <select
                        className="h-8 rounded border bg-background px-2"
                        value={printerSettings.direction}
                        onChange={(event) =>
                          setPrinterSettings((current) =>
                            current
                              ? {
                                  ...current,
                                  direction:
                                    event.target.value === "0" ? 0 : 1,
                                }
                              : current
                          )
                        }
                        disabled={isLabelPrinting || isPrinterSaving}
                      >
                        <option value={1}>정방향</option>
                        <option value={0}>역방향</option>
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void savePrinterCalibration()}
                      disabled={
                        isLabelPrinting ||
                        isPrinterSaving ||
                        !printerCalibrationDirty
                      }
                    >
                      교정 설정 저장
                    </Button>
                    <span className="text-muted-foreground">
                      송장 출력 교정본을 먼저 출력하고 간격·기준점·이동값을
                      조정하세요.
                    </span>
                  </div>
                </div>
              ) : null}

              {labelPrint?.labelPrintStatus === "UNKNOWN" ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span>
                    Windows spooler 결과를 확정하지 못했습니다. 중복 출력을
                    막기 위해 관리자 판정 전에는 재출력할 수 없습니다.
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void resolveUnknownLabelPrint(true)}
                      disabled={isLabelPrinting}
                    >
                      실제 출력됨
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void resolveUnknownLabelPrint(false)}
                      disabled={isLabelPrinting}
                    >
                      출력 안 됨
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-popover">
        {mode === "matched" ? (
          <Tabs
            value={selectedMatchedTab}
            onValueChange={(value) =>
              requestMatchedTabChange(value as MatchedWarrantyTabKey)
            }
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
              <TabsList className="max-w-full overflow-x-auto">
                {MATCHED_WARRANTY_TABS.map((tab) => (
                  <TabsTrigger key={tab.key} value={tab.key}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {selectedMatchedTabInfo.source === "coupang" ? (
                <Tabs
                  value={selectedPrintBatchKey}
                  onValueChange={requestPrintBatchChange}
                  className="min-w-0"
                >
                  <TabsList className="max-w-[560px] overflow-x-auto">
                    <TabsTrigger value="current">신규 주문 건</TabsTrigger>
                    {printBatches.map((batch) => (
                      <TabsTrigger
                        key={batch.batchId}
                        value={String(batch.batchId)}
                      >
                        {batch.batchNo}차
                        {batch.batchStatus === "CONFIRMED"
                          ? ""
                          : ` · ${PRINT_BATCH_STATUS_LABELS[batch.batchStatus]}`}
                        {batch.returnExcludedCount > 0
                          ? ` · 반품 제외 ${batch.returnExcludedCount}`
                          : ""}
                      </TabsTrigger>
                    ))}
                    {isPrintBatchLoading ? (
                      <span className="px-2 text-xs text-muted-foreground">
                        조회 중
                      </span>
                    ) : null}
                  </TabsList>
                </Tabs>
              ) : null}
            </div>
            {MATCHED_WARRANTY_TABS.map((tab) => (
              <TabsContent
                key={tab.key}
                value={tab.key}
                className="m-0 min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden"
              >
                {renderMatchedTabContent(tab)}
              </TabsContent>
            ))}
          </Tabs>
        ) : (
          <VirtualizedDataGrid
            rows={rows}
            columns={columns}
            rowKey={(row) => row.id}
            emptyMessage={
              isLoading
                ? "주문 목록을 불러오는 중입니다."
                : "조회된 주문 아이템이 없습니다."
            }
            minWidth="1560px"
            rowHeight={72}
            className="rounded-none border-0"
          />
        )}
      </div>

      {printConfirmationBatch ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="shipment-print-confirm-title"
        >
          <div className="grid w-full max-w-lg gap-4 rounded-md border bg-popover p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
                <Printer className="size-5" />
              </div>
              <div className="min-w-0">
                <h2
                  id="shipment-print-confirm-title"
                  className="text-base font-bold"
                >
                  출고 목록 출력 확인
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  출력물을 확인한 뒤 작업을 확정하거나, 문제가 있으면 다시 출력 또는 취소하세요.
                </p>
              </div>
            </div>

            <div className="rounded-md border bg-secondary px-3 py-2 text-sm">
              <div className="font-semibold">
                {printConfirmationBatch.batchLabel}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                원 출력 {printConfirmationBatch.itemCount.toLocaleString("ko-KR")}건
                {" · 반품 제외 "}
                {printConfirmationBatch.returnExcludedCount.toLocaleString("ko-KR")}건
                {" · 작업 대상 "}
                {printConfirmationBatch.effectiveItemCount.toLocaleString("ko-KR")}건
                {" · 상태 "}
                {PRINT_BATCH_STATUS_LABELS[printConfirmationBatch.batchStatus]}
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void reprintShipmentBatch(printConfirmationBatch)}
                disabled={
                  isReprinting ||
                  isPrintBatchUpdating ||
                  printConfirmationBatch.effectiveItemCount === 0
                }
              >
                <Printer className="size-4" />
                {isReprinting ? "다시 출력중" : "다시 인쇄"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancelPrintBatch(printConfirmationBatch)}
                disabled={isReprinting || isPrintBatchUpdating}
              >
                <XCircle className="size-4" />
                출력한 차수 폐기
              </Button>
              <Button
                type="button"
                onClick={() => void confirmPrintBatch(printConfirmationBatch)}
                disabled={isReprinting || isPrintBatchUpdating}
              >
                <CheckCircle2 className="size-4" />
                {isPrintBatchUpdating ? "확정중" : "출력 완료 확정"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {labelConfirmationOpen && labelPrint ? (
        <div
          className="fixed inset-0 z-[55] grid place-items-center bg-background/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="logen-label-confirm-title"
        >
          <div className="grid max-h-[88vh] w-full max-w-2xl gap-4 overflow-hidden rounded-md border bg-popover p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
                <Printer className="size-5" />
              </div>
              <div>
                <h2 id="logen-label-confirm-title" className="text-base font-bold">
                  로젠 송장 실물 출력 확인
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  출력되지 않았거나 훼손된 송장만 실패로 선택하세요. 선택한 송장만
                  같은 송장번호로 복구 출력합니다.
                </p>
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto rounded-md border">
              {labelPrint.items
                .filter((item) => item.printStatus === "SPOOLED")
                .map((item) => {
                  const label = labelPrint.labels.find(
                    (candidate) =>
                      candidate.issueItemId === item.issueItemId
                  );
                  const failed = failedLabelIds.includes(item.issueItemId);
                  return (
                    <label
                      key={item.issueItemId}
                      className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        checked={failed}
                        onChange={(event) =>
                          setFailedLabelIds((current) =>
                            event.target.checked
                              ? Array.from(
                                  new Set([...current, item.issueItemId])
                                )
                              : current.filter(
                                  (id) => id !== item.issueItemId
                                )
                          )
                        }
                      />
                      <span className="w-10 text-sm font-semibold">
                        {item.issueSequence}
                      </span>
                      <span className="w-28 font-mono text-xs">
                        {item.trackingNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {label?.receiver.name ?? `PG ${item.packageGroupId}`}
                        {" · "}
                        {label?.receiver.address1 ?? "-"}
                      </span>
                      <Badge variant={failed ? "warning" : "neutral"}>
                        {failed ? "실패" : "정상 예정"}
                      </Badge>
                    </label>
                  );
                })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                실패 선택 {failedLabelIds.length}장
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setFailedLabelIds(
                      labelPrint.items
                        .filter((item) => item.printStatus === "SPOOLED")
                        .map((item) => item.issueItemId)
                    )
                  }
                  disabled={isLabelPrinting}
                >
                  전체 실패 선택
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={requestLabelConfirmationClose}
                  disabled={isLabelPrinting}
                >
                  나중에 확인
                </Button>
                <Button
                  type="button"
                  onClick={() => void confirmPhysicalLabels()}
                  disabled={isLabelPrinting}
                >
                  <CheckCircle2 className="size-4" />
                  {isLabelPrinting
                    ? "반영 중"
                    : failedLabelIds.length > 0
                      ? "정상·실패 결과 반영"
                      : "전체 정상 출력"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {returnConflicts.length > 0 ? (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-background/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="shipment-return-conflict-title"
        >
          <div className="grid w-full max-w-2xl gap-4 rounded-md border bg-popover p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700">
                <TriangleAlert className="size-5" />
              </div>
              <div className="min-w-0">
                <h2
                  id="shipment-return-conflict-title"
                  className="text-base font-bold"
                >
                  반품 처리 필요
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {returnConflictMessage}
                </p>
              </div>
            </div>

            <div className="max-h-[52vh] divide-y overflow-y-auto border-y">
              {returnConflicts.map((conflict) => (
                <div
                  key={conflict.returnRawId}
                  className="grid gap-1 px-1 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      주문번호 {conflict.externalOrderId}
                    </span>
                    <Badge variant="warning">
                      반품 {conflict.cancelCount.toLocaleString("ko-KR")}개
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    배송번호 {conflict.externalShipmentId || "확인 필요"}
                    {" · 접수번호 "}
                    {conflict.externalReceiptId}
                    {" · 상태 "}
                    {conflict.receiptStatus || "-"}
                  </div>
                  <div className="text-xs">
                    상품 {conflict.vendorItemNames.join(", ") || "상품 정보 확인 필요"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    영향 PG {conflict.pgNos.join(", ") || "미확정"}
                    {conflict.scopeIncomplete
                      ? " · 쿠팡 원본의 배송/상품 식별값이 부족해 넓은 범위로 차단됨"
                      : ""}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setReturnConflictMessage("");
                  setReturnConflicts([]);
                }}
              >
                닫기
              </Button>
              {onOpenPreShipmentReturns ? (
                <Button
                  type="button"
                  onClick={() => {
                    setReturnConflictMessage("");
                    setReturnConflicts([]);
                    onOpenPreShipmentReturns();
                  }}
                >
                  출고 전 반품목록 열기
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </WorkspacePageFrame>
  );
}
