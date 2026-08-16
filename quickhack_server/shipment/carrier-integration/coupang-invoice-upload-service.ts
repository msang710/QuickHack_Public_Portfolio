import { prisma } from "@/quickhack_server/core/prisma";
import {
  getCoupangOrdersheetByOrderId,
  openCoupangApiCredentialContext,
  type CoupangApiCredentialContext,
} from "@/quickhack_server/sales-channel/coupang/api-client";
import {
  ordersheetsFromPayload,
  persistCoupangOrderRawSnapshots,
  type NormalizedCoupangOrder,
} from "@/quickhack_server/sales-channel/coupang/sync-service";
import { reserveSalesChannelProjectionObservation } from "@/quickhack_server/sales-channel/projection-revision-service";
import { assertSalesChannelWriteAllowed } from "@/quickhack_server/sales-channel/coupang/write-adapter";
import { requestSalesChannelWrite } from "@/quickhack_server/sales-channel/write/sales-channel-write-service";
import { isSalesChannelWriteRequestRetryable } from "@/quickhack_server/sales-channel/write/sales-channel-write-retry-policy";
import { assertNoShipmentReturnConflicts } from "@/quickhack_server/returns/shipment-return-conflict-service";
import {
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
  type SalesChannelWriteCommand,
} from "@/quickhack_shared/sales-channel/write-requests";
import { finalizePersistedCoupangInvoiceUpload } from "@/quickhack_server/shipment/carrier-integration/coupang-invoice-finalizer";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import type { InvoiceChannelSubmission } from "@/quickhack_server/shipment/carrier-integration/invoice-submission-response";

const DELIVERY_COMPANY_CODE = "KGB";
const TRACKING_NUMBER_PATTERN = /^\d{11}$/;
const MAX_CONCURRENCY = 4;

type InvoiceSubmissionDependencies = {
  getOrdersheetByOrderId?: typeof getCoupangOrdersheetByOrderId;
  requestWrite?: typeof requestSalesChannelWrite;
  credentialContext?: CoupangApiCredentialContext;
  openCredentialContext?: typeof openCoupangApiCredentialContext;
};

export class CoupangInvoiceSubmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CoupangInvoiceSubmissionError";
    this.code = code;
  }
}

function requiredPositiveId(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CoupangInvoiceSubmissionError(
      "INVALID_ID",
      `${label} must be a positive integer.`
    );
  }
  return parsed;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function numericId(value: unknown, label: string) {
  const normalized = text(value);
  if (!/^\d+$/.test(normalized) || normalized === "0") {
    throw new CoupangInvoiceSubmissionError(
      "INVALID_COUPANG_ID",
      `${label} must be a positive numeric identifier.`
    );
  }
  return normalized;
}

function receiverAddress(order: NormalizedCoupangOrder) {
  return [
    order.receiverPostCode,
    order.receiverAddress1,
    order.receiverAddress2,
  ]
    .map(text)
    .filter(Boolean)
    .join(" / ");
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  mapper: (value: T) => Promise<R>
) {
  const results = new Array<R>(values.length);
  let cursor = 0;

  async function consume() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENCY, Math.max(values.length, 1)) },
      () => consume()
    )
  );
  return results;
}

function snapshotKey(orderId: string, shipmentId: string) {
  return `${orderId}\u0000${shipmentId}`;
}

export async function submitCoupangInvoicesForIssueBatch(
  input: {
    issueBatchId: unknown;
    userId?: number | null;
  },
  dependencies: InvoiceSubmissionDependencies = {}
) {
  const issueBatchId = requiredPositiveId(input.issueBatchId, "issueBatchId");
  const batch = await prisma.carrier_invoice_issue_batches.findUnique({
    where: { carrier_invoice_issue_batch_id: issueBatchId },
    include: {
      items: {
        orderBy: { issue_sequence: "asc" },
        include: {
          carrier_shipment: true,
          package_group: {
            include: {
              members: {
                where: { removed_at: null },
                orderBy: { member_sequence: "asc" },
                include: {
                  allocation: {
                    include: {
                      order: true,
                      device: {
                        include: {
                          inventory: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!batch) {
    throw new CoupangInvoiceSubmissionError(
      "ISSUE_BATCH_NOT_FOUND",
      "The carrier invoice issue batch was not found."
    );
  }
  if (batch.batch_status !== "ALLOCATED") {
    throw new CoupangInvoiceSubmissionError(
      "ISSUE_BATCH_NOT_ALLOCATED",
      "Only a fully allocated carrier invoice batch can be submitted to Coupang."
    );
  }
  if (
    batch.items.length === 0 ||
    batch.items.some(
      (item) => item.item_status !== "ALLOCATED" || !item.carrier_shipment
    )
  ) {
    throw new CoupangInvoiceSubmissionError(
      "ISSUE_ITEMS_NOT_ALLOCATED",
      "Every carrier invoice issue item must have an allocated tracking number."
    );
  }

  const allocationIds: number[] = [];
  const commands: SalesChannelWriteCommand[] = [];
  const completedHistoryResults: Array<{
    requestId: number | null;
    status: string;
    skipped: boolean;
    error: string | null;
  }> = [];

  for (const item of batch.items) {
    const group = item.package_group;
    const shipment = item.carrier_shipment!;
    if (group.current_carrier_shipment_id !== shipment.carrier_shipment_id) {
      throw new CoupangInvoiceSubmissionError(
        "PACKAGE_GROUP_NOT_FROZEN",
        `Package group ${group.package_group_id} is no longer frozen with the allocated tracking number.`
      );
    }
    if (!TRACKING_NUMBER_PATTERN.test(shipment.tracking_number)) {
      throw new CoupangInvoiceSubmissionError(
        "INVALID_LOGEN_TRACKING_NUMBER",
        `Package group ${group.package_group_id} has an invalid Logen tracking number.`
      );
    }
    if (group.members.length === 0) {
      throw new CoupangInvoiceSubmissionError(
        "PACKAGE_GROUP_EMPTY",
        `Package group ${group.package_group_id} has no active members.`
      );
    }

    if (group.group_status === "READY") {
      const completedRequests =
        await prisma.sales_channel_write_requests.findMany({
          where: {
            channel: "COUPANG",
            request_type:
              SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload,
            request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.completed,
            package_group_id: group.package_group_id,
            carrier_shipment_id: shipment.carrier_shipment_id,
          },
          include: { targets: true },
        });
      const coveredShipmentIds = new Set(
        completedRequests.flatMap((request) =>
          request.targets
            .map((target) => text(target.external_shipment_id))
            .filter(Boolean)
        )
      );
      const fullyCovered = group.members.every((member) =>
        coveredShipmentIds.has(member.external_shipment_id)
      );
      if (!fullyCovered) {
        throw new CoupangInvoiceSubmissionError(
          "READY_HISTORY_INCOMPLETE",
          `Package group ${group.package_group_id} is READY but its completed Coupang invoice history is incomplete.`
        );
      }
      completedHistoryResults.push(
        ...completedRequests.map((request) => ({
          requestId: request.sales_channel_write_request_id,
          status: request.request_status,
          skipped: true,
          error: request.error_message,
        }))
      );
      continue;
    }
    if (group.group_status !== "FROZEN") {
      throw new CoupangInvoiceSubmissionError(
        "PACKAGE_GROUP_NOT_FROZEN",
        `Package group ${group.package_group_id} must be FROZEN before Coupang invoice upload.`
      );
    }

    const membersByShipment = new Map<
      string,
      typeof group.members
    >();
    for (const member of group.members) {
      const allocation = member.allocation;
      allocationIds.push(allocation.allocation_id);
      if (
        allocation.device.inventory?.inventory_status !== "PACKED"
      ) {
        throw new CoupangInvoiceSubmissionError(
          "SHIPMENT_MEMBER_NOT_PACKED",
          `PG ${allocation.pg_no} must be PACKED before its Coupang invoice can be uploaded.`
        );
      }
      if (
        allocation.allocation_status !== "SHIPMENT_LIST_PRINTED" ||
        allocation.external_order_id !== member.external_order_id ||
        allocation.external_shipment_id !== member.external_shipment_id ||
        allocation.order.external_order_status !== "INSTRUCT"
      ) {
        throw new CoupangInvoiceSubmissionError(
          "SHIPMENT_MEMBER_CHANGED",
          `Package group ${group.package_group_id} no longer matches its confirmed INSTRUCT shipment snapshot (allocationStatus=${allocation.allocation_status}, allocationOrder=${allocation.external_order_id}/${allocation.external_shipment_id}, memberOrder=${member.external_order_id}/${member.external_shipment_id}, channelStatus=${allocation.order.external_order_status}).`
        );
      }
      if (!text(allocation.external_vendor_item_id)) {
        throw new CoupangInvoiceSubmissionError(
          "VENDOR_ITEM_ID_MISSING",
          `Allocation ${allocation.allocation_id} has no Coupang vendorItemId.`
        );
      }

      const current = membersByShipment.get(member.external_shipment_id) ?? [];
      current.push(member);
      membersByShipment.set(member.external_shipment_id, current);
    }

    for (const [shipmentId, members] of membersByShipment) {
      const first = members[0];
      const orderId = numericId(first.external_order_id, "orderId");
      const externalShipmentId = numericId(shipmentId, "shipmentBoxId");
      if (
        members.some(
          (member) => text(member.external_order_id) !== first.external_order_id
        )
      ) {
        throw new CoupangInvoiceSubmissionError(
          "SHIPMENT_IDENTITY_CONFLICT",
          `Coupang shipment ${externalShipmentId} is linked to more than one orderId.`
        );
      }
      const invoiceItems = Array.from(
        new Map(
          members.map((member) => {
            const vendorItemId = numericId(
              member.allocation.external_vendor_item_id,
              "vendorItemId"
            );
            return [
              vendorItemId,
              {
                shipmentBoxId: externalShipmentId,
                orderId,
                vendorItemId,
                deliveryCompanyCode: DELIVERY_COMPANY_CODE,
                invoiceNumber: shipment.tracking_number,
                splitShipping: false as const,
                preSplitShipped: false as const,
                estimatedShippingDate: "" as const,
              },
            ];
          })
        ).values()
      );

      commands.push({
        channel: "COUPANG",
        requestType: SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload,
        idempotencyKey: `COUPANG_INVOICE_UPLOAD:${shipment.carrier_shipment_id}:${externalShipmentId}`,
        externalOrderId: orderId,
        targetType: "SHIPMENT_BOX",
        targetExternalId: externalShipmentId,
        packageGroupId: group.package_group_id,
        carrierShipmentId: shipment.carrier_shipment_id,
        expectedBeforeStatus: "INSTRUCT",
        requestedAfterStatus: "DEPARTURE",
        sourceMenuKey: "shipment.invoice.issue",
        sourceEntityType: "CARRIER_INVOICE_ISSUE_BATCH",
        sourceEntityId: String(issueBatchId),
        requestedByUserId: input.userId ?? null,
        invoiceItems,
        targets: members.map((member) => {
          const vendorItemId = numericId(
            member.allocation.external_vendor_item_id,
            "vendorItemId"
          );
          return {
            targetType: "SHIPMENT_BOX",
            targetExternalId: externalShipmentId,
            allocationId: member.allocation_id,
            pgNo: member.allocation.pg_no,
            externalOrderId: orderId,
            externalShipmentId,
            externalVendorItemId: vendorItemId,
            packageGroupId: group.package_group_id,
            carrierShipmentId: shipment.carrier_shipment_id,
            deliveryCompanyCode: DELIVERY_COMPANY_CODE,
            invoiceNumberSnapshot: shipment.tracking_number,
            splitShipping: false,
            preSplitShipped: false,
            estimatedShippingDate: "",
            expectedBeforeStatus: "INSTRUCT",
            requestedAfterStatus: "DEPARTURE",
          };
        }),
      });
    }
  }

  if (allocationIds.length > 0) {
    await assertNoShipmentReturnConflicts(prisma, allocationIds);
  }
  if (commands.length === 0 && completedHistoryResults.length === 0) {
    throw new CoupangInvoiceSubmissionError(
      "SUBMISSION_TARGET_EMPTY",
      "No Coupang shipments are available for invoice upload."
    );
  }

  const existingRequests =
    commands.length === 0
      ? []
      : await prisma.sales_channel_write_requests.findMany({
          where: {
            idempotency_key: {
              in: commands.map((command) => command.idempotencyKey),
            },
          },
        });
  const existingByIdempotencyKey = new Map(
    existingRequests.map((request) => [request.idempotency_key, request])
  );
  const executionPlans = commands.map((command) => {
    const existing = existingByIdempotencyKey.get(command.idempotencyKey);
    return {
      command,
      existing,
      execute:
        !existing ||
        isSalesChannelWriteRequestRetryable(existing.request_status),
    };
  });
  const executableCommands = executionPlans
    .filter((plan) => plan.execute)
    .map((plan) => plan.command);

  if (executableCommands.length > 0) {
    assertSalesChannelWriteAllowed(executableCommands[0]);
  }

  const useInjectedExternalCalls = Boolean(
    dependencies.getOrdersheetByOrderId && dependencies.requestWrite
  );
  const credentialContext =
    executableCommands.length === 0
      ? undefined
      : dependencies.credentialContext ??
        (useInjectedExternalCalls
          ? undefined
          : await (
              dependencies.openCredentialContext ??
              openCoupangApiCredentialContext
            )("CACHED_READ"));
  const orderIds = Array.from(
    new Set(
      executableCommands.map((command) => text(command.externalOrderId))
    )
  );
  const observation =
    orderIds.length > 0
      ? await reserveSalesChannelProjectionObservation()
      : null;
  const freshOrders = (
    await mapWithConcurrency(orderIds, async (orderId) => {
      const response = await (
        dependencies.getOrdersheetByOrderId ?? getCoupangOrdersheetByOrderId
      )(orderId, credentialContext);
      return ordersheetsFromPayload(response.payload).orders;
    })
  ).flat();

  if (freshOrders.length > 0 && observation) {
    await persistCoupangOrderRawSnapshots(freshOrders, observation);
  }
  const freshByKey = new Map(
    freshOrders.map((order) => [
      snapshotKey(order.externalOrderId, order.externalShipmentId),
      order,
    ])
  );

  for (const command of executableCommands) {
    const invoiceCommand = command.requestType === "COUPANG_INVOICE_UPLOAD"
      ? command
      : null;
    if (!invoiceCommand) continue;
    const firstItem = invoiceCommand.invoiceItems[0];
    const fresh = freshByKey.get(
      snapshotKey(firstItem.orderId, firstItem.shipmentBoxId)
    );
    const group = batch.items.find(
      (item) =>
        item.package_group_id === invoiceCommand.packageGroupId
    )?.package_group;

    if (!fresh || !group) {
      throw new CoupangInvoiceSubmissionError(
        "TARGETED_ORDER_NOT_FOUND",
        `Coupang shipment ${firstItem.shipmentBoxId} was not returned by the targeted preflight read.`
      );
    }
    if (fresh.channelStatus !== "INSTRUCT") {
      throw new CoupangInvoiceSubmissionError(
        "ORDER_STATUS_CHANGED",
        `Coupang shipment ${firstItem.shipmentBoxId} is ${fresh.channelStatus ?? "UNKNOWN"}, not INSTRUCT.`
      );
    }
    if (fresh.splitShipping === true) {
      throw new CoupangInvoiceSubmissionError(
        "SPLIT_SHIPPING_NOT_SUPPORTED",
        `Coupang shipment ${firstItem.shipmentBoxId} requires the split-shipping workflow.`
      );
    }
    if (
      text(fresh.receiverName) !== text(group.receiver_name_snapshot) ||
      receiverAddress(fresh) !== text(group.receiver_address_snapshot)
    ) {
      throw new CoupangInvoiceSubmissionError(
        "RECEIVER_CHANGED",
        `Coupang shipment ${firstItem.shipmentBoxId} receiver information changed after the package group was frozen.`
      );
    }
    const activeVendorItemIds = new Set(
      fresh.items
        .filter((item) => item.availableQuantity > 0 && item.canceled === 0)
        .map((item) => item.externalVendorItemId)
    );
    if (
      invoiceCommand.invoiceItems.some(
        (item) => !activeVendorItemIds.has(item.vendorItemId)
      )
    ) {
      throw new CoupangInvoiceSubmissionError(
        "VENDOR_ITEM_CHANGED",
        `Coupang shipment ${firstItem.shipmentBoxId} no longer contains every allocated vendorItemId.`
      );
    }
  }

  const results = completedHistoryResults.concat(
    await mapWithConcurrency(executionPlans, async (plan) => {
      const { command, existing } = plan;
      if (!plan.execute && existing) {
        return {
          requestId: existing.sales_channel_write_request_id,
          status: existing.request_status,
          skipped: true,
          error: existing.error_message,
        };
      }

      try {
        const result = await (
          dependencies.requestWrite ?? requestSalesChannelWrite
        )(
          command,
          {
            finalize: ({ tx, requestId, targetIds, finalizedAt }) =>
              finalizePersistedCoupangInvoiceUpload({
                tx,
                requestId,
                targetIds,
                actorUserId: input.userId ?? null,
                finalizedAt,
              }).then(() => undefined),
          },
          undefined
        );
        return {
          requestId: result.requestId,
          status: result.status,
          skipped: false,
          error: null,
        };
      } catch (error) {
        const persisted = await prisma.sales_channel_write_requests.findUnique({
          where: { idempotency_key: command.idempotencyKey },
        });
        return {
          requestId: persisted?.sales_channel_write_request_id ?? null,
          status: persisted?.request_status ?? "FAILED",
          skipped: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  const groupReconciliationErrors: Array<{
    packageGroupId: number;
    requestId: number | null;
    errorCode: "LOCAL_GROUP_FINALIZATION_FAILED";
  }> = [];
  const groups = Array.from(
    new Map(
      batch.items.map((item) => [
        item.package_group_id,
        {
          packageGroupId: item.package_group_id,
          carrierShipmentId: item.carrier_shipment_id,
        },
      ])
    ).values()
  ).sort((left, right) => left.packageGroupId - right.packageGroupId);
  for (const group of groups) {
    const completedRequest =
      await prisma.sales_channel_write_requests.findFirst({
        where: {
          channel: "COUPANG",
          request_type: SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload,
          request_status: SALES_CHANNEL_WRITE_REQUEST_STATUS.completed,
          package_group_id: group.packageGroupId,
          carrier_shipment_id: group.carrierShipmentId,
        },
        orderBy: { sales_channel_write_request_id: "asc" },
        include: {
          targets: {
            where: { external_result_status: "SUCCEEDED" },
            select: { sales_channel_write_request_target_id: true },
          },
        },
      });
    if (!completedRequest || completedRequest.targets.length === 0) continue;
    try {
      await prisma.$transaction((tx) =>
        finalizePersistedCoupangInvoiceUpload({
          tx,
          requestId: completedRequest.sales_channel_write_request_id,
          targetIds: completedRequest.targets.map(
            (target) => target.sales_channel_write_request_target_id
          ),
          actorUserId: input.userId ?? null,
          finalizedAt: databaseNow(),
        })
      );
    } catch {
      groupReconciliationErrors.push({
        packageGroupId: group.packageGroupId,
        requestId: completedRequest.sales_channel_write_request_id,
        errorCode: "LOCAL_GROUP_FINALIZATION_FAILED",
      });
    }
  }

  const completedCount = results.filter(
    (result) => result.status === SALES_CHANNEL_WRITE_REQUEST_STATUS.completed
  ).length;
  const reviewRequiredCount = results.filter((result) =>
    [
      SALES_CHANNEL_WRITE_REQUEST_STATUS.reviewRequired,
      SALES_CHANNEL_WRITE_REQUEST_STATUS.localPending,
    ].includes(
      result.status as
        | "REVIEW_REQUIRED"
        | "LOCAL_PENDING"
    )
  ).length;
  const status =
    groupReconciliationErrors.length > 0
      ? "REVIEW_REQUIRED"
    : completedCount === results.length
      ? "COMPLETED"
      : reviewRequiredCount > 0
        ? "REVIEW_REQUIRED"
        : completedCount > 0
          ? "PARTIAL"
          : "FAILED";

  return {
    issueBatchId,
    status: status as InvoiceChannelSubmission["status"],
    targetCount: results.length,
    completedCount,
    reviewRequiredCount:
      reviewRequiredCount + groupReconciliationErrors.length,
    groupReconciliationErrors,
    requests: results,
  };
}
