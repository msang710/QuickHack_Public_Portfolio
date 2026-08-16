// QuickHack note: 쿠팡 주문/배송/주문아이템 데이터를 QuickHack DB 구조로 동기화합니다.
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import {
  databaseDateTime,
  databaseDateTimeOrNull,
  databaseNow,
  type DatabaseDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import { setOperationTraceField } from "@/quickhack_server/observability/operation-trace";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { getSalesOfferMatchingDefinition } from "@/quickhack_server/catalog/sales-offer-service";
import {
  assertWorkerLeaseActive,
  throwIfWorkerLeaseAborted,
} from "@/quickhack_server/workers/lease-guard";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";
import { isWorkerShutdownRequestedError } from "@/quickhack_server/workers/shutdown-runtime";
import {
  getCoupangExchangeRequests,
  getCoupangOrdersheets,
  getCoupangReturnRequests,
  getCoupangReturnWithdrawals,
  openCoupangApiCredentialContext,
  type CoupangApiCredentialContext,
} from "@/quickhack_server/sales-channel/coupang/api-client";
import { recordValidatedIntegrationInboxEvidence } from "@/quickhack_server/integration/inbox-service";
import {
  claimIntegrationProjectionJob,
  claimIntegrationProjectionJobById,
  runClaimedIntegrationProjection,
} from "@/quickhack_server/integration/projection-service";
import { validateCoupangOrdersheetPage } from "@/quickhack_server/sales-channel/coupang/ordersheet-schema";
import {
  validateCoupangExchangePage,
  validateCoupangReturnPage,
  validateCoupangReturnWithdrawalPage,
} from "@/quickhack_server/sales-channel/coupang/claim-schema";
import {
  recordExchangeObservation,
  recordReturnObservation,
  recordReturnWithdrawal,
} from "@/quickhack_server/sales-channel/coupang/claim-history-service";
import {
  derivePreMatchWorkState,
  expireOrderMatchingWorkItemIfEligible,
  synchronizeWorkItemMappingSnapshot,
} from "@/quickhack_server/sales-channel/coupang/order-mapping-snapshot-service";
import {
  COUPANG_RETURN_REQUEST_STATUSES,
  getCoupangRuntimeConfig,
} from "@/quickhack_server/sales-channel/coupang/config";
import {
  beginCoupangApiCallLog,
  completeCoupangApiCallLog,
  coupangApiCallErrorCode as syncErrorCode,
  coupangApiCallErrorMessage as syncErrorMessage,
  failCoupangApiCallLog,
  markCoupangApiCallProcessing,
  markCoupangApiCallReceived,
} from "@/quickhack_server/sales-channel/coupang/api-call-log-service";
import { safeCoupangExternalResponseCode } from "@/quickhack_server/sales-channel/coupang/external-response-metadata";
import {
  maskOrderPersonalData,
  reconcilePersonalDataLifecyclesForOrder,
  recordPersonalDataDeliveryCompletion,
  shouldMaskOrderPersonalDataOnSync,
} from "@/quickhack_server/security/personal-data-lifecycle-service";
import { projectCoupangDeliveryStatuses } from "@/quickhack_server/shipment/delivery-status-projection-service";
import {
  reserveSalesChannelProjectionObservation,
  type SalesChannelProjectionObservation,
} from "@/quickhack_server/sales-channel/projection-revision-service";
import {
  coupangReturnReasonLabel,
  normalizeCoupangReasonLabel,
} from "@/quickhack_shared/sales-channel/coupang-return-reasons";
import {
  normalizeCoupangClaimFault,
  normalizeCoupangClaimReasonDetail,
  normalizeCoupangReceiptType,
  normalizeCoupangRefundDeliveryDuty,
  normalizeCoupangWithdrawalVendorItemIds,
  normalizeExternalClaimTimestamp,
  type CoupangExchangeHistorySnapshot,
  type CoupangReturnHistorySnapshot,
  type CoupangReturnWithdrawalSnapshot,
} from "@/quickhack_shared/sales-channel/coupang/claim-history";
import {
  CHANNEL_ORDER_MAPPING_FAILURE_REASONS,
  INVENTORY_MATCH_STATUSES,
} from "@/quickhack_shared/sales-channel/order-matching";
import {
  SALES_CHANNEL_WRITE_ATTEMPT_STATUS,
  SALES_CHANNEL_WRITE_FAILURE_STAGE,
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
  SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS,
  SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS,
} from "@/quickhack_shared/sales-channel/write-requests";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import {
  addSeconds,
  nowKstSqlDateTime,
  parseKstSqlDateTime,
  quickHackClock,
  todayKstDate,
  type DateTimeInput,
} from "@/quickhack_shared/core/time";

const COUPANG_CHANNEL = "COUPANG";
const MAPPING_STATUS = {
  mapped: "MAPPED",
  unmapped: "UNMAPPED",
} as const;
const MATCHING_FAILURE_REASON = CHANNEL_ORDER_MAPPING_FAILURE_REASONS;
const ORDERSHEET_PAGE_SIZE = 50;
const RETURN_REQUEST_PAGE_SIZE = 50;
const EXCHANGE_REQUEST_PAGE_SIZE = 50;
const RETURN_WITHDRAWAL_PAGE_SIZE = 100;
const RETURN_WITHDRAWAL_MAX_RANGE_DAYS = 7;
const CLAIM_PROJECTION_LOCK_SECONDS = 120;
const CLAIM_PROJECTION_HANDLER = {
  returns: "COUPANG_RETURN_PAGE_V1",
  exchanges: "COUPANG_EXCHANGE_PAGE_V1",
  withdrawals: "COUPANG_RETURN_WITHDRAWAL_PAGE_V1",
} as const;
const CLAIM_PROJECTION_HANDLER_KEYS = Object.values(CLAIM_PROJECTION_HANDLER);
const RETURN_REQUEST_RECEIPT_TYPES = ["RETURN", "CANCEL"] as const;
const SYNC_PAGE_TRANSACTION_MAX_WAIT_MS = 10_000;
const SYNC_PAGE_TRANSACTION_TIMEOUT_MS = 60_000;
const ACCEPT_ORDER_SYNC_STATUSES = ["ACCEPT"] as const;
const PRE_SHIPMENT_VERIFY_ORDER_STATUSES = ["INSTRUCT", "DEPARTURE"] as const;
const SHIPMENT_STATUS_SYNC_STATUSES = [
  "DELIVERING",
  "FINAL_DELIVERY",
] as const;
const ONE_DAY_SECONDS = 60 * 60 * 24;
const COUPANG_ORDER_RAW_SOURCE_TABLE = "coupang_order_raw";
const SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE = "SHIPMENT_ADDRESS_CHANGED";
const SHIPMENT_ADDRESS_CHANGE_TRACKED_ORDER_STATUS = "DEPARTURE";
const TRACKED_SHIPMENT_ADDRESS_COLUMNS = [
  "receiver_name",
  "receiver_safe_number",
  "receiver_address_1",
  "receiver_address_2",
  "receiver_post_code",
  "shipping_memo",
] as const;

type JsonRecord = Record<string, unknown>;

export type CoupangReadSyncDependencies = {
  openCredentialContext?: typeof openCoupangApiCredentialContext;
  getOrdersheets?: typeof getCoupangOrdersheets;
  getReturnRequests?: typeof getCoupangReturnRequests;
  getExchangeRequests?: typeof getCoupangExchangeRequests;
  getReturnWithdrawals?: typeof getCoupangReturnWithdrawals;
};

type CoupangReadSyncCredentialScope = {
  get: () => Promise<CoupangApiCredentialContext>;
};

function createCoupangReadSyncCredentialScope(
  dependencies: CoupangReadSyncDependencies
): CoupangReadSyncCredentialScope {
  let credentialContext: Promise<CoupangApiCredentialContext> | undefined;
  let useCount = 0;

  setOperationTraceField("qhkey.credential_context_scope", "READ_SYNC_RUN");
  setOperationTraceField("qhkey.credential_context_reuse_enabled", true);
  setOperationTraceField("qhkey.credential_context_reused", false);
  setOperationTraceField("qhkey.credential_context_use_count", 0);

  return {
    get() {
      useCount += 1;
      setOperationTraceField("qhkey.credential_context_use_count", useCount);

      if (credentialContext) {
        setOperationTraceField("qhkey.credential_context_reused", true);
        return credentialContext;
      }

      credentialContext = Promise.resolve(
        (
          dependencies.openCredentialContext ??
          openCoupangApiCredentialContext
        )("CACHED_READ")
      );
      return credentialContext;
    },
  };
}

export type NormalizedCoupangOrderItem = {
  externalVendorItemId: string;
  vendorItemName: string | null;
  sellerProductId: string | null;
  sellerProductName: string | null;
  sellerProductItemName: string | null;
  externalVendorSkuCode: string | null;
  salesPrice: number | null;
  shippingCount: number;
  holdCountForCancel: number;
  cancelCount: number;
  canceled: number;
  availableQuantity: number;
};

export type NormalizedCoupangOrder = {
  externalOrderId: string;
  externalShipmentId: string;
  channelStatus: string | null;
  orderedAt: string | null;
  paidAt: string | null;
  ordererName: string | null;
  receiverName: string | null;
  receiverSafeNumber: string | null;
  receiverAddress1: string | null;
  receiverAddress2: string | null;
  receiverPostCode: string | null;
  shippingMemo: string | null;
  deliveryCompanyName: string | null;
  invoiceNumber: string | null;
  invoiceUploadedAt: string | null;
  splitShipping: boolean | null;
  deliveredAt: string | null;
  items: NormalizedCoupangOrderItem[];
};

export type NormalizedCoupangReturnItem = {
  externalShipmentId: string | null;
  externalVendorItemId: string | null;
  sellerProductItemId: string | null;
  vendorItemName: string | null;
  cancelCount: number;
  reasonCode: string | null;
  reasonLabel: string | null;
};

export type NormalizedCoupangReturn = {
  externalReceiptId: string;
  externalOrderId: string | null;
  externalShipmentId: string | null;
  cancelType: string | null;
  receiptType: string | null;
  receiptStatus: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  reasonCategory: string | null;
  reasonDetail: string | null;
  historyReasonDetail: string | null;
  releaseStatus: string | null;
  faultByType: string | null;
  externalCreatedAt: string | null;
  externalModifiedAt: string | null;
  externalCompletedAt: string | null;
  externalCompletionType: string | null;
  invalidTimestampCount: number;
  cancelCount: number;
  itemIntegrityStatus: "VALID" | "COUNT_MISMATCH";
  items: NormalizedCoupangReturnItem[];
};

export type NormalizedCoupangExchange = {
  externalExchangeId: string;
  externalOrderId: string;
  externalShipmentId: string | null;
  externalShipmentIds: string[];
  scopeIntegrityStatus: "VALID" | "MISSING_SCOPE";
  exchangeStatus: string | null;
  faultByType: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  reasonDetail: string | null;
  externalCreatedAt: string | null;
  externalModifiedAt: string | null;
  invalidTimestampCount: number;
};

export type NormalizedCoupangReturnWithdrawal = {
  externalReceiptId: string;
  externalOrderId: string | null;
  externalWithdrawnAt: string | null;
  refundDeliveryDuty: string | null;
  vendorItemIds: string;
  invalidTimestampCount: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function nullableText(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function requiredText(value: unknown, fieldName: string) {
  const text = nullableText(value);

  if (!text) {
    throw new Error(`쿠팡 응답에 필수값이 없습니다: ${fieldName}`);
  }

  return text;
}

function integerValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveIntegerValue(value: unknown) {
  const parsed = integerValue(value);

  return parsed > 0 ? parsed : 0;
}

function firstNullableText(
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[]
) {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const text = nullableText(source[key]);

    if (text) {
      return text;
    }
  }

  return null;
}

function nonNegativeIntegerOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  const integer = Math.trunc(parsed);

  return integer >= 0 ? integer : null;
}

function moneyUnits(value: unknown) {
  if (isRecord(value)) {
    return nonNegativeIntegerOrNull(value.units);
  }

  return nonNegativeIntegerOrNull(value);
}

function booleanInt(value: unknown) {
  return value === true || String(value).toLowerCase() === "true" ? 1 : 0;
}

function stableHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function endpointPathFromRequestPath(value: string) {
  return value.split("?")[0] || value;
}

function responseData(payload: unknown) {
  return isRecord(payload) && isRecord(payload.data) ? payload.data : {};
}

function externalResponseCode(payload: unknown) {
  if (!isRecord(payload)) {
    return null;
  }

  const data = responseData(payload);

  return (
    safeCoupangExternalResponseCode(payload.code) ??
    safeCoupangExternalResponseCode(payload.responseCode) ??
    safeCoupangExternalResponseCode(data.code) ??
    safeCoupangExternalResponseCode(data.responseCode)
  );
}

function shipmentAddressSnapshotFromOrder(order: NormalizedCoupangOrder) {
  return {
    receiver_name: order.receiverName,
    receiver_safe_number: order.receiverSafeNumber,
    receiver_address_1: order.receiverAddress1,
    receiver_address_2: order.receiverAddress2,
    receiver_post_code: order.receiverPostCode,
    shipping_memo: order.shippingMemo,
  };
}

function shipmentAddressSnapshotFromRow(
  row: Pick<
    Prisma.coupang_order_rawGetPayload<Record<string, never>>,
    | "receiver_name"
    | "receiver_safe_number"
    | "receiver_address_1"
    | "receiver_address_2"
    | "receiver_post_code"
    | "shipping_memo"
  >
) {
  return {
    receiver_name: row.receiver_name,
    receiver_safe_number: row.receiver_safe_number,
    receiver_address_1: row.receiver_address_1,
    receiver_address_2: row.receiver_address_2,
    receiver_post_code: row.receiver_post_code,
    shipping_memo: row.shipping_memo,
  };
}

function changedShipmentAddressValues(
  before: ReturnType<typeof shipmentAddressSnapshotFromOrder>,
  after: ReturnType<typeof shipmentAddressSnapshotFromOrder>
) {
  const changedColumns = TRACKED_SHIPMENT_ADDRESS_COLUMNS.filter(
    (column) => before[column] !== after[column]
  );

  return {
    changedColumns,
    beforeValues: Object.fromEntries(
      changedColumns.map((column) => [column, before[column]])
    ),
    afterValues: Object.fromEntries(
      changedColumns.map((column) => [column, after[column]])
    ),
  };
}

async function createShipmentAddressChangeEvent(
  tx: Prisma.TransactionClient,
  input: {
    existingOrder: Prisma.coupang_order_rawGetPayload<Record<string, never>> | null;
    order: NormalizedCoupangOrder;
    now: DatabaseDateTime;
    apiCallLogId?: number | null;
  }
) {
  if (!input.existingOrder) {
    return false;
  }

  if (input.order.channelStatus !== SHIPMENT_ADDRESS_CHANGE_TRACKED_ORDER_STATUS) {
    return false;
  }

  const before = shipmentAddressSnapshotFromRow(input.existingOrder);
  const after = shipmentAddressSnapshotFromOrder(input.order);
  const diff = changedShipmentAddressValues(before, after);

  if (diff.changedColumns.length === 0) {
    return false;
  }

  const changeHash = stableHash({
    externalOrderId: input.order.externalOrderId,
    externalShipmentId: input.order.externalShipmentId,
    eventType: SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
    changedColumns: diff.changedColumns,
    beforeValues: diff.beforeValues,
    afterValues: diff.afterValues,
  });

  const event = await tx.coupang_raw_change_event.upsert({
    where: {
      source_table_source_pk_event_type_change_hash: {
        source_table: COUPANG_ORDER_RAW_SOURCE_TABLE,
        source_pk: String(input.existingOrder.coupang_order_raw_id),
        event_type: SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
        change_hash: changeHash,
      },
    },
    create: {
      source_table: COUPANG_ORDER_RAW_SOURCE_TABLE,
      source_pk: String(input.existingOrder.coupang_order_raw_id),
      external_order_id: input.order.externalOrderId,
      external_shipment_id: input.order.externalShipmentId,
      event_type: SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
      change_hash: changeHash,
      api_call_log_id: input.apiCallLogId ?? null,
      process_status: "PENDING",
      detected_at: input.now,
      created_at: input.now,
      updated_at: input.now,
    },
    update: {
      external_order_id: input.order.externalOrderId,
      external_shipment_id: input.order.externalShipmentId,
      api_call_log_id: input.apiCallLogId ?? null,
      updated_at: input.now,
    },
    select: {
      coupang_raw_change_event_id: true,
    },
  });

  await tx.coupang_raw_change_event_field.deleteMany({
    where: {
      raw_change_event_id: event.coupang_raw_change_event_id,
    },
  });

  for (const column of diff.changedColumns) {
    await tx.coupang_raw_change_event_field.create({
      data: {
        raw_change_event_id: event.coupang_raw_change_event_id,
        field_name: column,
        before_value: diff.beforeValues[column] ?? null,
        after_value: diff.afterValues[column] ?? null,
        created_at: input.now,
      },
    });
  }

  return true;
}

function normalizeOrderItem(item: unknown): NormalizedCoupangOrderItem {
  if (!isRecord(item)) {
    throw new Error("쿠팡 주문 상품 형식이 올바르지 않습니다.");
  }

  const shippingCount = integerValue(item.shippingCount);
  const holdCountForCancel = integerValue(item.holdCountForCancel);
  const cancelCount = integerValue(item.cancelCount);

  return {
    externalVendorItemId: requiredText(item.vendorItemId, "orderItems[].vendorItemId"),
    vendorItemName: nullableText(item.vendorItemName),
    sellerProductId: nullableText(item.sellerProductId),
    sellerProductName: nullableText(item.sellerProductName),
    sellerProductItemName: nullableText(item.sellerProductItemName),
    externalVendorSkuCode:
      nullableText(item.externalVendorSkuCode) ??
      nullableText(item.externalVendorSku) ??
      nullableText(item.vendorSkuCode),
    salesPrice: moneyUnits(item.salesPrice),
    shippingCount,
    holdCountForCancel,
    cancelCount,
    canceled: booleanInt(item.canceled),
    availableQuantity: Math.max(0, shippingCount - holdCountForCancel - cancelCount),
  };
}

export function normalizeOrdersheet(order: unknown): NormalizedCoupangOrder {
  if (!isRecord(order)) {
    throw new Error("쿠팡 주문 형식이 올바르지 않습니다.");
  }

  const receiver = isRecord(order.receiver) ? order.receiver : {};
  const orderer = isRecord(order.orderer) ? order.orderer : {};

  return {
    externalOrderId: requiredText(order.orderId, "orderId"),
    externalShipmentId: requiredText(order.shipmentBoxId, "shipmentBoxId"),
    channelStatus: nullableText(order.status),
    orderedAt: nullableText(order.orderedAt),
    paidAt: nullableText(order.paidAt),
    ordererName: nullableText(orderer.name),
    receiverName: nullableText(receiver.name),
    receiverSafeNumber: nullableText(receiver.safeNumber),
    receiverAddress1: nullableText(receiver.addr1),
    receiverAddress2: nullableText(receiver.addr2),
    receiverPostCode: nullableText(receiver.postCode),
    shippingMemo:
      nullableText(order.parcelPrintMessage) ?? nullableText(order.deliveryMessage),
    deliveryCompanyName: nullableText(order.deliveryCompanyName),
    invoiceNumber: nullableText(order.invoiceNumber),
    invoiceUploadedAt:
      asArray(order.orderItems)
        .map((item) =>
          isRecord(item) ? nullableText(item.invoiceNumberUploadDate) : null
        )
        .find(Boolean) ?? null,
    splitShipping:
      typeof order.splitShipping === "boolean" ? order.splitShipping : null,
    deliveredAt: nullableText(order.deliveredDate),
    items: asArray(order.orderItems).map(normalizeOrderItem),
  };
}

export function ordersheetsFromPayload(payload: unknown) {
  return validateCoupangOrdersheetPage(payload);
}

export function nextTokenFromPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return null;
  }

  const data = isRecord(payload.data) ? payload.data : {};

  return nullableText(payload.nextToken) ?? nullableText(data.nextToken);
}

function returnItemCancelCount(item: Record<string, unknown>) {
  return (
    positiveIntegerValue(item.cancelCount) ||
    positiveIntegerValue(item.cancelQuantity) ||
    positiveIntegerValue(item.returnCount) ||
    positiveIntegerValue(item.quantity) ||
    1
  );
}

function normalizeReturnItem(
  item: unknown,
  parent: Record<string, unknown>
): NormalizedCoupangReturnItem {
  const row = isRecord(item) ? item : {};
  const reasonCode =
    nullableText(row.reasonCode) ??
    nullableText(row.returnReasonCode) ??
    nullableText(row.cancelReasonCode) ??
    nullableText(parent.reasonCode);

  return {
    externalShipmentId:
      firstNullableText(row, ["shipmentBoxId", "externalShipmentBoxId"]) ??
      nullableText(parent.shipmentBoxId),
    externalVendorItemId: firstNullableText(row, [
      "vendorItemId",
      "externalVendorItemId",
    ]),
    sellerProductItemId: firstNullableText(row, ["sellerProductItemId"]),
    vendorItemName: firstNullableText(row, [
      "vendorItemName",
      "sellerProductItemName",
      "productName",
    ]),
    cancelCount: returnItemCancelCount(row),
    reasonCode,
    reasonLabel:
      normalizeCoupangReasonLabel(
        firstNullableText(row, [
          "reasonCodeText",
          "returnReason",
          "cancelReasonName",
        ])
      ) ||
      coupangReturnReasonLabel(reasonCode) ||
      null,
  };
}

export function normalizeReturnRequest(value: unknown): NormalizedCoupangReturn {
  if (!isRecord(value)) {
    throw new Error("쿠팡 반품/취소 요청 형식이 올바르지 않습니다.");
  }

  const returnItems = asArray(value.returnItems);
  const normalizedItems = returnItems.map((item) =>
    normalizeReturnItem(item, value)
  );
  const firstReturnItem = isRecord(returnItems[0]) ? returnItems[0] : {};
  const firstNormalizedItem = normalizedItems[0] ?? null;
  const canonicalShipmentId = Array.from(
    new Set(
      normalizedItems
        .map((item) => item.externalShipmentId)
        .filter((shipmentId): shipmentId is string => Boolean(shipmentId))
    )
  ).sort()[0] ?? null;
  const reasonCode = nullableText(value.reasonCode);
  const reasonLabel =
    normalizeCoupangReasonLabel(
      nullableText(value.reasonCodeText) ??
        nullableText(value.returnReason) ??
        nullableText(value.cancelReasonName) ??
        nullableText(firstReturnItem.reasonCodeText) ??
        nullableText(firstReturnItem.returnReason) ??
        nullableText(firstReturnItem.cancelReasonName)
    ) ||
    coupangReturnReasonLabel(reasonCode) ||
    null;
  const directCancelCount = positiveIntegerValue(value.cancelCountSum);
  const itemCancelCount = normalizedItems.reduce(
    (sum, item) => sum + item.cancelCount,
    0
  );
  const rawReceiptType =
    nullableText(value.cancelType) ?? nullableText(value.receiptType);
  const externalCreatedAt = normalizeExternalClaimTimestamp(value.createdAt);
  const externalModifiedAt = normalizeExternalClaimTimestamp(value.modifiedAt);
  const externalCompletedAt = normalizeExternalClaimTimestamp(
    value.completeConfirmDate
  );
  const officialReasonDetail =
    nullableText(value.cancelReason) ??
    nullableText(value.reasonEtcDetail) ??
    nullableText(value.reasonDetail) ??
    nullableText(value.returnReasonDetail) ??
    nullableText(value.cancelReasonDetail) ??
    nullableText(firstReturnItem.cancelReason) ??
    nullableText(firstReturnItem.reasonEtcDetail) ??
    nullableText(firstReturnItem.reasonDetail) ??
    nullableText(firstReturnItem.returnReasonDetail) ??
    nullableText(firstReturnItem.cancelReasonDetail);

  return {
    externalReceiptId: requiredText(value.receiptId, "receiptId"),
    externalOrderId:
      nullableText(value.orderId) ?? firstNullableText(firstReturnItem, ["orderId"]),
    externalShipmentId:
      canonicalShipmentId ??
      firstNormalizedItem?.externalShipmentId ??
      null,
    cancelType: rawReceiptType,
    receiptType: normalizeCoupangReceiptType(rawReceiptType),
    receiptStatus: nullableText(value.receiptStatus) ?? nullableText(value.status),
    reasonCode,
    reasonLabel,
    reasonCategory: normalizeCoupangReasonLabel(
      nullableText(value.cancelReasonCategory1) ??
        nullableText(value.reason) ??
        nullableText(value.reasonName) ??
        nullableText(value.claimReason) ??
        nullableText(firstReturnItem.cancelReasonCategory1) ??
        nullableText(firstReturnItem.reason) ??
        nullableText(firstReturnItem.reasonName) ??
        nullableText(firstReturnItem.claimReason)
    ),
    reasonDetail: normalizeCoupangReasonLabel(
      officialReasonDetail ??
        nullableText(value.vendorMemo) ??
        nullableText(value.memo) ??
        nullableText(value.comment) ??
        nullableText(firstReturnItem.vendorMemo) ??
        nullableText(firstReturnItem.memo) ??
        nullableText(firstReturnItem.comment)
    ),
    historyReasonDetail:
      normalizeCoupangClaimReasonDetail(officialReasonDetail),
    releaseStatus:
      nullableText(value.releaseStatus) ??
      nullableText(firstReturnItem.releaseStatus) ??
      nullableText(value.releaseStopStatus),
    faultByType: normalizeCoupangClaimFault(value.faultByType),
    externalCreatedAt: externalCreatedAt.value,
    externalModifiedAt: externalModifiedAt.value,
    externalCompletedAt: externalCompletedAt.value,
    externalCompletionType: nullableText(value.completeConfirmType),
    invalidTimestampCount: [
      externalCreatedAt,
      externalModifiedAt,
      externalCompletedAt,
    ].filter((timestamp) => timestamp.invalid).length,
    cancelCount: directCancelCount || itemCancelCount || 1,
    itemIntegrityStatus:
      directCancelCount > 0 && directCancelCount !== itemCancelCount
        ? "COUNT_MISMATCH"
        : "VALID",
    items: normalizedItems,
  };
}

export function returnRequestsFromPayload(payload: unknown) {
  return validateCoupangReturnPage(payload).returns
    .filter(
      (returnRequest) =>
        String(returnRequest.cancelType ?? "").toUpperCase() !== "EXCHANGE"
    );
}

function firstRecordItem(value: unknown) {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : {};
}

export function normalizeExchangeRequest(
  value: unknown
): NormalizedCoupangExchange {
  if (!isRecord(value)) {
    throw new Error("쿠팡 교환 요청 형식이 올바르지 않습니다.");
  }

  const firstExchangeItem = firstRecordItem(value.exchangeItemDtoV1s);
  const externalShipmentIds = Array.from(
    new Set(
      [
        nullableText(value.originalShipmentBoxId),
        ...asArray(value.exchangeItemDtoV1s).map((item) =>
          isRecord(item) ? nullableText(item.originalShipmentBoxId) : null
        ),
      ].filter((item): item is string => Boolean(item))
    )
  ).sort();
  const externalCreatedAt = normalizeExternalClaimTimestamp(value.createdAt);
  const externalModifiedAt = normalizeExternalClaimTimestamp(value.modifiedAt);

  return {
    externalExchangeId: requiredText(value.exchangeId, "exchangeId"),
    externalOrderId: requiredText(value.orderId, "orderId"),
    externalShipmentId:
      externalShipmentIds[0] ?? nullableText(firstExchangeItem.originalShipmentBoxId),
    externalShipmentIds,
    scopeIntegrityStatus:
      externalShipmentIds.length > 0 ? "VALID" : "MISSING_SCOPE",
    exchangeStatus: nullableText(value.exchangeStatus),
    faultByType: normalizeCoupangClaimFault(
      value.faultType ?? value.faultByType
    ),
    reasonCode: nullableText(value.reasonCode),
    reasonLabel: nullableText(value.reasonCodeText),
    reasonDetail: normalizeCoupangClaimReasonDetail(
      value.reasonEtcDetail ?? value.reasonDetail
    ),
    externalCreatedAt: externalCreatedAt.value,
    externalModifiedAt: externalModifiedAt.value,
    invalidTimestampCount: [externalCreatedAt, externalModifiedAt].filter(
      (timestamp) => timestamp.invalid
    ).length,
  };
}

export function normalizeReturnWithdrawal(
  value: unknown
): NormalizedCoupangReturnWithdrawal {
  if (!isRecord(value)) {
    throw new Error("쿠팡 반품 철회 요청 형식이 올바르지 않습니다.");
  }

  const externalWithdrawnAt = normalizeExternalClaimTimestamp(value.createdAt);

  return {
    externalReceiptId: requiredText(value.cancelId, "cancelId"),
    externalOrderId: nullableText(value.orderId),
    externalWithdrawnAt: externalWithdrawnAt.value,
    refundDeliveryDuty: normalizeCoupangRefundDeliveryDuty(
      value.refundDeliveryDuty
    ),
    vendorItemIds: normalizeCoupangWithdrawalVendorItemIds(value.vendorItemIds),
    invalidTimestampCount: externalWithdrawnAt.invalid ? 1 : 0,
  };
}

export function returnWithdrawalsFromPayload(payload: unknown) {
  return validateCoupangReturnWithdrawalPage(payload).withdrawals;
}

export function nextWithdrawalPageIndexFromPayload(payload: unknown) {
  const pageIndex = validateCoupangReturnWithdrawalPage(payload).nextPageIndex;
  return pageIndex;
}

async function ensureProductMapping(
  tx: Prisma.TransactionClient,
  item: NormalizedCoupangOrderItem,
  now: DatabaseDateTime
) {
  const mappingKey = {
    channel: COUPANG_CHANNEL,
    external_vendor_item_id: item.externalVendorItemId,
  };

  await tx.$queryRaw`
    SELECT mapping_id
    FROM sales_channel_product_mappings
    WHERE channel = ${mappingKey.channel}
      AND external_vendor_item_id = ${mappingKey.external_vendor_item_id}
    FOR UPDATE
  `;
  let mapping = await tx.sales_channel_product_mappings.findUnique({
    where: { channel_external_vendor_item_id: mappingKey },
  });

  if (!mapping) {
    mapping = await tx.sales_channel_product_mappings.upsert({
      where: { channel_external_vendor_item_id: mappingKey },
      create: {
        ...mappingKey,
        external_product_id: item.sellerProductId,
        external_option_name: item.sellerProductItemName,
        mapping_status: "UNMAPPED",
        created_at: now,
        updated_at: now,
      },
      update: {
        external_product_id: item.sellerProductId,
        external_option_name: item.sellerProductItemName,
        updated_at: now,
      },
    });
  } else if (
    mapping.external_product_id !== item.sellerProductId ||
    mapping.external_option_name !== item.sellerProductItemName
  ) {
    mapping = await tx.sales_channel_product_mappings.update({
      where: { mapping_id: mapping.mapping_id },
      data: {
        external_product_id: item.sellerProductId,
        external_option_name: item.sellerProductItemName,
        updated_at: now,
      },
    });
  }

  if (
    mapping.mapping_status !== MAPPING_STATUS.mapped ||
    !mapping.sales_offer_id
  ) {
    return {
      channel: COUPANG_CHANNEL,
      externalVendorItemId: item.externalVendorItemId,
      mappingStatus: MAPPING_STATUS.unmapped,
      salesOfferId: null,
      salesOfferCode: null,
      requiredModel: null,
      requiredStorage: null,
      requiredColor: null,
      requiredWarrantyGroup: null,
      matchingFailureReason: MATCHING_FAILURE_REASON.salesOfferNotMapped,
    };
  }

  const offer = await getSalesOfferMatchingDefinition(
    tx,
    mapping.sales_offer_id
  );

  if (!offer) {
    return {
      channel: COUPANG_CHANNEL,
      externalVendorItemId: item.externalVendorItemId,
      mappingStatus: MAPPING_STATUS.unmapped,
      salesOfferId: null,
      salesOfferCode: null,
      requiredModel: null,
      requiredStorage: null,
      requiredColor: null,
      requiredWarrantyGroup: null,
      matchingFailureReason: MATCHING_FAILURE_REASON.salesOfferNotFound,
    };
  }

  return {
    channel: COUPANG_CHANNEL,
    externalVendorItemId: item.externalVendorItemId,
    mappingStatus: MAPPING_STATUS.mapped,
    salesOfferId: offer.salesOfferId,
    salesOfferCode: offer.offerCode,
    requiredModel: offer.model,
    requiredStorage: offer.requiredStorage,
    requiredColor: offer.requiredColor,
    requiredWarrantyGroup: offer.requiredWarrantyGroup,
    matchingFailureReason: null,
  };
}

async function upsertOrderRawSnapshot(
  tx: Prisma.TransactionClient,
  order: NormalizedCoupangOrder,
  now: DatabaseDateTime,
  projectionRevision: number,
  apiCallLogId: number | null = null
) {
  const maskPersonalData = await shouldMaskOrderPersonalDataOnSync(tx, {
    externalOrderId: order.externalOrderId,
    externalShipmentId: order.externalShipmentId,
    referenceDate: parseKstSqlDateTime(now) ?? quickHackClock.nowDate(),
  });
  const storedOrder = maskPersonalData
    ? maskOrderPersonalData(order)
    : order;
  const splitShipping =
    storedOrder.splitShipping == null
      ? null
      : storedOrder.splitShipping
        ? 1
        : 0;
  const orderedAt = databaseDateTimeOrNull(storedOrder.orderedAt);
  const paidAt = databaseDateTimeOrNull(storedOrder.paidAt);
  const invoiceUploadedAt = databaseDateTimeOrNull(
    storedOrder.invoiceUploadedAt
  );
  const deliveredAt = databaseDateTimeOrNull(storedOrder.deliveredAt);
  const validProviderDeliveryTime =
    order.channelStatus === "FINAL_DELIVERY" &&
    deliveredAt !== null &&
    deliveredAt.getTime() <= now.getTime();
  const observedDeliveryOccurredAt =
    order.channelStatus === "FINAL_DELIVERY"
      ? validProviderDeliveryTime
        ? deliveredAt
        : now
      : null;
  const observedDeliveryTimeSource =
    order.channelStatus === "FINAL_DELIVERY"
      ? validProviderDeliveryTime
        ? "COUPANG_DELIVERED_DATE"
        : "SYNC_RECEIVED_AT_FALLBACK"
      : null;
  let existingOrder = await tx.coupang_order_raw.findUnique({
    where: {
      external_order_id_external_shipment_id: {
        external_order_id: order.externalOrderId,
        external_shipment_id: order.externalShipmentId,
      },
    },
  });
  let appliedOrderId: number;

  while (true) {
    if (existingOrder) {
      if (existingOrder.projection_revision >= projectionRevision) {
        return false;
      }
      const nextDeliveryOccurredAt = validProviderDeliveryTime
        ? existingOrder.delivery_time_source === "COUPANG_DELIVERED_DATE" &&
          existingOrder.delivery_occurred_at
          ? new Date(
              Math.min(
                existingOrder.delivery_occurred_at.getTime(),
                deliveredAt.getTime()
              )
            )
          : deliveredAt
        : existingOrder.delivery_occurred_at ?? observedDeliveryOccurredAt;
      const nextDeliveryTimeSource = validProviderDeliveryTime
        ? "COUPANG_DELIVERED_DATE"
        : existingOrder.delivery_time_source ?? observedDeliveryTimeSource;
      const updated = await tx.coupang_order_raw.updateMany({
        where: {
          coupang_order_raw_id: existingOrder.coupang_order_raw_id,
          projection_revision: existingOrder.projection_revision,
        },
        data: {
          external_order_status: storedOrder.channelStatus,
          ordered_at: orderedAt,
          paid_at: paidAt,
          orderer_name: storedOrder.ordererName,
          receiver_name: storedOrder.receiverName,
          receiver_safe_number: storedOrder.receiverSafeNumber,
          receiver_address_1: storedOrder.receiverAddress1,
          receiver_address_2: storedOrder.receiverAddress2,
          receiver_post_code: storedOrder.receiverPostCode,
          shipping_memo: storedOrder.shippingMemo,
          delivery_company_name: storedOrder.deliveryCompanyName,
          invoice_number: storedOrder.invoiceNumber,
          invoice_uploaded_at: invoiceUploadedAt,
          split_shipping: splitShipping,
          delivered_at: deliveredAt,
          delivery_occurred_at: nextDeliveryOccurredAt,
          delivery_time_source: nextDeliveryTimeSource,
          projection_revision: projectionRevision,
          synced_at: now,
          updated_at: now,
        },
      });
      if (updated.count === 1) {
        appliedOrderId = existingOrder.coupang_order_raw_id;
        break;
      }
    } else {
      const inserted = await tx.$queryRaw<
        Array<{ coupang_order_raw_id: number }>
      >`
        INSERT INTO coupang_order_raw (
          external_order_id, external_shipment_id, external_order_status,
          ordered_at, paid_at, orderer_name, receiver_name,
          receiver_safe_number, receiver_address_1, receiver_address_2,
          receiver_post_code, shipping_memo, delivery_company_name,
          invoice_number, invoice_uploaded_at, split_shipping,
          delivered_at, delivery_occurred_at, delivery_time_source,
          projection_revision, synced_at, created_at, updated_at
        ) VALUES (
          ${order.externalOrderId}, ${order.externalShipmentId}, ${storedOrder.channelStatus},
          ${orderedAt}, ${paidAt}, ${storedOrder.ordererName}, ${storedOrder.receiverName},
          ${storedOrder.receiverSafeNumber}, ${storedOrder.receiverAddress1}, ${storedOrder.receiverAddress2},
          ${storedOrder.receiverPostCode}, ${storedOrder.shippingMemo}, ${storedOrder.deliveryCompanyName},
          ${storedOrder.invoiceNumber}, ${invoiceUploadedAt}, ${splitShipping},
          ${deliveredAt}, ${observedDeliveryOccurredAt}, ${observedDeliveryTimeSource},
          ${projectionRevision}, ${now}, ${now}, ${now}
        )
        ON CONFLICT (external_order_id, external_shipment_id) DO NOTHING
        RETURNING coupang_order_raw_id
      `;
      if (inserted.length === 1) {
        appliedOrderId = inserted[0].coupang_order_raw_id;
        break;
      }
    }

    existingOrder = await tx.coupang_order_raw.findUnique({
      where: {
        external_order_id_external_shipment_id: {
          external_order_id: order.externalOrderId,
          external_shipment_id: order.externalShipmentId,
        },
      },
    });
  }

  let eventOrder = storedOrder;
  if (order.channelStatus === "FINAL_DELIVERY") {
    const canonicalDeliveryOccurredAt = observedDeliveryOccurredAt ?? now;
    await recordPersonalDataDeliveryCompletion(tx, {
      externalOrderId: order.externalOrderId,
      externalShipmentId: order.externalShipmentId,
      completedAt: canonicalDeliveryOccurredAt,
      now,
    });
    const maskAfterCompletion = await shouldMaskOrderPersonalDataOnSync(tx, {
      externalOrderId: order.externalOrderId,
      externalShipmentId: order.externalShipmentId,
      referenceDate: parseKstSqlDateTime(now) ?? quickHackClock.nowDate(),
    });
    if (maskAfterCompletion && !maskPersonalData) {
      eventOrder = maskOrderPersonalData(order);
      await tx.coupang_order_raw.updateMany({
        where: {
          coupang_order_raw_id: appliedOrderId,
          projection_revision: projectionRevision,
        },
        data: {
          orderer_name: eventOrder.ordererName,
          receiver_name: eventOrder.receiverName,
          receiver_safe_number: eventOrder.receiverSafeNumber,
          receiver_address_1: eventOrder.receiverAddress1,
          receiver_address_2: eventOrder.receiverAddress2,
          receiver_post_code: eventOrder.receiverPostCode,
          shipping_memo: eventOrder.shippingMemo,
        },
      });
    }
  }

  await createShipmentAddressChangeEvent(tx, {
    existingOrder,
    order: eventOrder,
    now,
    apiCallLogId,
  });

  return true;
}

async function upsertOrder(
  tx: Prisma.TransactionClient,
  order: NormalizedCoupangOrder,
  now: DatabaseDateTime,
  projectionRevision: number,
  apiCallLogId: number | null = null
) {
  const applied = await upsertOrderRawSnapshot(
    tx,
    order,
    now,
    projectionRevision,
    apiCallLogId
  );

  if (!applied) {
    return { applied: false, shipments: 0, items: 0 };
  }
  const orderedAt = databaseDateTimeOrNull(order.orderedAt);

  for (const item of order.items) {
      const mapping = await ensureProductMapping(tx, item, now);
      const mappingSnapshot = {
        mappingStatus: mapping.mappingStatus,
        salesOfferId: mapping.salesOfferId,
        mappingFailureReason: mapping.matchingFailureReason,
        requiredModelLabel: mapping.requiredModel,
        requiredStorageLabel: mapping.requiredStorage,
        requiredColorLabel: mapping.requiredColor,
        requiredWarrantyGroup: mapping.requiredWarrantyGroup,
      };
      const workState = derivePreMatchWorkState(
        {
          canceled: item.canceled,
          matchable_quantity: item.availableQuantity,
        },
        mappingSnapshot
      );

      const workItem = await tx.order_matching_work_queue.upsert({
        where: {
          channel_external_order_id_external_shipment_id_external_vendor_item_id: {
            channel: COUPANG_CHANNEL,
            external_order_id: order.externalOrderId,
            external_shipment_id: order.externalShipmentId,
            external_vendor_item_id: item.externalVendorItemId,
          },
        },
        create: {
          channel: COUPANG_CHANNEL,
          external_order_id: order.externalOrderId,
          external_shipment_id: order.externalShipmentId,
          external_vendor_item_id: item.externalVendorItemId,
          vendor_item_name: item.vendorItemName,
          seller_product_id: item.sellerProductId,
          seller_product_name: item.sellerProductName,
          seller_product_item_name: item.sellerProductItemName,
          external_vendor_sku_code: item.externalVendorSkuCode,
          sales_price: item.salesPrice,
          ordered_quantity: item.shippingCount,
          cancel_hold_quantity: item.holdCountForCancel,
          canceled_quantity: item.cancelCount,
          canceled: item.canceled,
          matchable_quantity: item.availableQuantity,
          ordered_at: orderedAt,
          mapping_status: mapping.mappingStatus,
          sales_offer_id: mapping.salesOfferId,
          required_model_label: mapping.requiredModel,
          required_storage_label: mapping.requiredStorage,
          required_color_label: mapping.requiredColor,
          required_warranty_group: mapping.requiredWarrantyGroup,
          mapping_failure_reason: mapping.matchingFailureReason,
          work_status: workState.workStatus,
          work_failure_reason: workState.workFailureReason,
          created_at: now,
          updated_at: now,
        },
        update: {
          vendor_item_name: item.vendorItemName,
          seller_product_id: item.sellerProductId,
          seller_product_name: item.sellerProductName,
          seller_product_item_name: item.sellerProductItemName,
          external_vendor_sku_code: item.externalVendorSkuCode,
          sales_price: item.salesPrice,
          ordered_quantity: item.shippingCount,
          cancel_hold_quantity: item.holdCountForCancel,
          canceled_quantity: item.cancelCount,
          canceled: item.canceled,
          matchable_quantity: item.availableQuantity,
          ordered_at: orderedAt,
          updated_at: now,
        },
      });

      await synchronizeWorkItemMappingSnapshot({
        tx,
        workItemId: workItem.work_item_id,
        snapshot: mappingSnapshot,
        timestamp: now,
      });
    }

  return {
    applied: true,
    shipments: 1,
    items: order.items.length,
  };
}

type ClaimPersistenceContext = {
  syncedAt: DatabaseDateTime;
  observedAt: DatabaseDateTime;
  projectionRevision: number;
  apiCallLogId?: number | null;
  workerJobId?: number | null;
  sourceEvidenceId?: string | null;
};

async function ensureCoupangOrderReference(
  tx: Prisma.TransactionClient,
  input: {
    externalOrderId: string;
    externalShipmentId: string | null;
    timestamp: DatabaseDateTime;
  }
) {
  if (!input.externalShipmentId) return;

  await tx.$executeRaw`
    INSERT INTO coupang_order_raw (
      external_order_id, external_shipment_id, projection_revision,
      synced_at, created_at, updated_at
    ) VALUES (
      ${input.externalOrderId}, ${input.externalShipmentId}, 0,
      ${input.timestamp}, ${input.timestamp}, ${input.timestamp}
    )
    ON CONFLICT (external_order_id, external_shipment_id) DO NOTHING
  `;
}

function returnHistorySnapshot(
  returnRequest: NormalizedCoupangReturn
): CoupangReturnHistorySnapshot {
  return {
    external_created_at: returnRequest.externalCreatedAt,
    external_modified_at: returnRequest.externalModifiedAt,
    external_completed_at: returnRequest.externalCompletedAt,
    external_completion_type: returnRequest.externalCompletionType,
    receipt_type: returnRequest.receiptType,
    receipt_status: returnRequest.receiptStatus,
    release_status: returnRequest.releaseStatus,
    fault_by_type: returnRequest.faultByType,
    reason_code: returnRequest.reasonCode,
    reason_label: returnRequest.reasonLabel,
    reason_category: returnRequest.reasonCategory,
    reason_detail: returnRequest.historyReasonDetail,
    cancel_count: String(Math.max(0, returnRequest.cancelCount)),
  };
}

function exchangeHistorySnapshot(
  exchangeRequest: NormalizedCoupangExchange
): CoupangExchangeHistorySnapshot {
  return {
    external_created_at: exchangeRequest.externalCreatedAt,
    external_modified_at: exchangeRequest.externalModifiedAt,
    exchange_status: exchangeRequest.exchangeStatus,
    fault_by_type: exchangeRequest.faultByType,
    reason_code: exchangeRequest.reasonCode,
    reason_label: exchangeRequest.reasonLabel,
    reason_detail: exchangeRequest.reasonDetail,
  };
}

function withdrawalHistorySnapshot(
  withdrawal: NormalizedCoupangReturnWithdrawal
): CoupangReturnWithdrawalSnapshot {
  return {
    external_withdrawn_at: withdrawal.externalWithdrawnAt,
    refund_delivery_duty: withdrawal.refundDeliveryDuty,
    vendor_item_ids: withdrawal.vendorItemIds,
  };
}

async function reconcileReturnWritesForWithdrawal(
  tx: Prisma.TransactionClient,
  input: { externalReceiptId: string; occurredAt: Date }
) {
  const requestTypes = [
    SALES_CHANNEL_WRITE_REQUEST_TYPE.returnStoppedShipment,
    SALES_CHANNEL_WRITE_REQUEST_TYPE.returnReceiveConfirmation,
    SALES_CHANNEL_WRITE_REQUEST_TYPE.returnApproval,
  ];
  const requests = await tx.sales_channel_write_requests.findMany({
    where: {
      channel: COUPANG_CHANNEL,
      source_entity_type: "COUPANG_RETURN_RECEIPT",
      source_entity_id: input.externalReceiptId,
      request_type: { in: requestTypes },
      request_status: {
        notIn: [
          SALES_CHANNEL_WRITE_REQUEST_STATUS.notApplied,
          SALES_CHANNEL_WRITE_REQUEST_STATUS.rejected,
        ],
      },
    },
    orderBy: { sales_channel_write_request_id: "asc" },
  });

  for (const request of requests) {
    await tx.$queryRaw`
      SELECT sales_channel_write_request_id
      FROM sales_channel_write_requests
      WHERE sales_channel_write_request_id = ${request.sales_channel_write_request_id}
      FOR UPDATE
    `;
    const current = await tx.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
      },
    });
    const writeAttempt = await tx.sales_channel_write_request_attempts.findFirst({
      where: {
        sales_channel_write_request_id:
          request.sales_channel_write_request_id,
        attempt_type: "WRITE",
      },
      orderBy: { attempt_no: "desc" },
    });
    const canCancelBeforeDispatch =
      writeAttempt?.request_dispatched === 0 &&
      writeAttempt.completed_at === null &&
      (current.request_status === SALES_CHANNEL_WRITE_REQUEST_STATUS.pending ||
        current.request_status === SALES_CHANNEL_WRITE_REQUEST_STATUS.sending);

    if (canCancelBeforeDispatch && writeAttempt) {
      await tx.sales_channel_write_request_targets.updateMany({
        where: {
          sales_channel_write_request_id:
            request.sales_channel_write_request_id,
          external_result_status:
            SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.pending,
        },
        data: {
          external_result_status:
            SALES_CHANNEL_WRITE_TARGET_EXTERNAL_STATUS.notApplied,
          external_result_code: "RETURN_WITHDRAWN",
          external_result_message:
            "반품 철회가 외부 호출 전에 확인되어 요청을 취소했습니다.",
          result_received_at: input.occurredAt,
          local_finalization_status:
            SALES_CHANNEL_WRITE_TARGET_LOCAL_STATUS.notRequired,
        },
      });
      await tx.sales_channel_write_requests.update({
        where: {
          sales_channel_write_request_id:
            request.sales_channel_write_request_id,
        },
        data: {
          request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.rejected,
          failure_stage: SALES_CHANNEL_WRITE_FAILURE_STAGE.writeTransport,
          error_code: "RETURN_WITHDRAWN",
          error_message:
            "반품 철회가 외부 호출 전에 확인되어 요청을 취소했습니다.",
          revision: { increment: 1 },
          updated_at: input.occurredAt,
        },
      });
      await tx.sales_channel_write_request_attempts.update({
        where: {
          sales_channel_write_request_attempt_id:
            writeAttempt.sales_channel_write_request_attempt_id,
        },
        data: {
          attempt_status: SALES_CHANNEL_WRITE_ATTEMPT_STATUS.failed,
          completed_at: input.occurredAt,
          error_code: "RETURN_WITHDRAWN",
          error_message:
            "반품 철회가 외부 호출 전에 확인되어 요청을 취소했습니다.",
        },
      });
      continue;
    }

    if (
      current.request_status === SALES_CHANNEL_WRITE_REQUEST_STATUS.completed ||
      current.request_status ===
        SALES_CHANNEL_WRITE_REQUEST_STATUS.partiallyCompleted
    ) {
      await tx.sales_channel_write_requests.update({
        where: {
          sales_channel_write_request_id:
            request.sales_channel_write_request_id,
        },
        data: {
          request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
          failure_stage: SALES_CHANNEL_WRITE_FAILURE_STAGE.localFinalization,
          error_code: "RETURN_WITHDRAWAL_RACE",
          error_message:
            "완료된 반품 쓰기와 철회가 함께 관찰되어 자동 보정하지 않습니다.",
          review_required_at: input.occurredAt,
          revision: { increment: 1 },
          updated_at: input.occurredAt,
        },
      });
    }
  }
}

async function upsertReturnWithdrawalProjection(
  tx: Prisma.TransactionClient,
  withdrawal: NormalizedCoupangReturnWithdrawal,
  context: ClaimPersistenceContext
) {
  const externalWithdrawnAt = databaseDateTimeOrNull(
    withdrawal.externalWithdrawnAt
  );
  const applied = await tx.$queryRaw<Array<{ coupang_return_withdrawal_id: number }>>`
    INSERT INTO coupang_return_withdrawal (
      external_receipt_id, external_order_id, external_withdrawn_at,
      refund_delivery_duty, vendor_item_ids, projection_revision,
      source_evidence_id, observed_at, created_at, updated_at
    ) VALUES (
      ${withdrawal.externalReceiptId}, ${withdrawal.externalOrderId}, ${externalWithdrawnAt},
      ${withdrawal.refundDeliveryDuty}, ${withdrawal.vendorItemIds}, ${context.projectionRevision},
      ${context.sourceEvidenceId ?? null}::uuid, ${context.observedAt}, ${context.syncedAt}, ${context.syncedAt}
    )
    ON CONFLICT (external_receipt_id) DO UPDATE SET
      external_order_id = excluded.external_order_id,
      external_withdrawn_at = excluded.external_withdrawn_at,
      refund_delivery_duty = excluded.refund_delivery_duty,
      vendor_item_ids = excluded.vendor_item_ids,
      projection_revision = excluded.projection_revision,
      source_evidence_id = excluded.source_evidence_id,
      observed_at = excluded.observed_at,
      updated_at = excluded.updated_at
    WHERE coupang_return_withdrawal.projection_revision < excluded.projection_revision
    RETURNING coupang_return_withdrawal_id
  `;
  if (applied.length === 1) {
    await reconcileReturnWritesForWithdrawal(tx, {
      externalReceiptId: withdrawal.externalReceiptId,
      occurredAt: context.syncedAt,
    });
  }
  return applied.length === 1;
}

async function upsertReturnRequest(
  tx: Prisma.TransactionClient,
  returnRequest: NormalizedCoupangReturn,
  context: ClaimPersistenceContext
) {
  const now = context.syncedAt;

  if (!returnRequest.externalOrderId) {
    throw new Error(
      `Coupang return ${returnRequest.externalReceiptId} is missing externalOrderId.`
    );
  }

  const returnShipmentIds = Array.from(
    new Set(
      returnRequest.items
        .map((item) => item.externalShipmentId)
        .filter((value): value is string => Boolean(value))
    )
  ).sort();
  const canonicalShipmentId = returnShipmentIds[0] ?? null;
  if (
    !canonicalShipmentId ||
    returnRequest.items.length === 0 ||
    returnRequest.items.some(
      (item) =>
        !item.externalShipmentId ||
        !item.externalVendorItemId ||
        !Number.isInteger(item.cancelCount) ||
        item.cancelCount <= 0
    )
  ) {
    throw new Error(
      `Coupang return ${returnRequest.externalReceiptId} has incomplete item scope.`
    );
  }
  const canonicalReturnRequest =
    returnRequest.externalShipmentId === canonicalShipmentId
      ? returnRequest
      : { ...returnRequest, externalShipmentId: canonicalShipmentId };
  for (const externalShipmentId of returnShipmentIds) {
    await ensureCoupangOrderReference(tx, {
      externalOrderId: returnRequest.externalOrderId,
      externalShipmentId,
      timestamp: now,
    });
  }

  const applied = await tx.$queryRaw<
    Array<{ coupang_return_raw_id: number }>
  >`
    INSERT INTO coupang_return_raw (
      external_receipt_id, external_order_id, external_shipment_id,
      cancel_type, return_receipt_status, return_release_status,
      reason_code, reason_label, reason_category, reason_detail,
      cancel_count, item_integrity_status, projection_revision, synced_at, created_at, updated_at
    ) VALUES (
      ${canonicalReturnRequest.externalReceiptId}, ${canonicalReturnRequest.externalOrderId}, ${canonicalReturnRequest.externalShipmentId},
      ${canonicalReturnRequest.cancelType}, ${canonicalReturnRequest.receiptStatus}, ${canonicalReturnRequest.releaseStatus},
      ${canonicalReturnRequest.reasonCode}, ${canonicalReturnRequest.reasonLabel}, ${canonicalReturnRequest.reasonCategory}, ${canonicalReturnRequest.reasonDetail},
      ${canonicalReturnRequest.cancelCount}, ${canonicalReturnRequest.itemIntegrityStatus}, ${context.projectionRevision}, ${now}, ${now}, ${now}
    )
    ON CONFLICT(external_receipt_id) DO UPDATE SET
      external_order_id = excluded.external_order_id,
      external_shipment_id = excluded.external_shipment_id,
      cancel_type = excluded.cancel_type,
      return_receipt_status = excluded.return_receipt_status,
      return_release_status = excluded.return_release_status,
      reason_code = excluded.reason_code,
      reason_label = excluded.reason_label,
      reason_category = excluded.reason_category,
      reason_detail = excluded.reason_detail,
      cancel_count = excluded.cancel_count,
      item_integrity_status = excluded.item_integrity_status,
      projection_revision = excluded.projection_revision,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
    WHERE coupang_return_raw.projection_revision < excluded.projection_revision
    RETURNING coupang_return_raw_id
  `;

  if (applied.length === 0) {
    return null;
  }
  const returnRow = applied[0];

  await tx.coupang_return_raw_item.deleteMany({
    where: {
      coupang_return_raw_id: returnRow.coupang_return_raw_id,
    },
  });

  const itemRequirements = new Map<
    string,
    NormalizedCoupangReturnItem
  >();
  for (const item of returnRequest.items) {
    const shipmentId = item.externalShipmentId;
    const vendorItemId = item.externalVendorItemId;
    const key = `${shipmentId ?? ""}\u0000${vendorItemId ?? ""}`;
    const existing = itemRequirements.get(key);
    itemRequirements.set(
      key,
      existing
        ? { ...existing, cancelCount: existing.cancelCount + item.cancelCount }
        : { ...item, externalShipmentId: shipmentId }
    );
  }
  for (const item of itemRequirements.values()) {
    await tx.coupang_return_raw_item.create({
      data: {
        coupang_return_raw_id: returnRow.coupang_return_raw_id,
        external_receipt_id: returnRequest.externalReceiptId,
        external_order_id: returnRequest.externalOrderId,
        external_shipment_id:
          item.externalShipmentId,
        external_vendor_item_id: item.externalVendorItemId,
        seller_product_item_id: item.sellerProductItemId,
        vendor_item_name: item.vendorItemName,
        cancel_count: item.cancelCount,
        reason_code: item.reasonCode,
        reason_label: item.reasonLabel,
        created_at: now,
        updated_at: now,
      },
    });
  }

  const history = await recordReturnObservation({
    tx,
    externalReceiptId: canonicalReturnRequest.externalReceiptId,
    externalOrderId: canonicalReturnRequest.externalOrderId,
    externalShipmentId: canonicalReturnRequest.externalShipmentId,
    snapshot: returnHistorySnapshot(canonicalReturnRequest),
    observedAt: context.observedAt,
    apiCallLogId: context.apiCallLogId ?? null,
    workerJobId: context.workerJobId ?? null,
  });
  if (returnShipmentIds.length === 0) {
    await reconcilePersonalDataLifecyclesForOrder(tx, {
      externalOrderId: returnRequest.externalOrderId,
      now,
    });
  } else {
    for (const externalShipmentId of returnShipmentIds) {
      await reconcilePersonalDataLifecyclesForOrder(tx, {
        externalOrderId: returnRequest.externalOrderId,
        externalShipmentId,
        now,
      });
    }
  }
  return history;
}

export async function persistCoupangOrderRawSnapshots(
  orders: readonly NormalizedCoupangOrder[],
  observation: SalesChannelProjectionObservation,
  syncedAt: DateTimeInput = databaseNow()
) {
  if (orders.length === 0) {
    return { orders: 0, staleSnapshotCount: 0 };
  }

  return runMeasuredTransaction(
    prisma,
    "coupang.targeted-order-snapshots",
    (tx) =>
      persistCoupangOrderRawSnapshotsInTransaction(
        tx,
        orders,
        observation,
        syncedAt
      ),
    {
      maxWait: SYNC_PAGE_TRANSACTION_MAX_WAIT_MS,
      timeout: SYNC_PAGE_TRANSACTION_TIMEOUT_MS,
    }
  );
}

export async function persistCoupangOrderRawSnapshotsInTransaction(
  tx: Prisma.TransactionClient,
  orders: readonly NormalizedCoupangOrder[],
  observation: SalesChannelProjectionObservation,
  syncedAt: DateTimeInput = databaseNow()
) {
  const persistenceTime = databaseDateTime(syncedAt);
  let appliedCount = 0;
  for (const order of orders) {
    const applied = await upsertOrderRawSnapshot(
      tx,
      order,
      persistenceTime,
      observation.revision
    );
    appliedCount += applied ? 1 : 0;
  }

  return {
    orders: appliedCount,
    staleSnapshotCount: orders.length - appliedCount,
  };
}

export type CoupangOrderAddressSnapshotPersistResult = {
  targetCount: number;
  refreshedTargetCount: number;
  staleTargetCount: number;
  missingTargetCount: number;
  eventCreatedCount: number;
};

export async function persistCoupangOrderAddressSnapshotsInTransaction(
  tx: Prisma.TransactionClient,
  orders: readonly NormalizedCoupangOrder[],
  observation: SalesChannelProjectionObservation,
  observedAt: DateTimeInput = databaseNow()
): Promise<CoupangOrderAddressSnapshotPersistResult> {
  const persistenceTime = databaseDateTime(observedAt);
  const result: CoupangOrderAddressSnapshotPersistResult = {
    targetCount: orders.length,
    refreshedTargetCount: 0,
    staleTargetCount: 0,
    missingTargetCount: 0,
    eventCreatedCount: 0,
  };

  for (const order of orders) {
    const existingOrder = await tx.coupang_order_raw.findUnique({
      where: {
        external_order_id_external_shipment_id: {
          external_order_id: order.externalOrderId,
          external_shipment_id: order.externalShipmentId,
        },
      },
    });

    if (!existingOrder) {
      result.missingTargetCount += 1;
      continue;
    }

    if (existingOrder.projection_revision >= observation.revision) {
      result.staleTargetCount += 1;
      continue;
    }

    const maskPersonalData = await shouldMaskOrderPersonalDataOnSync(tx, {
      externalOrderId: order.externalOrderId,
      externalShipmentId: order.externalShipmentId,
      referenceDate:
        persistenceTime,
    });
    const storedOrder = maskPersonalData
      ? maskOrderPersonalData(order)
      : order;
    const updated = await tx.coupang_order_raw.updateMany({
      where: {
        coupang_order_raw_id: existingOrder.coupang_order_raw_id,
        projection_revision: existingOrder.projection_revision,
        external_order_status: existingOrder.external_order_status,
        receiver_name: existingOrder.receiver_name,
        receiver_safe_number: existingOrder.receiver_safe_number,
        receiver_address_1: existingOrder.receiver_address_1,
        receiver_address_2: existingOrder.receiver_address_2,
        receiver_post_code: existingOrder.receiver_post_code,
        shipping_memo: existingOrder.shipping_memo,
      },
      data: {
        receiver_name: storedOrder.receiverName,
        receiver_safe_number: storedOrder.receiverSafeNumber,
        receiver_address_1: storedOrder.receiverAddress1,
        receiver_address_2: storedOrder.receiverAddress2,
        receiver_post_code: storedOrder.receiverPostCode,
        shipping_memo: storedOrder.shippingMemo,
        projection_revision: observation.revision,
        updated_at: persistenceTime,
      },
    });

    if (updated.count !== 1) {
      result.staleTargetCount += 1;
      continue;
    }

    const eventCreated = await createShipmentAddressChangeEvent(tx, {
      existingOrder,
      order: {
        ...storedOrder,
        channelStatus: existingOrder.external_order_status,
      },
      now: persistenceTime,
    });
    result.refreshedTargetCount += 1;
    result.eventCreatedCount += eventCreated ? 1 : 0;
  }

  return result;
}

export async function persistCoupangReturnRawSnapshots(
  returns: readonly NormalizedCoupangReturn[],
  observation: SalesChannelProjectionObservation,
  syncedAt: DateTimeInput = databaseNow()
) {
  if (returns.length === 0) {
    return {
      returns: 0,
      eventCreatedCount: 0,
      noOpCount: 0,
      invalidTimestampCount: 0,
      staleSnapshotCount: 0,
    };
  }

  return runMeasuredTransaction(
    prisma,
    "coupang.targeted-return-snapshots",
    (tx) =>
      persistCoupangReturnRawSnapshotsInTransaction(
        tx,
        returns,
        observation,
        syncedAt
      ),
    {
      maxWait: SYNC_PAGE_TRANSACTION_MAX_WAIT_MS,
      timeout: SYNC_PAGE_TRANSACTION_TIMEOUT_MS,
    }
  );
}

export async function persistCoupangReturnRawSnapshotsInTransaction(
  tx: Prisma.TransactionClient,
  returns: readonly NormalizedCoupangReturn[],
  observation: SalesChannelProjectionObservation,
  syncedAt: DateTimeInput = databaseNow()
) {
  const persistenceTime = databaseDateTime(syncedAt);
  let eventCreatedCount = 0;
  let noOpCount = 0;
  let invalidTimestampCount = 0;
  let staleSnapshotCount = 0;

  for (const returnRequest of returns) {
    const history = await upsertReturnRequest(tx, returnRequest, {
      syncedAt: persistenceTime,
      observedAt: persistenceTime,
      projectionRevision: observation.revision,
      apiCallLogId: null,
      workerJobId: null,
    });

    if (!history) {
      staleSnapshotCount += 1;
      continue;
    }
    eventCreatedCount += history.eventCreated ? 1 : 0;
    noOpCount += history.noOp ? 1 : 0;
    invalidTimestampCount += returnRequest.invalidTimestampCount;
  }

  return {
    returns: returns.length - staleSnapshotCount,
    eventCreatedCount,
    noOpCount,
    invalidTimestampCount,
    staleSnapshotCount,
  };
}

async function upsertExchangeRequest(
  tx: Prisma.TransactionClient,
  exchangeRequest: NormalizedCoupangExchange,
  context: ClaimPersistenceContext
) {
  const now = context.syncedAt;

  for (const externalShipmentId of exchangeRequest.externalShipmentIds) {
    await ensureCoupangOrderReference(tx, {
      externalOrderId: exchangeRequest.externalOrderId,
      externalShipmentId,
      timestamp: now,
    });
  }

  const applied = await tx.$queryRaw<
    Array<{ coupang_exchange_raw_id: number }>
  >`
    INSERT INTO coupang_exchange_raw (
      external_exchange_id, external_order_id, external_shipment_id,
      exchange_status, reason_code, reason_label, scope_integrity_status, projection_revision,
      synced_at, created_at, updated_at
    ) VALUES (
      ${exchangeRequest.externalExchangeId}, ${exchangeRequest.externalOrderId}, ${exchangeRequest.externalShipmentId},
      ${exchangeRequest.exchangeStatus}, ${exchangeRequest.reasonCode}, ${exchangeRequest.reasonLabel}, ${exchangeRequest.scopeIntegrityStatus}, ${context.projectionRevision},
      ${now}, ${now}, ${now}
    )
    ON CONFLICT(external_exchange_id) DO UPDATE SET
      external_order_id = excluded.external_order_id,
      external_shipment_id = excluded.external_shipment_id,
      exchange_status = excluded.exchange_status,
      reason_code = excluded.reason_code,
      reason_label = excluded.reason_label,
      scope_integrity_status = excluded.scope_integrity_status,
      projection_revision = excluded.projection_revision,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
    WHERE coupang_exchange_raw.projection_revision < excluded.projection_revision
    RETURNING coupang_exchange_raw_id
  `;

  if (applied.length === 0) {
    return null;
  }

  const exchangeRow = applied[0];
  await tx.coupang_exchange_shipment_scope.deleteMany({
    where: { coupang_exchange_raw_id: exchangeRow.coupang_exchange_raw_id },
  });
  if (exchangeRequest.externalShipmentIds.length > 0) {
    await tx.coupang_exchange_shipment_scope.createMany({
      data: exchangeRequest.externalShipmentIds.map((externalShipmentId) => ({
        coupang_exchange_raw_id: exchangeRow.coupang_exchange_raw_id,
        external_exchange_id: exchangeRequest.externalExchangeId,
        external_order_id: exchangeRequest.externalOrderId,
        external_shipment_id: externalShipmentId,
        created_at: now,
      })),
    });
  }

  const history = await recordExchangeObservation({
    tx,
    externalExchangeId: exchangeRequest.externalExchangeId,
    externalOrderId: exchangeRequest.externalOrderId,
    externalShipmentId: exchangeRequest.externalShipmentId,
    snapshot: exchangeHistorySnapshot(exchangeRequest),
    observedAt: context.observedAt,
    apiCallLogId: context.apiCallLogId ?? null,
    workerJobId: context.workerJobId ?? null,
  });
  if (exchangeRequest.externalShipmentIds.length === 0) {
    await reconcilePersonalDataLifecyclesForOrder(tx, {
      externalOrderId: exchangeRequest.externalOrderId,
      now,
    });
  } else {
    for (const externalShipmentId of exchangeRequest.externalShipmentIds) {
      await reconcilePersonalDataLifecyclesForOrder(tx, {
        externalOrderId: exchangeRequest.externalOrderId,
        externalShipmentId,
        now,
      });
    }
  }
  return history;
}

type ClaimProjectionContext = {
  apiCallLogId: number;
  projectionRevision: number;
  workerJobId: number | null;
};

function claimProjectionContext(value: Prisma.JsonValue | null): ClaimProjectionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Coupang claim projection context is missing.");
  }
  const context = value as Record<string, Prisma.JsonValue>;
  const apiCallLogId = Number(context.apiCallLogId);
  const projectionRevision = Number(context.projectionRevision);
  const rawWorkerJobId = context.workerJobId;
  const workerJobId = rawWorkerJobId == null ? null : Number(rawWorkerJobId);
  if (
    !Number.isSafeInteger(apiCallLogId) ||
    apiCallLogId <= 0 ||
    !Number.isSafeInteger(projectionRevision) ||
    projectionRevision <= 0 ||
    (workerJobId !== null && (!Number.isSafeInteger(workerJobId) || workerJobId <= 0))
  ) {
    throw new Error("Coupang claim projection context is invalid.");
  }
  return { apiCallLogId, projectionRevision, workerJobId };
}

type ClaimProjectionResult = {
  rows: number;
  eventCreatedCount: number;
  noOpCount: number;
  invalidTimestampCount: number;
  staleSnapshotCount: number;
  unmatchedWithdrawalCount: number;
};

async function projectClaimEvidence(
  tx: Prisma.TransactionClient,
  evidence: Prisma.integration_evidencesGetPayload<Record<string, never>>,
  job: Prisma.integration_projection_jobsGetPayload<Record<string, never>>
): Promise<ClaimProjectionResult> {
  const context = claimProjectionContext(job.projection_context);
  const observedAt = evidence.received_at;
  const projectionContext: ClaimPersistenceContext = {
    syncedAt: observedAt,
    observedAt,
    projectionRevision: context.projectionRevision,
    apiCallLogId: context.apiCallLogId,
    workerJobId: context.workerJobId,
    sourceEvidenceId: evidence.integration_evidence_id,
  };
  const empty: ClaimProjectionResult = {
    rows: 0,
    eventCreatedCount: 0,
    noOpCount: 0,
    invalidTimestampCount: 0,
    staleSnapshotCount: 0,
    unmatchedWithdrawalCount: 0,
  };
  const normalized = evidence.normalized_result;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error("Validated Coupang claim evidence has no normalized page.");
  }

  if (job.handler_key === CLAIM_PROJECTION_HANDLER.returns) {
    const returns = (normalized as { returns?: unknown }).returns;
    if (!Array.isArray(returns)) throw new Error("Return evidence rows are invalid.");
    const result = { ...empty };
    for (const value of returns) {
      const returnRequest = value as NormalizedCoupangReturn;
      const history = await upsertReturnRequest(tx, returnRequest, projectionContext);
      if (!history) {
        result.staleSnapshotCount += 1;
        continue;
      }
      result.rows += 1;
      result.eventCreatedCount += history.eventCreated ? 1 : 0;
      result.noOpCount += history.noOp ? 1 : 0;
      result.invalidTimestampCount += returnRequest.invalidTimestampCount;
    }
    return result;
  }

  if (job.handler_key === CLAIM_PROJECTION_HANDLER.exchanges) {
    const exchanges = (normalized as { exchanges?: unknown }).exchanges;
    if (!Array.isArray(exchanges)) throw new Error("Exchange evidence rows are invalid.");
    const result = { ...empty };
    for (const value of exchanges) {
      const exchangeRequest = value as NormalizedCoupangExchange;
      const history = await upsertExchangeRequest(tx, exchangeRequest, projectionContext);
      if (!history) {
        result.staleSnapshotCount += 1;
        continue;
      }
      result.rows += 1;
      result.eventCreatedCount += history.eventCreated ? 1 : 0;
      result.noOpCount += history.noOp ? 1 : 0;
      result.invalidTimestampCount += exchangeRequest.invalidTimestampCount;
    }
    return result;
  }

  if (job.handler_key === CLAIM_PROJECTION_HANDLER.withdrawals) {
    const withdrawals = (normalized as { withdrawals?: unknown }).withdrawals;
    if (!Array.isArray(withdrawals)) throw new Error("Withdrawal evidence rows are invalid.");
    const result = { ...empty };
    for (const value of withdrawals) {
      const withdrawal = value as NormalizedCoupangReturnWithdrawal;
      if (!withdrawal.externalOrderId) {
        throw new Error(
          `Coupang withdrawal ${withdrawal.externalReceiptId} has no order id.`
        );
      }
      const applied = await upsertReturnWithdrawalProjection(
        tx,
        withdrawal,
        projectionContext
      );
      if (!applied) {
        result.staleSnapshotCount += 1;
        continue;
      }
      const history = await recordReturnWithdrawal({
        tx,
        externalReceiptId: withdrawal.externalReceiptId,
        externalOrderId: withdrawal.externalOrderId,
        snapshot: withdrawalHistorySnapshot(withdrawal),
        observedAt,
        apiCallLogId: context.apiCallLogId,
        workerJobId: context.workerJobId,
      });
      await reconcilePersonalDataLifecyclesForOrder(tx, {
        externalOrderId: withdrawal.externalOrderId,
        now: observedAt,
      });
      result.rows += 1;
      result.eventCreatedCount += history.eventCreated ? 1 : 0;
      result.noOpCount += history.noOp ? 1 : 0;
      result.unmatchedWithdrawalCount += history.unmatched ? 1 : 0;
      result.invalidTimestampCount += withdrawal.invalidTimestampCount;
    }
    return result;
  }

  throw new Error(`Unsupported Coupang claim projection handler: ${job.handler_key}`);
}

async function runCoupangClaimProjectionJob(jobId: string) {
  const claim = await claimIntegrationProjectionJobById({
    jobId,
    lockSeconds: CLAIM_PROJECTION_LOCK_SECONDS,
  });
  if (!claim) {
    const observed = await prisma.integration_projection_jobs.findUnique({
      where: { integration_projection_job_id: jobId },
      select: { projection_status: true },
    });
    if (observed?.projection_status === "SUCCEEDED") return null;
    throw new Error("Coupang claim projection job is owned by another worker.");
  }
  return runClaimedIntegrationProjection<ClaimProjectionResult>({
    claim,
    handler: (tx, evidence, _operationKey, job) =>
      projectClaimEvidence(tx, evidence, job),
  });
}

export async function drainCoupangClaimProjectionJobs(limit = 100) {
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const claim = await claimIntegrationProjectionJob({
      handlerKeys: CLAIM_PROJECTION_HANDLER_KEYS,
      lockSeconds: CLAIM_PROJECTION_LOCK_SECONDS,
    });
    if (!claim) break;
    await runClaimedIntegrationProjection({
      claim,
      handler: (tx, evidence, _operationKey, job) =>
        projectClaimEvidence(tx, evidence, job),
    });
  }
  return { processed };
}

type SyncCursorResultInput = {
  resource: string;
  statusFilter: string;
  windowFrom: string;
  windowTo: string;
  nextToken?: string | null;
  timestamp: DatabaseDateTime;
};

async function markSyncSuccess(input: SyncCursorResultInput) {
  await prisma.channel_sync_cursors.upsert({
    where: {
      channel_resource_status_filter: {
        channel: COUPANG_CHANNEL,
        resource: input.resource,
        status_filter: input.statusFilter,
      },
    },
    create: {
      channel: COUPANG_CHANNEL,
      resource: input.resource,
      status_filter: input.statusFilter,
      last_window_from: parseKstSqlDateTime(input.windowFrom),
      last_window_to: parseKstSqlDateTime(input.windowTo),
      next_token: null,
      last_success_at: input.timestamp,
      created_at: input.timestamp,
      updated_at: input.timestamp,
    },
    update: {
      last_window_from: parseKstSqlDateTime(input.windowFrom),
      last_window_to: parseKstSqlDateTime(input.windowTo),
      next_token: null,
      last_success_at: input.timestamp,
      last_failure_at: null,
      last_error_code: null,
      last_error_message: null,
      updated_at: input.timestamp,
    },
  });
}

async function markSyncFailure(input: SyncCursorResultInput & { error: unknown }) {
  await prisma.channel_sync_cursors.upsert({
    where: {
      channel_resource_status_filter: {
        channel: COUPANG_CHANNEL,
        resource: input.resource,
        status_filter: input.statusFilter,
      },
    },
    create: {
      channel: COUPANG_CHANNEL,
      resource: input.resource,
      status_filter: input.statusFilter,
      last_window_from: parseKstSqlDateTime(input.windowFrom),
      last_window_to: parseKstSqlDateTime(input.windowTo),
      next_token: input.nextToken ?? null,
      last_failure_at: input.timestamp,
      last_error_code: syncErrorCode(input.error),
      last_error_message: syncErrorMessage(input.error),
      created_at: input.timestamp,
      updated_at: input.timestamp,
    },
    update: {
      last_window_from: parseKstSqlDateTime(input.windowFrom),
      last_window_to: parseKstSqlDateTime(input.windowTo),
      next_token: input.nextToken ?? null,
      last_failure_at: input.timestamp,
      last_error_code: syncErrorCode(input.error),
      last_error_message: syncErrorMessage(input.error),
      updated_at: input.timestamp,
    },
  });
}

function assertCoupangReadSyncAllowed() {
  const config = getCoupangRuntimeConfig();

  if (runtimeConfigService.isProduction() && config.mode === "mock") {
    throw new Error("운영 모드에서는 mock 쿠팡 동기화를 실행할 수 없습니다.");
  }
}

function kstDateText(date = new Date()) {
  return todayKstDate(date);
}

function syncWindow(input: { hours?: number; days?: number }) {
  const now = quickHackClock.nowDate();
  const seconds =
    typeof input.hours === "number"
      ? input.hours * 60 * 60
      : (input.days ?? 1) * ONE_DAY_SECONDS;
  const from = addSeconds(now, -seconds);

  return {
    fromDate: kstDateText(from),
    toDate: kstDateText(now),
    fromDateTime: `${kstDateText(from)}T00:00:00`,
    toDateTime: `${kstDateText(now)}T23:59:59`,
    cutoffSqlDateTime: nowKstSqlDateTime(from),
  };
}

function dateKeyToUtcMilliseconds(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Coupang sync date must use YYYY-MM-DD: ${value}`);
  }

  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);

  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`Coupang sync date is invalid: ${value}`);
  }

  return milliseconds;
}

function utcMillisecondsToDateKey(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}

export function splitCoupangDateRange(
  dateFrom: string,
  dateTo: string,
  maxDays = RETURN_WITHDRAWAL_MAX_RANGE_DAYS
) {
  if (!Number.isSafeInteger(maxDays) || maxDays <= 0) {
    throw new Error("Coupang sync maxDays must be a positive integer.");
  }

  const dayMilliseconds = ONE_DAY_SECONDS * 1000;
  const fromMilliseconds = dateKeyToUtcMilliseconds(dateFrom);
  const toMilliseconds = dateKeyToUtcMilliseconds(dateTo);

  if (fromMilliseconds > toMilliseconds) {
    throw new Error("Coupang sync dateFrom must not be after dateTo.");
  }

  const ranges: Array<{ dateFrom: string; dateTo: string }> = [];

  for (
    let current = fromMilliseconds;
    current <= toMilliseconds;
    current += maxDays * dayMilliseconds
  ) {
    const rangeEnd = Math.min(
      current + (maxDays - 1) * dayMilliseconds,
      toMilliseconds
    );

    ranges.push({
      dateFrom: utcMillisecondsToDateKey(current),
      dateTo: utcMillisecondsToDateKey(rangeEnd),
    });
  }

  return ranges;
}

function isOrderInsideWindow(
  order: NormalizedCoupangOrder,
  cutoffSqlDateTime: DateTimeInput
) {
  const cutoff = parseKstSqlDateTime(cutoffSqlDateTime);
  if (!cutoff) {
    return true;
  }

  const orderedAt =
    parseKstSqlDateTime(order.orderedAt) ?? parseKstSqlDateTime(order.paidAt);

  return !orderedAt || orderedAt.getTime() >= cutoff.getTime();
}

async function expireOldMatchingWorkItems(
  cutoffSqlDateTime: DateTimeInput,
  now: DateTimeInput
) {
  const cutoff = databaseDateTime(cutoffSqlDateTime);
  const expiredAt = databaseDateTime(now);
  const candidates = await prisma.order_matching_work_queue.findMany({
    where: {
      channel: COUPANG_CHANNEL,
      created_at: { lt: cutoff },
      work_status: {
        in: [
          INVENTORY_MATCH_STATUSES.unmatched,
          INVENTORY_MATCH_STATUSES.failed,
          INVENTORY_MATCH_STATUSES.skipped,
        ],
      },
    },
    select: { work_item_id: true },
    orderBy: { work_item_id: "asc" },
  });

  return prisma.$transaction(async (tx) => {
    let expiredCount = 0;

    for (const candidate of candidates) {
      if (
        await expireOrderMatchingWorkItemIfEligible({
          tx,
          workItemId: candidate.work_item_id,
          timestamp: expiredAt,
        })
      ) {
        expiredCount += 1;
      }
    }

    return expiredCount;
  });
}

async function syncOrdersheetStatuses(input: {
  resource: string;
  statuses: readonly string[];
  createdAtFrom: string;
  createdAtTo: string;
  cutoffSqlDateTime?: string | null;
  reason?: string;
  workerLease?: WorkerLeaseGuard;
  credentialScope: CoupangReadSyncCredentialScope;
  dependencies: CoupangReadSyncDependencies;
}) {
  assertCoupangReadSyncAllowed();

  const syncStartedAt = nowKstSqlDateTime();
  let mode: "mock" | "live" | null = null;
  let pages = 0;
  let orders = 0;
  let shipments = 0;
  let items = 0;
  let skippedOutsideWindow = 0;
  let staleSnapshotCount = 0;
  let deliveryProjectedGroups = 0;
  let deliveryStatusTransitions = 0;
  let deliveryProjectionFailures = 0;

  for (const status of input.statuses) {
    await assertWorkerLeaseActive(input.workerLease);
    let nextToken: string | null = null;
    const seenTokens = new Set<string>();

    try {
      do {
        await assertWorkerLeaseActive(input.workerLease);
        const observation =
          await reserveSalesChannelProjectionObservation();
        const requestStartedAt = observation.startedAt;
        const apiCallLogId = await beginCoupangApiCallLog({
          apiName: input.resource,
          statusFilter: status,
          periodFrom: input.createdAtFrom,
          periodTo: input.createdAtTo,
          pageToken: nextToken,
          maxPerPage: ORDERSHEET_PAGE_SIZE,
          workerJobId: input.workerLease?.workerJobId ?? null,
          projectionRevision: observation.revision,
          requestStartedAt,
        });

        try {
          const credentialContext = await input.credentialScope.get();
          await assertWorkerLeaseActive(input.workerLease);
          const ordersheetResponse = await (
            input.dependencies.getOrdersheets ?? getCoupangOrdersheets
          )(
            {
              status,
              nextToken,
              maxPerPage: ORDERSHEET_PAGE_SIZE,
              createdAtFrom: input.createdAtFrom,
              createdAtTo: input.createdAtTo,
            },
            credentialContext,
            { signal: input.workerLease?.signal }
          );
          await assertWorkerLeaseActive(input.workerLease);
          const receivedAt = databaseNow();

          await markCoupangApiCallReceived({
            apiCallLogId,
            endpointPath: endpointPathFromRequestPath(
              ordersheetResponse.requestPath
            ),
            httpStatusCode: ordersheetResponse.httpStatusCode,
            externalResponseCode: externalResponseCode(
              ordersheetResponse.payload
            ),
            responseHash: ordersheetResponse.responseHash,
            receivedAt,
          });

          const rawPayloadText =
            ordersheetResponse.rawPayloadText ??
            JSON.stringify(ordersheetResponse.payload);
          const inbox = await recordValidatedIntegrationInboxEvidence({
            provider: "COUPANG",
            endpoint: endpointPathFromRequestPath(ordersheetResponse.requestPath),
            evidenceType: "COUPANG_ORDERSHEET_PAGE",
            rawPayloadText,
            occurredAt: receivedAt,
            validate: validateCoupangOrdersheetPage,
          });
          const page = inbox.normalizedResult;

          if (page.nextToken && seenTokens.has(page.nextToken)) {
            throw new Error(
              `Coupang ordersheets nextToken repeated for ${status}: ${page.nextToken}`
            );
          }

          const processingStartedAt = databaseNow();
          await markCoupangApiCallProcessing({
            apiCallLogId,
            nextPageToken: page.nextToken,
            responseRowCount: page.orders.length,
            processingStartedAt,
          });

          const pageResult = await runMeasuredTransaction(
            prisma,
            "coupang.ordersheet-page",
            async (tx) => {
              let pageOrders = 0;
              let pageShipments = 0;
              let pageItems = 0;
              let pageSkipped = 0;
              let pageStale = 0;
              const appliedOrders: NormalizedCoupangOrder[] = [];

              for (const order of page.orders) {
                throwIfWorkerLeaseAborted(input.workerLease);

                if (!isOrderInsideWindow(order, input.cutoffSqlDateTime ?? null)) {
                  pageSkipped += 1;
                  continue;
                }

                const result = await upsertOrder(
                  tx,
                  order,
                  processingStartedAt,
                  observation.revision,
                  apiCallLogId
                );
                if (!result.applied) {
                  pageStale += 1;
                  continue;
                }
                appliedOrders.push(order);
                pageOrders += 1;
                pageShipments += result.shipments;
                pageItems += result.items;
              }

              const processedAt = databaseNow();
              await completeCoupangApiCallLog(tx, {
                apiCallLogId,
                processedRowCount: pageOrders,
                skippedRowCount: pageSkipped + pageStale,
                staleSnapshotCount: pageStale,
                processedAt,
              });

              return {
                orders: pageOrders,
                shipments: pageShipments,
                items: pageItems,
                skipped: pageSkipped,
                stale: pageStale,
                appliedOrders,
              };
            },
            {
              maxWait: SYNC_PAGE_TRANSACTION_MAX_WAIT_MS,
              timeout: SYNC_PAGE_TRANSACTION_TIMEOUT_MS,
            }
          );

          const deliveryProjection = await projectCoupangDeliveryStatuses({
            orders: pageResult.appliedOrders.map((order) => {
              const providerDeliveredAt = parseKstSqlDateTime(order.deliveredAt);
              return {
                externalShipmentId: order.externalShipmentId,
                channelStatus: order.channelStatus,
                syncedAt:
                  order.channelStatus === "FINAL_DELIVERY" &&
                  providerDeliveredAt &&
                  providerDeliveredAt.getTime() <= processingStartedAt.getTime()
                    ? providerDeliveredAt
                    : processingStartedAt,
              };
            }),
            workerJobId: input.workerLease?.workerJobId ?? null,
          });

          mode = ordersheetResponse.mode;
          pages += 1;
          orders += pageResult.orders;
          shipments += pageResult.shipments;
          items += pageResult.items;
          skippedOutsideWindow += pageResult.skipped;
          staleSnapshotCount += pageResult.stale;
          deliveryProjectedGroups +=
            deliveryProjection.projectedGroupCount;
          deliveryStatusTransitions +=
            deliveryProjection.transitionedCount;
          deliveryProjectionFailures +=
            deliveryProjection.failedGroupCount;
          nextToken = page.nextToken;

          if (nextToken) seenTokens.add(nextToken);
        } catch (error) {
          await failCoupangApiCallLog(apiCallLogId, error);
          throw error;
        }
      } while (nextToken);

      await assertWorkerLeaseActive(input.workerLease);
      await markSyncSuccess({
        resource: input.resource,
        statusFilter: status,
        windowFrom: input.createdAtFrom,
        windowTo: input.createdAtTo,
        timestamp: databaseNow(),
      });
    } catch (error) {
      if (!isWorkerShutdownRequestedError(error)) {
        await markSyncFailure({
          resource: input.resource,
          statusFilter: status,
          windowFrom: input.createdAtFrom,
          windowTo: input.createdAtTo,
          nextToken,
          timestamp: databaseNow(),
          error,
        });
      }
      throw error;
    }
  }

  const syncedAt = nowKstSqlDateTime();
  return {
    mode: mode ?? "mock",
    syncedAt,
    syncStartedAt,
    resource: input.resource,
    statuses: [...input.statuses],
    createdAtFrom: input.createdAtFrom,
    createdAtTo: input.createdAtTo,
    cutoffSqlDateTime: input.cutoffSqlDateTime ?? null,
    reason: input.reason ?? null,
    pages,
    orders,
    shipments,
    items,
    skippedOutsideWindow,
    staleSnapshotCount,
    deliveryProjectedGroups,
    deliveryStatusTransitions,
    deliveryProjectionFailures,
  };
}

async function syncReturnRequests(input: {
  resource: string;
  statuses: readonly string[];
  createdAtFrom: string;
  createdAtTo: string;
  reason?: string;
  workerLease?: WorkerLeaseGuard;
  credentialScope: CoupangReadSyncCredentialScope;
  dependencies: CoupangReadSyncDependencies;
}) {
  assertCoupangReadSyncAllowed();

  const syncStartedAt = nowKstSqlDateTime();
  let mode: "mock" | "live" | null = null;
  let pages = 0;
  let returns = 0;
  let eventCreatedCount = 0;
  let noOpCount = 0;
  let invalidTimestampCount = 0;
  let staleSnapshotCount = 0;

  for (const status of input.statuses) {
    for (const receiptType of RETURN_REQUEST_RECEIPT_TYPES) {
      await assertWorkerLeaseActive(input.workerLease);
      let nextToken: string | null = null;
      const seenTokens = new Set<string>();
      const statusFilter = `${status}:${receiptType}`;

      try {
        do {
          await assertWorkerLeaseActive(input.workerLease);
          const observation =
            await reserveSalesChannelProjectionObservation();
          const requestStartedAt = observation.startedAt;
          const apiCallLogId = await beginCoupangApiCallLog({
            apiName: input.resource,
            statusFilter,
            periodFrom: input.createdAtFrom,
            periodTo: input.createdAtTo,
            pageToken: nextToken,
            maxPerPage: RETURN_REQUEST_PAGE_SIZE,
            workerJobId: input.workerLease?.workerJobId ?? null,
            projectionRevision: observation.revision,
            requestStartedAt,
          });

          try {
            const credentialContext = await input.credentialScope.get();
            await assertWorkerLeaseActive(input.workerLease);
            const returnResponse = await (
              input.dependencies.getReturnRequests ?? getCoupangReturnRequests
            )(
              {
                status,
                cancelType: receiptType,
                nextToken,
                maxPerPage: RETURN_REQUEST_PAGE_SIZE,
                createdAtFrom: input.createdAtFrom,
                createdAtTo: input.createdAtTo,
              },
              credentialContext,
              { signal: input.workerLease?.signal }
            );
            await assertWorkerLeaseActive(input.workerLease);
            const receivedAt = databaseNow();

          await markCoupangApiCallReceived({
            apiCallLogId,
            endpointPath: endpointPathFromRequestPath(returnResponse.requestPath),
            httpStatusCode: returnResponse.httpStatusCode,
            externalResponseCode: externalResponseCode(returnResponse.payload),
            responseHash: returnResponse.responseHash,
            receivedAt,
          });

          const inbox = await recordValidatedIntegrationInboxEvidence({
            provider: "COUPANG",
            endpoint: endpointPathFromRequestPath(returnResponse.requestPath),
            evidenceType: "COUPANG_RETURN_PAGE",
            rawPayloadText:
              returnResponse.rawPayloadText ?? JSON.stringify(returnResponse.payload),
            occurredAt: receivedAt,
            validate: validateCoupangReturnPage,
            projectionHandlerKeys: [CLAIM_PROJECTION_HANDLER.returns],
            projectionContext: {
              apiCallLogId,
              projectionRevision: observation.revision,
              workerJobId: input.workerLease?.workerJobId ?? null,
            },
          });
          const page = inbox.normalizedResult;
          const returnRequests = page.returns;
          const pageNextToken = page.nextToken;

            if (pageNextToken && seenTokens.has(pageNextToken)) {
              throw new Error(
                `Coupang returnRequests nextToken repeated for ${statusFilter}: ${pageNextToken}`
              );
            }

          const processingStartedAt = databaseNow();
          await markCoupangApiCallProcessing({
            apiCallLogId,
            nextPageToken: pageNextToken,
            responseRowCount: returnRequests.length,
            processingStartedAt,
          });

          const projection = await runCoupangClaimProjectionJob(
            inbox.projectionJobs[0].integration_projection_job_id
          );
          const pageResult = projection?.result ?? {
            rows: returnRequests.length,
            eventCreatedCount: 0,
            noOpCount: returnRequests.length,
            invalidTimestampCount: 0,
            staleSnapshotCount: 0,
            unmatchedWithdrawalCount: 0,
          };
          await prisma.$transaction((tx) =>
            completeCoupangApiCallLog(tx, {
              apiCallLogId,
              processedRowCount: pageResult.rows,
              skippedRowCount: pageResult.staleSnapshotCount,
              staleSnapshotCount: pageResult.staleSnapshotCount,
              processedAt: databaseNow(),
            })
          );

          mode = returnResponse.mode;
          pages += 1;
          returns += pageResult.rows;
          eventCreatedCount += pageResult.eventCreatedCount;
          noOpCount += pageResult.noOpCount;
          invalidTimestampCount += pageResult.invalidTimestampCount;
          staleSnapshotCount += pageResult.staleSnapshotCount;
          nextToken = pageNextToken;

            if (nextToken) seenTokens.add(nextToken);
          } catch (error) {
            await failCoupangApiCallLog(apiCallLogId, error);
            throw error;
          }
        } while (nextToken);

        await assertWorkerLeaseActive(input.workerLease);
        await markSyncSuccess({
          resource: input.resource,
          statusFilter,
          windowFrom: input.createdAtFrom,
          windowTo: input.createdAtTo,
          timestamp: databaseNow(),
        });
      } catch (error) {
        if (!isWorkerShutdownRequestedError(error)) {
          await markSyncFailure({
            resource: input.resource,
            statusFilter,
            windowFrom: input.createdAtFrom,
            windowTo: input.createdAtTo,
            nextToken,
            timestamp: databaseNow(),
            error,
          });
        }
        throw error;
      }
    }
  }

  const syncedAt = nowKstSqlDateTime();
  return {
    mode: mode ?? "mock",
    syncedAt,
    syncStartedAt,
    resource: input.resource,
    statuses: [...input.statuses],
    receiptTypes: [...RETURN_REQUEST_RECEIPT_TYPES],
    createdAtFrom: input.createdAtFrom,
    createdAtTo: input.createdAtTo,
    reason: input.reason ?? null,
    pages,
    returns,
    eventCreatedCount,
    noOpCount,
    invalidTimestampCount,
    staleSnapshotCount,
  };
}

async function syncExchangeRequests(input: {
  resource: string;
  createdAtFrom: string;
  createdAtTo: string;
  reason?: string;
  workerLease?: WorkerLeaseGuard;
  credentialScope: CoupangReadSyncCredentialScope;
  dependencies: CoupangReadSyncDependencies;
}) {
  assertCoupangReadSyncAllowed();

  const syncStartedAt = nowKstSqlDateTime();
  let mode: "mock" | "live" | null = null;
  let pages = 0;
  let exchanges = 0;
  let eventCreatedCount = 0;
  let noOpCount = 0;
  let invalidTimestampCount = 0;
  let staleSnapshotCount = 0;
  let nextToken: string | null = null;
  const seenTokens = new Set<string>();

  try {
    do {
      await assertWorkerLeaseActive(input.workerLease);
      const observation = await reserveSalesChannelProjectionObservation();
      const requestStartedAt = observation.startedAt;
      const apiCallLogId = await beginCoupangApiCallLog({
        apiName: input.resource,
        statusFilter: null,
        periodFrom: input.createdAtFrom,
        periodTo: input.createdAtTo,
        pageToken: nextToken,
        maxPerPage: EXCHANGE_REQUEST_PAGE_SIZE,
        workerJobId: input.workerLease?.workerJobId ?? null,
        projectionRevision: observation.revision,
        requestStartedAt,
      });

      try {
        const credentialContext = await input.credentialScope.get();
        await assertWorkerLeaseActive(input.workerLease);
        const exchangeResponse = await (
          input.dependencies.getExchangeRequests ?? getCoupangExchangeRequests
        )(
          {
            nextToken,
            maxPerPage: EXCHANGE_REQUEST_PAGE_SIZE,
            createdAtFrom: input.createdAtFrom,
            createdAtTo: input.createdAtTo,
          },
          credentialContext,
          { signal: input.workerLease?.signal }
        );
        await assertWorkerLeaseActive(input.workerLease);
        const receivedAt = databaseNow();

        await markCoupangApiCallReceived({
          apiCallLogId,
          endpointPath: endpointPathFromRequestPath(exchangeResponse.requestPath),
          httpStatusCode: exchangeResponse.httpStatusCode,
          externalResponseCode: externalResponseCode(exchangeResponse.payload),
          responseHash: exchangeResponse.responseHash,
          receivedAt,
        });

        const inbox = await recordValidatedIntegrationInboxEvidence({
          provider: "COUPANG",
          endpoint: endpointPathFromRequestPath(exchangeResponse.requestPath),
          evidenceType: "COUPANG_EXCHANGE_PAGE",
          rawPayloadText:
            exchangeResponse.rawPayloadText ?? JSON.stringify(exchangeResponse.payload),
          occurredAt: receivedAt,
          validate: validateCoupangExchangePage,
          projectionHandlerKeys: [CLAIM_PROJECTION_HANDLER.exchanges],
          projectionContext: {
            apiCallLogId,
            projectionRevision: observation.revision,
            workerJobId: input.workerLease?.workerJobId ?? null,
          },
        });
        const exchangeRequests = inbox.normalizedResult.exchanges;
        const pageNextToken = inbox.normalizedResult.nextToken;

        if (pageNextToken && seenTokens.has(pageNextToken)) {
          throw new Error(
            `Coupang exchangeRequests nextToken repeated: ${pageNextToken}`
          );
        }

        const processingStartedAt = databaseNow();
        await markCoupangApiCallProcessing({
          apiCallLogId,
          nextPageToken: pageNextToken,
          responseRowCount: exchangeRequests.length,
          processingStartedAt,
        });

        const projection = await runCoupangClaimProjectionJob(
          inbox.projectionJobs[0].integration_projection_job_id
        );
        const pageResult = projection?.result ?? {
          rows: exchangeRequests.length,
          eventCreatedCount: 0,
          noOpCount: exchangeRequests.length,
          invalidTimestampCount: 0,
          staleSnapshotCount: 0,
          unmatchedWithdrawalCount: 0,
        };
        await prisma.$transaction((tx) =>
          completeCoupangApiCallLog(tx, {
            apiCallLogId,
            processedRowCount: pageResult.rows,
            skippedRowCount: pageResult.staleSnapshotCount,
            staleSnapshotCount: pageResult.staleSnapshotCount,
            processedAt: databaseNow(),
          })
        );

        mode = exchangeResponse.mode;
        pages += 1;
        exchanges += pageResult.rows;
        eventCreatedCount += pageResult.eventCreatedCount;
        noOpCount += pageResult.noOpCount;
        invalidTimestampCount += pageResult.invalidTimestampCount;
        staleSnapshotCount += pageResult.staleSnapshotCount;
        nextToken = pageNextToken;

        if (nextToken) seenTokens.add(nextToken);
      } catch (error) {
        await failCoupangApiCallLog(apiCallLogId, error);
        throw error;
      }
    } while (nextToken);

    await assertWorkerLeaseActive(input.workerLease);
    await markSyncSuccess({
      resource: input.resource,
      statusFilter: "",
      windowFrom: input.createdAtFrom,
      windowTo: input.createdAtTo,
      timestamp: databaseNow(),
    });
  } catch (error) {
    if (!isWorkerShutdownRequestedError(error)) {
      await markSyncFailure({
        resource: input.resource,
        statusFilter: "",
        windowFrom: input.createdAtFrom,
        windowTo: input.createdAtTo,
        nextToken,
        timestamp: databaseNow(),
        error,
      });
    }
    throw error;
  }

  const syncedAt = nowKstSqlDateTime();
  return {
    mode: mode ?? "mock",
    syncedAt,
    syncStartedAt,
    resource: input.resource,
    createdAtFrom: input.createdAtFrom,
    createdAtTo: input.createdAtTo,
    reason: input.reason ?? null,
    pages,
    exchanges,
    eventCreatedCount,
    noOpCount,
    invalidTimestampCount,
    staleSnapshotCount,
  };
}

async function syncReturnWithdrawals(input: {
  resource: string;
  dateFrom: string;
  dateTo: string;
  reason?: string;
  workerLease?: WorkerLeaseGuard;
  credentialScope: CoupangReadSyncCredentialScope;
  dependencies: CoupangReadSyncDependencies;
}) {
  assertCoupangReadSyncAllowed();

  const syncStartedAt = nowKstSqlDateTime();
  const ranges = splitCoupangDateRange(input.dateFrom, input.dateTo);
  let mode: "mock" | "live" | null = null;
  let pages = 0;
  let withdrawals = 0;
  let eventCreatedCount = 0;
  let noOpCount = 0;
  let invalidTimestampCount = 0;
  let unmatchedWithdrawalCount = 0;
  let currentRange = ranges[0] ?? {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
  };
  let currentPageIndex = 1;

  try {
    for (const range of ranges) {
      currentRange = range;
      currentPageIndex = 1;
      const seenPageIndexes = new Set<number>();

      do {
        await assertWorkerLeaseActive(input.workerLease);
        seenPageIndexes.add(currentPageIndex);
        const observation = await reserveSalesChannelProjectionObservation();
        const requestStartedAt = observation.startedAt;
        const apiCallLogId = await beginCoupangApiCallLog({
          apiName: input.resource,
          statusFilter: null,
          periodFrom: range.dateFrom,
          periodTo: range.dateTo,
          pageToken: String(currentPageIndex),
          maxPerPage: RETURN_WITHDRAWAL_PAGE_SIZE,
          workerJobId: input.workerLease?.workerJobId ?? null,
          projectionRevision: observation.revision,
          requestStartedAt,
        });

        try {
          const credentialContext = await input.credentialScope.get();
          await assertWorkerLeaseActive(input.workerLease);
          const response = await (
            input.dependencies.getReturnWithdrawals ??
            getCoupangReturnWithdrawals
          )(
            {
              dateFrom: range.dateFrom,
              dateTo: range.dateTo,
              pageIndex: currentPageIndex,
              sizePerPage: RETURN_WITHDRAWAL_PAGE_SIZE,
            },
            credentialContext,
            { signal: input.workerLease?.signal }
          );
          await assertWorkerLeaseActive(input.workerLease);
          const receivedAt = databaseNow();

          await markCoupangApiCallReceived({
            apiCallLogId,
            endpointPath: endpointPathFromRequestPath(response.requestPath),
            httpStatusCode: response.httpStatusCode,
            externalResponseCode: externalResponseCode(response.payload),
            responseHash: response.responseHash,
            receivedAt,
          });

          const inbox = await recordValidatedIntegrationInboxEvidence({
            provider: "COUPANG",
            endpoint: endpointPathFromRequestPath(response.requestPath),
            evidenceType: "COUPANG_RETURN_WITHDRAWAL_PAGE",
            rawPayloadText:
              response.rawPayloadText ?? JSON.stringify(response.payload),
            occurredAt: receivedAt,
            validate: validateCoupangReturnWithdrawalPage,
            projectionHandlerKeys: [CLAIM_PROJECTION_HANDLER.withdrawals],
            projectionContext: {
              apiCallLogId,
              projectionRevision: observation.revision,
              workerJobId: input.workerLease?.workerJobId ?? null,
            },
          });
          const pageWithdrawals = inbox.normalizedResult.withdrawals;
          const nextPageIndex = inbox.normalizedResult.nextPageIndex;

          if (
            nextPageIndex !== null &&
            (nextPageIndex <= currentPageIndex ||
              seenPageIndexes.has(nextPageIndex))
          ) {
            throw new Error(
              `Coupang returnWithdrawRequests nextPageIndex repeated or moved backwards: ${nextPageIndex}`
            );
          }

          const processingStartedAt = databaseNow();
          await markCoupangApiCallProcessing({
            apiCallLogId,
            nextPageToken:
              nextPageIndex === null ? null : String(nextPageIndex),
            responseRowCount: pageWithdrawals.length,
            processingStartedAt,
          });

          const projection = await runCoupangClaimProjectionJob(
            inbox.projectionJobs[0].integration_projection_job_id
          );
          const pageResult = projection?.result ?? {
            rows: pageWithdrawals.length,
            eventCreatedCount: 0,
            noOpCount: pageWithdrawals.length,
            invalidTimestampCount: 0,
            staleSnapshotCount: 0,
            unmatchedWithdrawalCount: 0,
          };
          await prisma.$transaction((tx) =>
            completeCoupangApiCallLog(tx, {
              apiCallLogId,
              processedRowCount: pageResult.rows,
              skippedRowCount: pageResult.staleSnapshotCount,
              staleSnapshotCount: pageResult.staleSnapshotCount,
              processedAt: databaseNow(),
            })
          );

          mode = response.mode;
          pages += 1;
          withdrawals += pageResult.rows;
          eventCreatedCount += pageResult.eventCreatedCount;
          noOpCount += pageResult.noOpCount;
          invalidTimestampCount += pageResult.invalidTimestampCount;
          unmatchedWithdrawalCount += pageResult.unmatchedWithdrawalCount;

          if (nextPageIndex === null) {
            break;
          }

          currentPageIndex = nextPageIndex;
        } catch (error) {
          await failCoupangApiCallLog(apiCallLogId, error);
          throw error;
        }
      } while (true);
    }

    await assertWorkerLeaseActive(input.workerLease);
    await markSyncSuccess({
      resource: input.resource,
      statusFilter: "",
      windowFrom: input.dateFrom,
      windowTo: input.dateTo,
      timestamp: databaseNow(),
    });
  } catch (error) {
    if (!isWorkerShutdownRequestedError(error)) {
      await markSyncFailure({
        resource: input.resource,
        statusFilter: "",
        windowFrom: currentRange.dateFrom,
        windowTo: currentRange.dateTo,
        nextToken: String(currentPageIndex),
        timestamp: databaseNow(),
        error,
      });
    }
    throw error;
  }

  return {
    mode: mode ?? "mock",
    syncedAt: nowKstSqlDateTime(),
    syncStartedAt,
    resource: input.resource,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    reason: input.reason ?? null,
    intervals: ranges.length,
    pages,
    withdrawals,
    eventCreatedCount,
    noOpCount,
    invalidTimestampCount,
    unmatchedWithdrawalCount,
  };
}

export async function syncCoupangAcceptOrders(
  input: { reason?: string; workerLease?: WorkerLeaseGuard } = {},
  dependencies: CoupangReadSyncDependencies = {}
) {
  const credentialScope = createCoupangReadSyncCredentialScope(dependencies);
  const window = syncWindow({ hours: 24 });
  const ordersheetSummary = await syncOrdersheetStatuses({
    resource: "ordersheets.accept",
    statuses: ACCEPT_ORDER_SYNC_STATUSES,
    createdAtFrom: window.fromDate,
    createdAtTo: window.toDate,
    cutoffSqlDateTime: window.cutoffSqlDateTime,
    reason: input.reason,
    workerLease: input.workerLease,
    credentialScope,
    dependencies,
  });
  await assertWorkerLeaseActive(input.workerLease);
  const expiredWorkItems = await expireOldMatchingWorkItems(
    window.cutoffSqlDateTime,
    ordersheetSummary.syncedAt
  );

  return {
    ...ordersheetSummary,
    expiredWorkItems,
  };
}

export async function syncCoupangPreShipmentVerification(
  input: { reason?: string; workerLease?: WorkerLeaseGuard } = {},
  dependencies: CoupangReadSyncDependencies = {}
) {
  const credentialScope = createCoupangReadSyncCredentialScope(dependencies);
  const window = syncWindow({ hours: 24 });

  return syncOrdersheetStatuses({
    resource: "ordersheets.preShipmentVerification",
    statuses: PRE_SHIPMENT_VERIFY_ORDER_STATUSES,
    createdAtFrom: window.fromDate,
    createdAtTo: window.toDate,
    cutoffSqlDateTime: window.cutoffSqlDateTime,
    reason: input.reason,
    workerLease: input.workerLease,
    credentialScope,
    dependencies,
  });
}

export async function syncCoupangShipmentStatuses(
  input: { reason?: string; workerLease?: WorkerLeaseGuard } = {},
  dependencies: CoupangReadSyncDependencies = {}
) {
  const credentialScope = createCoupangReadSyncCredentialScope(dependencies);
  const window = syncWindow({ days: 14 });

  return syncOrdersheetStatuses({
    resource: "ordersheets.shipmentStatus",
    statuses: SHIPMENT_STATUS_SYNC_STATUSES,
    createdAtFrom: window.fromDate,
    createdAtTo: window.toDate,
    cutoffSqlDateTime: window.cutoffSqlDateTime,
    reason: input.reason,
    workerLease: input.workerLease,
    credentialScope,
    dependencies,
  });
}

export async function syncCoupangPreShipmentReturns(
  input: { reason?: string; workerLease?: WorkerLeaseGuard } = {},
  dependencies: CoupangReadSyncDependencies = {}
) {
  const projectionRecoveryBefore = await drainCoupangClaimProjectionJobs();
  await assertWorkerLeaseActive(input.workerLease);
  const credentialScope = createCoupangReadSyncCredentialScope(dependencies);
  const window = syncWindow({ hours: 24 });

  const result = await syncReturnRequests({
    resource: "returnRequests.preShipment",
    statuses: COUPANG_RETURN_REQUEST_STATUSES,
    createdAtFrom: window.fromDate,
    createdAtTo: window.toDate,
    reason: input.reason,
    workerLease: input.workerLease,
    credentialScope,
    dependencies,
  });
  const projectionRecoveryAfter = await drainCoupangClaimProjectionJobs();
  return { ...result, projectionRecoveryBefore, projectionRecoveryAfter };
}

export async function syncCoupangAfterShipmentClaims(
  input: { reason?: string; workerLease?: WorkerLeaseGuard } = {},
  dependencies: CoupangReadSyncDependencies = {}
) {
  const projectionRecoveryBefore = await drainCoupangClaimProjectionJobs();
  await assertWorkerLeaseActive(input.workerLease);
  const credentialScope = createCoupangReadSyncCredentialScope(dependencies);
  const window = syncWindow({ days: 30 });
  const returns = await syncReturnRequests({
    resource: "returnRequests.afterShipment",
    statuses: COUPANG_RETURN_REQUEST_STATUSES,
    createdAtFrom: window.fromDate,
    createdAtTo: window.toDate,
    reason: input.reason,
    workerLease: input.workerLease,
    credentialScope,
    dependencies,
  });
  await assertWorkerLeaseActive(input.workerLease);
  const exchanges = await syncExchangeRequests({
    resource: "exchangeRequests.afterShipment",
    createdAtFrom: window.fromDateTime,
    createdAtTo: window.toDateTime,
    reason: input.reason,
    workerLease: input.workerLease,
    credentialScope,
    dependencies,
  });
  await assertWorkerLeaseActive(input.workerLease);
  const withdrawals = await syncReturnWithdrawals({
    resource: "returnWithdrawRequests.afterShipment",
    dateFrom: window.fromDate,
    dateTo: window.toDate,
    reason: input.reason,
    workerLease: input.workerLease,
    credentialScope,
    dependencies,
  });
  const projectionRecoveryAfter = await drainCoupangClaimProjectionJobs();

  return {
    mode:
      returns.mode === "live" ||
      exchanges.mode === "live" ||
      withdrawals.mode === "live"
        ? "live"
        : "mock",
    syncedAt: withdrawals.syncedAt,
    reason: input.reason ?? null,
    returns,
    exchanges,
    withdrawals,
    projectionRecoveryBefore,
    projectionRecoveryAfter,
  };
}
