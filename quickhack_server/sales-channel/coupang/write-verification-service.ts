import type { Prisma } from "@/generated/prisma/client";
import {
  databaseNow,
  type DatabaseDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import { traceOperationSpan } from "@/quickhack_server/observability/operation-trace";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  getCoupangVendorItemInventory,
  getCoupangOrdersheetByOrderId,
  getCoupangReturnRequests,
  openCoupangApiCredentialContext,
  type CoupangApiCredentialContext,
} from "@/quickhack_server/sales-channel/coupang/api-client";
import { recordCoupangInventoryRepairVerificationObservation } from "@/quickhack_server/sales-channel/coupang/inventory-verification-service";
import {
  reserveSalesChannelProjectionObservation,
  type SalesChannelProjectionObservation,
} from "@/quickhack_server/sales-channel/projection-revision-service";
import { groupSalesChannelWriteTargets } from "@/quickhack_server/sales-channel/write/sales-channel-write-target-group";
import {
  nextTokenFromPayload,
  ordersheetsFromPayload,
  persistCoupangOrderAddressSnapshotsInTransaction,
  persistCoupangOrderRawSnapshotsInTransaction,
  persistCoupangReturnRawSnapshotsInTransaction,
  returnRequestsFromPayload,
  type NormalizedCoupangOrder,
  type NormalizedCoupangReturn,
} from "@/quickhack_server/sales-channel/coupang/sync-service";
import {
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
} from "@/quickhack_shared/sales-channel/write-requests";

const CONFIRMED_ORDER_STATUSES = new Set([
  "INSTRUCT",
  "DEPARTURE",
  "DELIVERING",
  "FINAL_DELIVERY",
]);
const CONFIRMED_INVOICE_STATUSES = new Set([
  "DEPARTURE",
  "DELIVERING",
  "FINAL_DELIVERY",
]);
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_OBSERVATION_ATTEMPTS = 1;
const DEFAULT_OBSERVATION_DELAY_MS = 500;
const MAX_RETURN_PAGES = 10;

type VerificationOutcome =
  | "CONFIRMED"
  | "NOT_APPLIED"
  | "UNKNOWN"
  | "PARTIAL";

export type CoupangWriteVerificationTargetGroupResult = {
  groupKey: string;
  targetIds: number[];
  outcome: Exclude<VerificationOutcome, "PARTIAL">;
  code: string;
};

export type CoupangWriteVerificationResult = {
  outcome: VerificationOutcome;
  code: string;
  messageArguments: Record<string, string | number | null>;
  externalErrorSnapshot?: string | null;
  endpointPath: string;
  targetCount: number;
  confirmedCount: number;
  targetGroups: CoupangWriteVerificationTargetGroupResult[];
  observedStatuses: Array<{
    externalOrderId: string;
    externalShipmentId: string | null;
    externalReceiptId: string | null;
    observedStatus: string | null;
    observedInvoiceNumber?: string | null;
  }>;
  expectedInventoryQuantity?: number;
  observedInventoryQuantity?: number;
};

export type CoupangOrderAddressRefreshResult = {
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  code: string;
  endpointPath: string | null;
  targetCount: number;
  refreshedTargetCount: number;
  failedTargetCount: number;
};

type InventoryVerificationObservation = {
  mappingId: number;
  desiredVersionSnapshot: number;
  mismatchSinceSnapshot: Date | string;
  projectionBasisHashSnapshot: string;
  expectedChannelQuantitySnapshot: number;
  observedChannelQuantity: number;
};

export type CoupangWriteVerificationObservation = {
  result: CoupangWriteVerificationResult;
  observedAt: DatabaseDateTime;
  orderSnapshots: readonly NormalizedCoupangOrder[];
  returnSnapshots: readonly NormalizedCoupangReturn[];
  projectionObservation: SalesChannelProjectionObservation | null;
  inventoryObservation: InventoryVerificationObservation | null;
};

type PersistedWriteRequest = Awaited<
  ReturnType<typeof loadPersistedWriteRequest>
>;

export type CoupangWriteVerificationDependencies = {
  getInventory?: typeof getCoupangVendorItemInventory;
  recordInventoryObservation?: typeof recordCoupangInventoryRepairVerificationObservation;
  getOrdersheetByOrderId?: typeof getCoupangOrdersheetByOrderId;
  getReturnRequests?: typeof getCoupangReturnRequests;
  credentialContext?: CoupangApiCredentialContext;
  openCredentialContext?: typeof openCoupangApiCredentialContext;
};

async function dependenciesWithCredentialContext(
  requestType: string,
  dependencies: CoupangWriteVerificationDependencies
) {
  const hasInjectedReader =
    requestType ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInventoryQuantityUpdate
      ? Boolean(dependencies.getInventory)
      : requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct ||
    requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload ||
    requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate
      ? Boolean(dependencies.getOrdersheetByOrderId)
      : Boolean(dependencies.getReturnRequests);

  if (dependencies.credentialContext) {
    return dependencies;
  }

  if (dependencies.openCredentialContext) {
    return {
      ...dependencies,
      credentialContext: await dependencies.openCredentialContext(
        "CACHED_READ"
      ),
    };
  }

  if (hasInjectedReader) {
    return dependencies;
  }

  return {
    ...dependencies,
    credentialContext: await openCoupangApiCredentialContext("CACHED_READ"),
  };
}

async function verifyInventoryQuantityWrite(
  request: PersistedWriteRequest,
  dependencies: CoupangWriteVerificationDependencies
) {
  const targets = request.targets.filter(
    (target) => target.target_type === "INVENTORY_VERIFICATION"
  );
  const target = targets[0];

  if (
    targets.length !== 1 ||
    !target ||
    target.inventory_verification_state_id === null ||
    target.inventory_desired_version_snapshot === null ||
    !target.inventory_mismatch_since_snapshot ||
    !target.inventory_projection_basis_hash_snapshot ||
    target.inventory_expected_channel_quantity_snapshot === null
  ) {
    throw new Error(
      `Inventory quantity repair snapshot for write request ${request.sales_channel_write_request_id} is incomplete.`
    );
  }

  const vendorItemId = String(
    target.external_vendor_item_id ?? target.target_external_id ?? ""
  ).trim();
  const state =
    await prisma.sales_channel_inventory_verification_states.findUnique({
      where: {
        verification_state_id: target.inventory_verification_state_id,
      },
      select: { mapping_id: true },
    });

  if (!vendorItemId || !state) {
    throw new Error(
      `Inventory quantity repair target for write request ${request.sales_channel_write_request_id} is invalid.`
    );
  }

  const response = await traceOperationSpan(
    "COUPANG_TARGETED_VERIFY_READ",
    () =>
      (dependencies.getInventory ?? getCoupangVendorItemInventory)(
        vendorItemId,
        dependencies.credentialContext
      )
  );
  const observedQuantity = response.payload.amountInStock;
  const expectedQuantity =
    target.inventory_expected_channel_quantity_snapshot;

  const confirmed = observedQuantity === expectedQuantity;
  const targetGroup = groupSalesChannelWriteTargets({
    requestType: request.request_type,
    requestTargetExternalId: request.target_external_id,
    targets,
  })[0];

  return {
    result: {
      outcome: confirmed ? ("CONFIRMED" as const) : ("UNKNOWN" as const),
      code: confirmed
        ? "INVENTORY_QUANTITY_CONFIRMED"
        : "INVENTORY_QUANTITY_NOT_CONFIRMED",
      messageArguments: {
        vendorItemId,
        expectedQuantity,
        observedQuantity,
      },
      endpointPath:
        "/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/inventories",
      targetCount: 1,
      confirmedCount: confirmed ? 1 : 0,
      targetGroups: [
        {
          groupKey: targetGroup.groupKey,
          targetIds: targetGroup.targetIds,
          outcome: confirmed ? "CONFIRMED" : "UNKNOWN",
          code: confirmed
            ? "INVENTORY_QUANTITY_CONFIRMED"
            : "INVENTORY_QUANTITY_NOT_CONFIRMED",
        },
      ],
      observedStatuses: [
        {
          externalOrderId: "",
          externalShipmentId: null,
          externalReceiptId: null,
          observedStatus: String(observedQuantity),
        },
      ],
      expectedInventoryQuantity: expectedQuantity,
      observedInventoryQuantity: observedQuantity,
    } satisfies CoupangWriteVerificationResult,
    observedAt: databaseNow(),
    orderSnapshots: [],
    returnSnapshots: [],
    projectionObservation: null,
    inventoryObservation: {
      mappingId: state.mapping_id,
      desiredVersionSnapshot: target.inventory_desired_version_snapshot,
      mismatchSinceSnapshot: target.inventory_mismatch_since_snapshot,
      projectionBasisHashSnapshot:
        target.inventory_projection_basis_hash_snapshot,
      expectedChannelQuantitySnapshot: expectedQuantity,
      observedChannelQuantity: observedQuantity,
    },
  } satisfies CoupangWriteVerificationObservation;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function code(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function orderSnapshotKey(orderId: string, shipmentId: string) {
  return `${orderId}\u0000${shipmentId}`;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
) {
  const results = new Array<R>(values.length);
  let cursor = 0;

  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= values.length) {
        return;
      }

      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(concurrency, 1), values.length) },
      () => consume()
    )
  );

  return results;
}

async function loadPersistedWriteRequest(requestId: number) {
  const request = await prisma.sales_channel_write_requests.findUnique({
    where: { sales_channel_write_request_id: requestId },
    include: {
      targets: {
        orderBy: { sales_channel_write_request_target_id: "asc" },
      },
    },
  });

  if (!request) {
    throw new Error(`Sales-channel write request ${requestId} was not found.`);
  }

  if (request.channel !== "COUPANG") {
    throw new Error(`Unsupported sales channel: ${request.channel}`);
  }

  return request;
}

async function resolveOrderVerificationTargets(request: PersistedWriteRequest) {
  const shipmentTargets = request.targets
    .filter((target) => target.target_type === "SHIPMENT_BOX")
    .map((target) => ({
      targetId: target.sales_channel_write_request_target_id,
      shipmentId: String(
        target.external_shipment_id ?? target.target_external_id ?? ""
      ).trim(),
      orderId: String(target.external_order_id ?? "").trim(),
      expectedInvoiceNumber: String(
        target.invoice_number_snapshot ?? ""
      ).trim(),
    }))
    .filter((target) => target.shipmentId);
  const unresolvedShipmentIds = shipmentTargets
    .filter((target) => !target.orderId)
    .map((target) => target.shipmentId);

  if (unresolvedShipmentIds.length === 0) {
    return shipmentTargets;
  }

  const rawRows = await prisma.coupang_order_raw.findMany({
    where: { external_shipment_id: { in: unresolvedShipmentIds } },
    orderBy: { coupang_order_raw_id: "desc" },
    select: {
      external_order_id: true,
      external_shipment_id: true,
    },
  });
  const orderIdByShipmentId = new Map<string, string>();

  for (const row of rawRows) {
    if (!orderIdByShipmentId.has(row.external_shipment_id)) {
      orderIdByShipmentId.set(
        row.external_shipment_id,
        row.external_order_id
      );
    }
  }

  return shipmentTargets.map((target) => ({
    ...target,
    orderId: target.orderId || orderIdByShipmentId.get(target.shipmentId) || "",
  }));
}

async function verifyOrderInstruct(
  request: PersistedWriteRequest,
  dependencies: CoupangWriteVerificationDependencies,
  projectionObservation: SalesChannelProjectionObservation,
  mode: "INSTRUCT" | "INVOICE" = "INSTRUCT"
) {
  const targets = await resolveOrderVerificationTargets(request);
  const targetCount = targets.length;
  const snapshots = new Map<string, NormalizedCoupangOrder>();
  const errors = new Map<string, string>();
  const grouped = new Map<string, Set<string>>();

  for (const target of targets) {
    if (!target.orderId) {
      continue;
    }

    const shipmentIds = grouped.get(target.orderId) ?? new Set<string>();
    shipmentIds.add(target.shipmentId);
    grouped.set(target.orderId, shipmentIds);
  }

  const attempts = mode === "INVOICE" ? 3 : DEFAULT_OBSERVATION_ATTEMPTS;
  const delayMs = DEFAULT_OBSERVATION_DELAY_MS;
  const concurrency = DEFAULT_CONCURRENCY;
  let pendingOrderIds = [...grouped.keys()];

  for (let attempt = 0; attempt < attempts && pendingOrderIds.length > 0; attempt += 1) {
    const reads = await mapWithConcurrency(
      pendingOrderIds,
      concurrency,
      async (orderId) => {
        try {
          const response = await traceOperationSpan(
            "COUPANG_TARGETED_VERIFY_READ",
            () =>
              (dependencies.getOrdersheetByOrderId ??
                getCoupangOrdersheetByOrderId)(
                orderId,
                dependencies.credentialContext
              )
          );
          const orders = ordersheetsFromPayload(response.payload).orders;

          for (const order of orders) {
            snapshots.set(
              orderSnapshotKey(order.externalOrderId, order.externalShipmentId),
              order
            );
          }

          errors.delete(orderId);
        } catch (error) {
          errors.set(orderId, errorMessage(error));
        }

        const shipmentIds = grouped.get(orderId) ?? new Set<string>();
        const confirmed = [...shipmentIds].every((shipmentId) => {
          const snapshot = snapshots.get(orderSnapshotKey(orderId, shipmentId));
          const target = targets.find(
            (candidate) =>
              candidate.orderId === orderId &&
              candidate.shipmentId === shipmentId
          );
          return Boolean(
            snapshot &&
              (mode === "INVOICE"
                ? CONFIRMED_INVOICE_STATUSES.has(code(snapshot.channelStatus)) &&
                  snapshot.invoiceNumber === target?.expectedInvoiceNumber
                : CONFIRMED_ORDER_STATUSES.has(code(snapshot.channelStatus)))
          );
        });

        return { orderId, confirmed };
      }
    );

    pendingOrderIds = reads
      .filter((read) => !read.confirmed)
      .map((read) => read.orderId);

    if (pendingOrderIds.length > 0 && attempt + 1 < attempts && delayMs > 0) {
      await sleep(delayMs * (attempt + 1));
    }
  }

  const receivedSnapshots = [...snapshots.values()];
  const observedStatuses = targets.map((target) => {
    const snapshot = target.orderId
      ? snapshots.get(orderSnapshotKey(target.orderId, target.shipmentId))
      : null;

    return {
      externalOrderId: target.orderId,
      externalShipmentId: target.shipmentId,
      externalReceiptId: null,
      observedStatus: snapshot?.channelStatus ?? null,
      observedInvoiceNumber: snapshot?.invoiceNumber ?? null,
    };
  });
  const persistedTargets = request.targets.filter(
    (target) => target.target_type === "SHIPMENT_BOX"
  );
  const targetGroups = groupSalesChannelWriteTargets({
    requestType: request.request_type,
    requestTargetExternalId: request.target_external_id,
    targets: persistedTargets,
  }).map((group) => {
    const resolvedGroupTargets = group.targetIds.map((targetId) => {
      const target = targets.find((candidate) => candidate.targetId === targetId);
      if (!target) {
        throw new Error(`Write verification target ${targetId} was not resolved.`);
      }
      return target;
    });
    const expectedInvoiceNumbers = new Set(
      resolvedGroupTargets
        .map((target) => target.expectedInvoiceNumber)
        .filter(Boolean)
    );
    const confirmed =
      (mode !== "INVOICE" || expectedInvoiceNumbers.size === 1) &&
      resolvedGroupTargets.every((target) => {
        const snapshot = target.orderId
          ? snapshots.get(orderSnapshotKey(target.orderId, target.shipmentId))
          : null;
        return Boolean(
          snapshot &&
            (mode === "INVOICE"
              ? CONFIRMED_INVOICE_STATUSES.has(code(snapshot.channelStatus)) &&
                snapshot.invoiceNumber === target.expectedInvoiceNumber
              : CONFIRMED_ORDER_STATUSES.has(code(snapshot.channelStatus)))
        );
      });
    const groupCode = confirmed
      ? mode === "INVOICE"
        ? "INVOICE_CONFIRMED"
        : "INSTRUCT_CONFIRMED"
      : resolvedGroupTargets.some((target) => errors.has(target.orderId))
        ? "INSTRUCT_VERIFICATION_READ_FAILED"
        : mode === "INVOICE"
          ? "INVOICE_NOT_CONFIRMED"
          : "INSTRUCT_STATUS_NOT_CONFIRMED";

    return {
      groupKey: group.groupKey,
      targetIds: group.targetIds,
      outcome: confirmed ? ("CONFIRMED" as const) : ("UNKNOWN" as const),
      code: groupCode,
    };
  });
  const confirmedCount = targetGroups
    .filter((group) => group.outcome === "CONFIRMED")
    .reduce((count, group) => count + group.targetIds.length, 0);
  const confirmed = targetCount > 0 && confirmedCount === targetCount;
  const partial = confirmedCount > 0 && !confirmed;
  const firstError = errors.values().next().value as string | undefined;

  return {
    result: {
      outcome: confirmed
        ? ("CONFIRMED" as const)
        : partial
          ? ("PARTIAL" as const)
          : ("UNKNOWN" as const),
      code: confirmed
        ? mode === "INVOICE"
          ? "INVOICE_CONFIRMED"
          : "INSTRUCT_CONFIRMED"
        : firstError
          ? "INSTRUCT_VERIFICATION_READ_FAILED"
          : mode === "INVOICE"
            ? "INVOICE_NOT_CONFIRMED"
            : "INSTRUCT_STATUS_NOT_CONFIRMED",
      messageArguments: { confirmedCount, targetCount },
      externalErrorSnapshot: firstError ?? null,
      endpointPath:
        "/v2/providers/openapi/apis/api/v5/vendors/{vendorId}/{orderId}/ordersheets",
      targetCount,
      confirmedCount,
      targetGroups,
      observedStatuses,
    } satisfies CoupangWriteVerificationResult,
    observedAt: databaseNow(),
    orderSnapshots: receivedSnapshots,
    returnSnapshots: [],
    projectionObservation,
    inventoryObservation: null,
  } satisfies CoupangWriteVerificationObservation;
}

function returnObservedStatus(
  requestType: string,
  returnRequest: NormalizedCoupangReturn
) {
  return requestType ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.returnStoppedShipment
    ? returnRequest.releaseStatus
    : returnRequest.receiptStatus;
}

async function resolveReturnIdentity(request: PersistedWriteRequest) {
  const receiptId = String(request.target_external_id ?? "").trim();
  const targetOrderId = request.targets
    .map((target) => String(target.external_order_id ?? "").trim())
    .find(Boolean);
  let externalOrderId = String(request.external_order_id ?? targetOrderId ?? "").trim();

  if ((!externalOrderId || !receiptId) && receiptId) {
    const raw = await prisma.coupang_return_raw.findUnique({
      where: { external_receipt_id: receiptId },
      select: { external_order_id: true },
    });
    externalOrderId ||= String(raw?.external_order_id ?? "").trim();
  }

  return { receiptId, externalOrderId };
}

async function verifyReturnWrite(
  request: PersistedWriteRequest,
  dependencies: CoupangWriteVerificationDependencies,
  projectionObservation: SalesChannelProjectionObservation
) {
  const { receiptId, externalOrderId } = await resolveReturnIdentity(request);
  const expectedStatus = code(request.requested_after_status);
  const targetGroups = groupSalesChannelWriteTargets({
    requestType: request.request_type,
    requestTargetExternalId: request.target_external_id,
    targets: request.targets,
  });
  const targetGroup = targetGroups[0];
  if (
    targetGroups.length !== 1 ||
    !targetGroup ||
    targetGroup.targetIds.length !== request.targets.length
  ) {
    throw new Error(
      `Return write request ${request.sales_channel_write_request_id} does not contain exactly one complete receipt target group.`
    );
  }
  const attempts = DEFAULT_OBSERVATION_ATTEMPTS;
  const delayMs = DEFAULT_OBSERVATION_DELAY_MS;
  let latestReturn: NormalizedCoupangReturn | null = null;
  let latestError = "";

  if (receiptId && externalOrderId) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let nextToken: string | null = null;
      let pageCount = 0;

      try {
        do {
          const response = await traceOperationSpan(
            "COUPANG_TARGETED_VERIFY_READ",
            () =>
              (dependencies.getReturnRequests ?? getCoupangReturnRequests)(
                {
                  searchType: "orderId",
                  orderId: externalOrderId,
                  cancelType: "RETURN",
                  nextToken,
                  maxPerPage: 50,
                },
                dependencies.credentialContext
              )
          );
          const rows = returnRequestsFromPayload(response.payload);
          latestReturn =
            rows.find((row) => row.externalReceiptId === receiptId) ??
            latestReturn;
          nextToken = nextTokenFromPayload(response.payload);
          pageCount += 1;
        } while (!latestReturn && nextToken && pageCount < MAX_RETURN_PAGES);

        latestError = "";
      } catch (error) {
        latestError = errorMessage(error);
      }

      if (
        latestReturn &&
        code(returnObservedStatus(request.request_type, latestReturn)) ===
          expectedStatus
      ) {
        break;
      }

      if (attempt + 1 < attempts && delayMs > 0) {
        await sleep(delayMs * (attempt + 1));
      }
    }
  }

  const observedStatus = latestReturn
    ? returnObservedStatus(request.request_type, latestReturn)
    : null;
  const confirmed = Boolean(
    receiptId &&
      externalOrderId &&
      expectedStatus &&
      code(observedStatus) === expectedStatus
  );
  return {
    result: {
      outcome: confirmed ? ("CONFIRMED" as const) : ("UNKNOWN" as const),
      code: confirmed
        ? "RETURN_STATUS_CONFIRMED"
        : latestError
          ? "RETURN_VERIFICATION_READ_FAILED"
          : latestReturn
            ? "RETURN_STATUS_NOT_CONFIRMED"
            : "RETURN_RECEIPT_NOT_FOUND",
      messageArguments: {
        receiptId,
        expectedStatus,
        receiptStatus: latestReturn?.receiptStatus ?? null,
        releaseStatus: latestReturn?.releaseStatus ?? null,
      },
      externalErrorSnapshot: latestError,
      endpointPath:
        "/v2/providers/openapi/apis/api/v6/vendors/{vendorId}/returnRequests?searchType=orderId&orderId={orderId}",
      targetCount: 1,
      confirmedCount: confirmed ? 1 : 0,
      targetGroups: [
        {
          groupKey: targetGroup.groupKey,
          targetIds: targetGroup.targetIds,
          outcome: confirmed ? "CONFIRMED" : "UNKNOWN",
          code: confirmed
            ? "RETURN_STATUS_CONFIRMED"
            : latestError
              ? "RETURN_VERIFICATION_READ_FAILED"
              : latestReturn
                ? "RETURN_STATUS_NOT_CONFIRMED"
                : "RETURN_RECEIPT_NOT_FOUND",
        },
      ],
      observedStatuses: [
        {
          externalOrderId,
          externalShipmentId: latestReturn?.externalShipmentId ?? null,
          externalReceiptId: receiptId || null,
          observedStatus,
        },
      ],
    } satisfies CoupangWriteVerificationResult,
    observedAt: databaseNow(),
    orderSnapshots: [],
    returnSnapshots: latestReturn ? [latestReturn] : [],
    projectionObservation,
    inventoryObservation: null,
  } satisfies CoupangWriteVerificationObservation;
}

export async function observeCoupangWriteRequest(input: {
  requestId: number;
  triggerType: "IMMEDIATE_VERIFY" | "MANUAL_RECHECK";
  targetIds?: readonly number[];
}, dependencies: CoupangWriteVerificationDependencies = {}) {
  void input.triggerType;
  const persistedRequest = await loadPersistedWriteRequest(input.requestId);
  const request = input.targetIds
    ? {
        ...persistedRequest,
        targets: persistedRequest.targets.filter((target) =>
          input.targetIds!.includes(
            target.sales_channel_write_request_target_id
          )
        ),
      }
    : persistedRequest;

  if (request.targets.length === 0) {
    throw new Error(
      `Sales-channel write request ${input.requestId} has no verification targets.`
    );
  }

  if (
    request.request_type ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInventoryQuantityUpdate
  ) {
    return verifyInventoryQuantityWrite(
      request,
      await dependenciesWithCredentialContext(
        request.request_type,
        dependencies
      )
    );
  }

  if (
    request.request_type ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct
  ) {
    const projectionObservation =
      await reserveSalesChannelProjectionObservation();
    return verifyOrderInstruct(
      request,
      await dependenciesWithCredentialContext(
        request.request_type,
        dependencies
      ),
      projectionObservation
    );
  }

  if (
    request.request_type ===
      SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload ||
    request.request_type ===
      SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate
  ) {
    const projectionObservation =
      await reserveSalesChannelProjectionObservation();
    return verifyOrderInstruct(
      request,
      await dependenciesWithCredentialContext(
        request.request_type,
        dependencies
      ),
      projectionObservation,
      "INVOICE"
    );
  }

  if (
    request.request_type ===
      SALES_CHANNEL_WRITE_REQUEST_TYPE.returnStoppedShipment ||
    request.request_type ===
      SALES_CHANNEL_WRITE_REQUEST_TYPE.returnReceiveConfirmation ||
    request.request_type === SALES_CHANNEL_WRITE_REQUEST_TYPE.returnApproval
  ) {
    const projectionObservation =
      await reserveSalesChannelProjectionObservation();
    return verifyReturnWrite(
      request,
      await dependenciesWithCredentialContext(
        request.request_type,
        dependencies
      ),
      projectionObservation
    );
  }

  throw new Error(
    `Unsupported Coupang write verification type: ${request.request_type}`
  );
}

export async function persistCoupangWriteVerificationObservation(
  tx: Prisma.TransactionClient,
  observation: CoupangWriteVerificationObservation,
  dependencies: Pick<
    CoupangWriteVerificationDependencies,
    "recordInventoryObservation"
  > = {}
) {
  if (observation.orderSnapshots.length > 0) {
    if (!observation.projectionObservation) {
      throw new Error("Coupang order observation has no projection revision.");
    }
    await persistCoupangOrderRawSnapshotsInTransaction(
      tx,
      observation.orderSnapshots,
      observation.projectionObservation,
      observation.observedAt
    );
  }

  if (observation.returnSnapshots.length > 0) {
    if (!observation.projectionObservation) {
      throw new Error("Coupang return observation has no projection revision.");
    }
    await persistCoupangReturnRawSnapshotsInTransaction(
      tx,
      observation.returnSnapshots,
      observation.projectionObservation,
      observation.observedAt
    );
  }

  if (observation.inventoryObservation) {
    await (
      dependencies.recordInventoryObservation ??
      recordCoupangInventoryRepairVerificationObservation
    )({
      ...observation.inventoryObservation,
      client: tx,
    });
  }
}

export async function verifyAndRefreshCoupangWriteRequest(
  input: {
    requestId: number;
    triggerType: "IMMEDIATE_VERIFY" | "MANUAL_RECHECK";
  },
  dependencies: CoupangWriteVerificationDependencies = {}
) {
  const observation = await observeCoupangWriteRequest(input, dependencies);

  await runMeasuredTransaction(
    prisma,
    "coupang.targeted-write-verification-observation",
    (tx) =>
      persistCoupangWriteVerificationObservation(tx, observation, dependencies)
  );

  return observation.result;
}

export async function refreshCoupangOrderAddressesAfterInstruct(
  input: { requestId: number; targetIds?: readonly number[] },
  dependencies: CoupangWriteVerificationDependencies = {}
): Promise<CoupangOrderAddressRefreshResult> {
  const request = await loadPersistedWriteRequest(input.requestId);

  if (
    request.request_type !==
    SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct
  ) {
    throw new Error(
      `Address refresh is only supported for Coupang order instruct writes: ${request.request_type}`
    );
  }

  const credentialDependencies = await dependenciesWithCredentialContext(
    request.request_type,
    dependencies
  );
  const scopedRequest = input.targetIds
    ? {
        ...request,
        targets: request.targets.filter((target) =>
          input.targetIds!.includes(
            target.sales_channel_write_request_target_id
          )
        ),
      }
    : request;
  const resolvedTargets = await resolveOrderVerificationTargets(scopedRequest);
  const targetByKey = new Map(
    resolvedTargets.map((target) => [
      orderSnapshotKey(target.orderId, target.shipmentId),
      target,
    ])
  );
  const orderIds = Array.from(
    new Set(
      [...targetByKey.values()].map((target) => target.orderId).filter(Boolean)
    )
  );
  const snapshots = new Map<string, NormalizedCoupangOrder>();
  const projectionObservation =
    await reserveSalesChannelProjectionObservation();

  await mapWithConcurrency(
    orderIds,
    DEFAULT_CONCURRENCY,
    async (orderId) => {
      try {
        const response = await traceOperationSpan(
          "COUPANG_POST_ACKNOWLEDGEMENT_ADDRESS_REFRESH",
          () =>
            (credentialDependencies.getOrdersheetByOrderId ??
              getCoupangOrdersheetByOrderId)(
              orderId,
              credentialDependencies.credentialContext
            )
        );
        const orders = ordersheetsFromPayload(response.payload).orders;

        for (const order of orders) {
          const key = orderSnapshotKey(
            order.externalOrderId,
            order.externalShipmentId
          );

          if (targetByKey.has(key)) {
            snapshots.set(key, order);
          }
        }
      } catch {
        // Address refresh is best-effort. Missing targets are reported by count.
      }
    }
  );

  const observedAt = databaseNow();
  const persistence = await runMeasuredTransaction(
    prisma,
    "coupang.post-acknowledgement-address-refresh",
    (tx) =>
      persistCoupangOrderAddressSnapshotsInTransaction(
        tx,
        [...snapshots.values()],
        projectionObservation,
        observedAt
      )
  );
  const targetCount = targetByKey.size;
  const refreshedTargetCount = persistence.refreshedTargetCount;
  const failedTargetCount = Math.max(0, targetCount - refreshedTargetCount);
  const status =
    targetCount > 0 && refreshedTargetCount === targetCount
      ? ("SUCCEEDED" as const)
      : refreshedTargetCount > 0
        ? ("PARTIAL" as const)
        : ("FAILED" as const);

  return {
    status,
    code:
      status === "SUCCEEDED"
        ? "ORDER_ADDRESS_SNAPSHOT_REFRESHED"
        : status === "PARTIAL"
          ? "ORDER_ADDRESS_SNAPSHOT_PARTIALLY_REFRESHED"
          : "ORDER_ADDRESS_SNAPSHOT_NOT_REFRESHED",
    endpointPath:
      "/v2/providers/openapi/apis/api/v5/vendors/{vendorId}/{orderId}/ordersheets",
    targetCount,
    refreshedTargetCount,
    failedTargetCount,
  };
}
