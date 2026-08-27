import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { assertNoShipmentReturnConflicts } from "@/quickhack_server/returns/shipment-return-conflict-service";
import {
  CarrierApiCallFailureError,
  allocateLogenTrackingNumbers,
  type LogenTrackingNumberAllocationItem,
} from "@/quickhack_server/shipment/carrier-integration/logen/workflow-service";
import {
  CarrierShipmentStateConflictError,
  transitionCarrierInvoiceStatus,
} from "@/quickhack_server/shipment/carrier-integration/carrier-shipment-state-service";
import {
  CarrierShipmentRevisionConflictError,
  CarrierTrackingNumberConflictError,
  upsertCarrierShipment,
} from "@/quickhack_server/shipment/carrier-integration/persistence-service";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { isPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";
import {
  CARRIER_INVOICE_STATUS,
  type CarrierInvoiceStatus,
} from "@/quickhack_shared/shipment/carrier-invoice-status";
import { CARRIER_SHIPMENT_STATUS } from "@/quickhack_shared/shipment/carrier-tracking-status";
import {
  CARRIER_INVOICE_ISSUE_BATCH_STATUS,
  CARRIER_INVOICE_ISSUE_ITEM_STATUS,
} from "@/quickhack_shared/shipment/carrier-workflow-status";

const CARRIER_CODE = "LOGEN";
const CONFIRMED_BATCH_STATUS = "CONFIRMED";
const FROZEN_PACKAGE_GROUP_STATUS = "FROZEN";
const TRACKING_NUMBER_PATTERN = /^\d{11}$/;

const ISSUE_BATCH_STATUS = CARRIER_INVOICE_ISSUE_BATCH_STATUS;
const ISSUE_ITEM_STATUS = CARRIER_INVOICE_ISSUE_ITEM_STATUS;

const issueBatchInclude = {
  shipment_list_print_batch: {
    select: {
      shipment_list_print_batch_id: true,
      batch_label: true,
      batch_status: true,
    },
  },
  api_call_log: {
    select: {
      carrier_api_call_log_id: true,
      processed_status: true,
      error_code: true,
      error_message: true,
    },
  },
  items: {
    orderBy: { issue_sequence: "asc" },
    include: {
      package_group: {
        select: {
          package_group_id: true,
          group_status: true,
          receiver_name_snapshot: true,
          receiver_address_snapshot: true,
          current_carrier_shipment_id: true,
        },
      },
      carrier_shipment: true,
      registration_work: true,
    },
  },
} satisfies Prisma.carrier_invoice_issue_batchesInclude;

type IssueBatchRow = Prisma.carrier_invoice_issue_batchesGetPayload<{
  include: typeof issueBatchInclude;
}>;

type IssueType = "INITIAL" | "REISSUE";

export type CarrierTrackingAllocationCall = {
  apiCallLogId: number | null;
  allocation: {
    statusCode: string | null;
    statusMessage: string | null;
    items: LogenTrackingNumberAllocationItem[];
  };
};

export type CarrierInvoiceIssueDependencies = {
  allocateTrackingNumbers?: (
    quantity: number
  ) => Promise<CarrierTrackingAllocationCall>;
};

export class CarrierInvoiceIssueError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CarrierInvoiceIssueError";
    this.code = code;
  }
}

function requiredPositiveId(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CarrierInvoiceIssueError(
      "INVALID_ID",
      `${label} must be a positive integer.`
    );
  }
  return parsed;
}

function uniquePositiveIds(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0)
    )
  ).sort((left, right) => left - right);
}

function text(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : error.name;
    return { code: code || "ERROR", message: error.message };
  }
  return { code: "ERROR", message: String(error) };
}

function jsonArray(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toIssueBatchDto(batch: IssueBatchRow) {
  return {
    issueBatchId: batch.carrier_invoice_issue_batch_id,
    shipmentListPrintBatchId: batch.shipment_list_print_batch_id,
    shipmentListPrintBatchLabel: batch.shipment_list_print_batch.batch_label,
    carrierCode: batch.carrier_code,
    issueType: batch.issue_type,
    requestKey: batch.request_key,
    status: batch.batch_status,
    requestedPackageGroupCount: batch.requested_package_group_count,
    allocatedPackageGroupCount: batch.allocated_package_group_count,
    responseItemCount: batch.response_item_count,
    attemptCount: batch.attempt_count,
    allocationRequestDispatched:
      batch.allocation_request_dispatched === 1,
    apiCallLogId: batch.api_call_log_id,
    errorCode: batch.error_code,
    errorMessage: batch.error_message,
    unmatchedResponseItems: jsonArray(batch.unmatched_response_json),
    startedAt: batch.started_at,
    completedAt: batch.completed_at,
    reviewRequiredAt: batch.review_required_at,
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
    items: batch.items.map((item) => ({
      issueItemId: item.carrier_invoice_issue_item_id,
      packageGroupId: item.package_group_id,
      issueSequence: item.issue_sequence,
      revisionNo: item.revision_no,
      status: item.item_status,
      carrierShipmentId: item.carrier_shipment_id,
      trackingNumber:
        item.carrier_shipment?.tracking_number ??
        item.tracking_number_snapshot,
      resultCode: item.result_code,
      resultMessage: item.result_message,
      packageGroupStatus: item.package_group.group_status,
      carrierRegistration: item.registration_work
        ? {
            workId:
              item.registration_work
                .carrier_shipment_registration_work_id,
            status: item.registration_work.work_status,
            fixTakeNo: item.registration_work.fix_take_no,
            takeDate: item.registration_work.take_date,
            attemptCount: item.registration_work.attempt_count,
            receiverBranchCode:
              item.registration_work.receiver_branch_code,
            classificationCode:
              item.registration_work.classification_code,
            deliveryFare: item.registration_work.delivery_fare,
            extraFare: item.registration_work.extra_fare,
            goodsAmount: item.registration_work.goods_amount_snapshot,
            errorCode: item.registration_work.last_error_code,
            errorMessage: item.registration_work.last_error_message,
            registeredAt: item.registration_work.registered_at,
            reviewRequiredAt:
              item.registration_work.review_required_at,
          }
        : null,
    })),
  };
}

async function findIssueBatch(issueBatchId: number) {
  return prisma.carrier_invoice_issue_batches.findUnique({
    where: { carrier_invoice_issue_batch_id: issueBatchId },
    include: issueBatchInclude,
  });
}

export async function getCarrierInvoiceIssueBatch(input: {
  issueBatchId?: unknown;
}) {
  const issueBatchId = requiredPositiveId(input.issueBatchId, "Issue batch ID");
  const batch = await findIssueBatch(issueBatchId);
  if (!batch) {
    throw new CarrierInvoiceIssueError(
      "ISSUE_BATCH_NOT_FOUND",
      "Carrier invoice issue batch was not found."
    );
  }
  return toIssueBatchDto(batch);
}

export async function listCarrierInvoiceIssueBatchesForShipmentPrintBatch(input: {
  shipmentListPrintBatchId?: unknown;
}) {
  const shipmentListPrintBatchId = requiredPositiveId(
    input.shipmentListPrintBatchId,
    "Shipment print batch ID"
  );
  const batches = await prisma.carrier_invoice_issue_batches.findMany({
    where: {
      shipment_list_print_batch_id: shipmentListPrintBatchId,
    },
    include: issueBatchInclude,
    orderBy: [
      { created_at: "desc" },
      { carrier_invoice_issue_batch_id: "desc" },
    ],
  });
  return batches.map(toIssueBatchDto);
}

type PreparedGroup = {
  packageGroupId: number;
  issueSequence: number;
  revisionNo: number;
  expectedCurrentCarrierShipmentId: number | null;
  expectedCurrentInvoiceStatus: CarrierInvoiceStatus | null;
  previousTrackingNumber: string | null;
  firstAllocationId: number;
  firstExternalOrderId: string;
  firstExternalShipmentId: string;
  firstPgNo: string;
};

type PreparedIssue = {
  issueBatchId: number;
  attemptNo: number;
  groups: PreparedGroup[];
  shouldAllocate: boolean;
};

class CarrierInvoiceIssueExecutionOwnershipLostError extends Error {
  readonly code = "CARRIER_INVOICE_ISSUE_EXECUTION_OWNERSHIP_LOST";

  constructor() {
    super("Tracking-number allocation execution ownership changed.");
    this.name = "CarrierInvoiceIssueExecutionOwnershipLostError";
  }
}

function executionOwnershipLost() {
  return new CarrierInvoiceIssueExecutionOwnershipLostError();
}

function isExecutionOwnershipLost(error: unknown) {
  return error instanceof CarrierInvoiceIssueExecutionOwnershipLostError;
}

async function prepareIssue(input: {
  shipmentListPrintBatchId: number;
  issueType: IssueType;
  requestKey: string;
  packageGroupIds: number[] | null;
  userId?: number | null;
  deferCurrentSwitch?: boolean;
}): Promise<PreparedIssue> {
  return runMeasuredTransaction(
    prisma,
    "carrier.invoice-issue.prepare",
    async (tx) => {
      const existing = await tx.carrier_invoice_issue_batches.findUnique({
        where: { request_key: input.requestKey },
      });

      if (existing && existing.batch_status !== ISSUE_BATCH_STATUS.failed) {
        return {
          issueBatchId: existing.carrier_invoice_issue_batch_id,
          attemptNo: existing.attempt_count,
          groups: [],
          shouldAllocate: false,
        };
      }

      const printBatch =
        await tx.sales_channel_shipment_list_print_batches.findUnique({
          where: {
            shipment_list_print_batch_id: input.shipmentListPrintBatchId,
          },
          include: {
            items: {
              orderBy: [
                { print_line_no: "asc" },
                { shipment_list_print_batch_item_id: "asc" },
              ],
            },
          },
        });

      if (!printBatch) {
        throw new CarrierInvoiceIssueError(
          "SHIPMENT_PRINT_BATCH_NOT_FOUND",
          "The confirmed shipment print batch was not found."
        );
      }
      if (printBatch.batch_status !== CONFIRMED_BATCH_STATUS) {
        throw new CarrierInvoiceIssueError(
          "SHIPMENT_PRINT_BATCH_NOT_CONFIRMED",
          "Tracking numbers can only be allocated to a confirmed shipment print batch."
        );
      }
      if (printBatch.items.length === 0) {
        throw new CarrierInvoiceIssueError(
          "SHIPMENT_PRINT_BATCH_EMPTY",
          "The shipment print batch has no package groups."
        );
      }
      if (printBatch.items.some((item) => item.package_group_id == null)) {
        throw new CarrierInvoiceIssueError(
          "PACKAGE_GROUP_SNAPSHOT_MISSING",
          "A shipment print item is missing its package-group snapshot."
        );
      }

      const firstItemByGroup = new Map<
        number,
        (typeof printBatch.items)[number]
      >();
      for (const item of printBatch.items) {
        const packageGroupId = item.package_group_id as number;
        if (!firstItemByGroup.has(packageGroupId)) {
          firstItemByGroup.set(packageGroupId, item);
        }
      }

      const sourceGroupIds = Array.from(firstItemByGroup.keys());
      if (
        printBatch.package_group_count !== sourceGroupIds.length
      ) {
        throw new CarrierInvoiceIssueError(
          "PACKAGE_GROUP_COUNT_MISMATCH",
          "The shipment print batch package-group count does not match its snapshot."
        );
      }

      const requestedReissueGroupIds = input.packageGroupIds ?? [];
      const requestedReissueGroupIdSet = new Set(requestedReissueGroupIds);
      const selectedGroupIds =
        input.issueType === "INITIAL"
          ? sourceGroupIds
          : sourceGroupIds.filter((packageGroupId) =>
              requestedReissueGroupIdSet.has(packageGroupId)
            );
      if (selectedGroupIds.length === 0) {
        throw new CarrierInvoiceIssueError(
          "PACKAGE_GROUP_SELECTION_EMPTY",
          "At least one package group is required for reissue."
        );
      }
      if (
        input.issueType === "REISSUE" &&
        selectedGroupIds.length !== requestedReissueGroupIds.length
      ) {
        throw new CarrierInvoiceIssueError(
          "PACKAGE_GROUP_NOT_IN_PRINT_BATCH",
          "A selected package group does not belong to the shipment print batch."
        );
      }

      const groups = await tx.shipment_package_groups.findMany({
        where: { package_group_id: { in: selectedGroupIds } },
        include: {
          current_carrier_shipment: true,
          carrier_shipments: {
            orderBy: { revision_no: "desc" },
          },
          members: {
            where: { removed_at: null },
            orderBy: { member_sequence: "asc" },
          },
        },
      });
      const groupById = new Map(
        groups.map((group) => [group.package_group_id, group])
      );

      if (groups.length !== selectedGroupIds.length) {
        throw new CarrierInvoiceIssueError(
          "PACKAGE_GROUP_NOT_FOUND",
          "A selected package group was not found."
        );
      }

      const selectedAllocationIds: number[] = [];
      const preparedGroups: PreparedGroup[] = [];

      for (const [index, packageGroupId] of selectedGroupIds.entries()) {
        const group = groupById.get(packageGroupId);
        const firstItem = firstItemByGroup.get(packageGroupId);
        if (!group || !firstItem) {
          throw new CarrierInvoiceIssueError(
            "PACKAGE_GROUP_NOT_FOUND",
            "A selected package group was not found."
          );
        }
        const allowedGroupStatus =
          group.group_status === FROZEN_PACKAGE_GROUP_STATUS ||
          (input.issueType === "REISSUE" &&
            input.deferCurrentSwitch === true &&
            group.group_status === "ON_HOLD");
        if (!allowedGroupStatus) {
          throw new CarrierInvoiceIssueError(
            "PACKAGE_GROUP_NOT_FROZEN",
            `Package group ${packageGroupId} is not eligible for invoice allocation.`
          );
        }

        const snapshotAllocationIds = printBatch.items
          .filter((item) => item.package_group_id === packageGroupId)
          .map((item) => item.allocation_id)
          .sort((left, right) => left - right);
        const activeMemberAllocationIds = group.members
          .map((member) => member.allocation_id)
          .sort((left, right) => left - right);
        if (
          snapshotAllocationIds.length !== activeMemberAllocationIds.length ||
          snapshotAllocationIds.some(
            (allocationId, memberIndex) =>
              allocationId !== activeMemberAllocationIds[memberIndex]
          )
        ) {
          throw new CarrierInvoiceIssueError(
            "PACKAGE_GROUP_MEMBERSHIP_CHANGED",
            `Package group ${packageGroupId} no longer matches the confirmed print snapshot.`
          );
        }

        const currentShipment = group.current_carrier_shipment;
        if (input.issueType === "INITIAL" && currentShipment) {
          throw new CarrierInvoiceIssueError(
            "PACKAGE_GROUP_ALREADY_ALLOCATED",
            `Package group ${packageGroupId} already has a current tracking number.`
          );
        }
        if (input.issueType === "REISSUE" && !currentShipment) {
          throw new CarrierInvoiceIssueError(
            "PACKAGE_GROUP_HAS_NO_CURRENT_INVOICE",
            `Package group ${packageGroupId} has no tracking number to replace.`
          );
        }
        if (
          input.issueType === "REISSUE" &&
          currentShipment &&
          currentShipment.invoice_status !== CARRIER_INVOICE_STATUS.allocated &&
          currentShipment.invoice_status !== CARRIER_INVOICE_STATUS.registered
        ) {
          throw new CarrierInvoiceIssueError(
            "CURRENT_INVOICE_NOT_REPLACEABLE",
            `Package group ${packageGroupId} current invoice is not replaceable.`
          );
        }

        selectedAllocationIds.push(...activeMemberAllocationIds);
        preparedGroups.push({
          packageGroupId,
          issueSequence: index + 1,
          revisionNo: (group.carrier_shipments[0]?.revision_no ?? 0) + 1,
          expectedCurrentCarrierShipmentId:
            group.current_carrier_shipment_id,
          expectedCurrentInvoiceStatus:
            (currentShipment?.invoice_status as CarrierInvoiceStatus | undefined) ??
            null,
          previousTrackingNumber: currentShipment?.tracking_number ?? null,
          firstAllocationId: firstItem.allocation_id,
          firstExternalOrderId: group.members[0].external_order_id,
          firstExternalShipmentId: group.members[0].external_shipment_id,
          firstPgNo: firstItem.pg_no,
        });
      }

      await assertNoShipmentReturnConflicts(tx, selectedAllocationIds);
      const now = databaseNow();

      if (existing) {
        const claimed = await tx.carrier_invoice_issue_batches.updateMany({
          where: {
            carrier_invoice_issue_batch_id:
              existing.carrier_invoice_issue_batch_id,
            batch_status: ISSUE_BATCH_STATUS.failed,
            attempt_count: existing.attempt_count,
          },
          data: {
            batch_status: ISSUE_BATCH_STATUS.allocating,
            allocated_package_group_count: 0,
            response_item_count: 0,
            attempt_count: { increment: 1 },
            allocation_request_dispatched: 0,
            api_call_log_id: null,
            error_code: null,
            error_message: null,
            unmatched_response_json: null,
            started_at: now,
            completed_at: null,
            review_required_at: null,
            updated_at: now,
          },
        });
        if (claimed.count !== 1) {
          return {
            issueBatchId: existing.carrier_invoice_issue_batch_id,
            attemptNo: existing.attempt_count,
            groups: [],
            shouldAllocate: false,
          };
        }

        await tx.carrier_invoice_issue_items.updateMany({
          where: {
            carrier_invoice_issue_batch_id:
              existing.carrier_invoice_issue_batch_id,
          },
          data: {
            item_status: ISSUE_ITEM_STATUS.pending,
            carrier_shipment_id: null,
            tracking_number_snapshot: null,
            result_code: null,
            result_message: null,
            updated_at: now,
          },
        });
        return {
          issueBatchId: existing.carrier_invoice_issue_batch_id,
          attemptNo: existing.attempt_count + 1,
          groups: preparedGroups,
          shouldAllocate: true,
        };
      }

      const created = await tx.carrier_invoice_issue_batches.create({
        data: {
          shipment_list_print_batch_id: input.shipmentListPrintBatchId,
          carrier_code: CARRIER_CODE,
          issue_type: input.issueType,
          request_key: input.requestKey,
          batch_status: ISSUE_BATCH_STATUS.allocating,
          requested_package_group_count: preparedGroups.length,
          attempt_count: 1,
          allocation_request_dispatched: 0,
          requested_by_user_id: input.userId ?? null,
          started_at: now,
          created_at: now,
          updated_at: now,
          items: {
            create: preparedGroups.map((group) => ({
              package_group_id: group.packageGroupId,
              issue_sequence: group.issueSequence,
              revision_no: group.revisionNo,
              item_status: ISSUE_ITEM_STATUS.pending,
              created_at: now,
              updated_at: now,
            })),
          },
        },
      });

      return {
        issueBatchId: created.carrier_invoice_issue_batch_id,
        attemptNo: 1,
        groups: preparedGroups,
        shouldAllocate: true,
      };
    }
  );
}

async function markAllocationRequestDispatched(prepared: PreparedIssue) {
  await runMeasuredTransaction(
    prisma,
    "carrier.invoice-issue.dispatch",
    async (tx) => {
      const dispatchedAt = databaseNow();
      const dispatched = await tx.carrier_invoice_issue_batches.updateMany({
        where: {
          carrier_invoice_issue_batch_id: prepared.issueBatchId,
          batch_status: ISSUE_BATCH_STATUS.allocating,
          attempt_count: prepared.attemptNo,
          allocation_request_dispatched: 0,
        },
        data: {
          allocation_request_dispatched: 1,
          updated_at: dispatchedAt,
        },
      });
      if (dispatched.count !== 1) {
        throw executionOwnershipLost();
      }
    }
  );
}

function topLevelFailure(statusCode: string | null) {
  return new Set(["FAIL", "FAILED", "FALSE"]).has(
    String(statusCode ?? "").toUpperCase()
  );
}

async function finalizeAllocation(
  prepared: PreparedIssue,
  issueType: IssueType,
  call: CarrierTrackingAllocationCall,
  deferCurrentSwitch = false
) {
  await runMeasuredTransaction(
    prisma,
    "carrier.invoice-issue.finalize",
    async (tx) => {
      const now = databaseNow();
      const owned = await tx.carrier_invoice_issue_batches.updateMany({
        where: {
          carrier_invoice_issue_batch_id: prepared.issueBatchId,
          batch_status: ISSUE_BATCH_STATUS.allocating,
          attempt_count: prepared.attemptNo,
          allocation_request_dispatched: 1,
        },
        data: { updated_at: now },
      });
      if (owned.count !== 1) {
        throw executionOwnershipLost();
      }

      const issueItems = await tx.carrier_invoice_issue_items.findMany({
        where: {
          carrier_invoice_issue_batch_id: prepared.issueBatchId,
        },
        orderBy: { issue_sequence: "asc" },
      });
      const returnedTrackingNumbers = new Set<string>();
      let allocatedCount = 0;
      let hasConflict = false;

      for (const [index, issueItem] of issueItems.entries()) {
        const group = prepared.groups[index];
        const resultItem = call.allocation.items[index];
        if (!group) {
          throw new CarrierInvoiceIssueError(
            "ISSUE_ITEM_SEQUENCE_MISMATCH",
            "The persisted issue item order no longer matches the prepared package groups."
          );
        }

        if (!resultItem) {
          await tx.carrier_invoice_issue_items.update({
            where: {
              carrier_invoice_issue_item_id:
                issueItem.carrier_invoice_issue_item_id,
            },
            data: {
              item_status: ISSUE_ITEM_STATUS.missingResponse,
              result_code: "MISSING_RESPONSE",
              result_message: "Logen did not return an item for this package group.",
              updated_at: now,
            },
          });
          continue;
        }

        const trackingNumber = text(resultItem.trackingNumber);
        if (
          !resultItem.succeeded ||
          !trackingNumber ||
          !TRACKING_NUMBER_PATTERN.test(trackingNumber)
        ) {
          await tx.carrier_invoice_issue_items.update({
            where: {
              carrier_invoice_issue_item_id:
                issueItem.carrier_invoice_issue_item_id,
            },
            data: {
              item_status: ISSUE_ITEM_STATUS.failed,
              tracking_number_snapshot: trackingNumber,
              result_code:
                resultItem.resultCode ??
                (trackingNumber ? "INVALID_TRACKING_NUMBER" : "ALLOCATION_FAILED"),
              result_message:
                resultItem.resultMessage ??
                "Logen did not return a valid tracking number.",
              updated_at: now,
            },
          });
          continue;
        }

        if (returnedTrackingNumbers.has(trackingNumber)) {
          hasConflict = true;
          await tx.carrier_invoice_issue_items.update({
            where: {
              carrier_invoice_issue_item_id:
                issueItem.carrier_invoice_issue_item_id,
            },
            data: {
              item_status: ISSUE_ITEM_STATUS.conflict,
              tracking_number_snapshot: trackingNumber,
              result_code: "DUPLICATE_TRACKING_NUMBER",
              result_message:
                "Logen returned the same tracking number more than once.",
              updated_at: now,
            },
          });
          continue;
        }
        returnedTrackingNumbers.add(trackingNumber);

        const packageGroup = await tx.shipment_package_groups.findUniqueOrThrow({
          where: { package_group_id: group.packageGroupId },
          select: { current_carrier_shipment_id: true },
        });
        if (
          packageGroup.current_carrier_shipment_id !==
          group.expectedCurrentCarrierShipmentId
        ) {
          hasConflict = true;
          await tx.carrier_invoice_issue_items.update({
            where: {
              carrier_invoice_issue_item_id:
                issueItem.carrier_invoice_issue_item_id,
            },
            data: {
              item_status: ISSUE_ITEM_STATUS.conflict,
              tracking_number_snapshot: trackingNumber,
              result_code: "CURRENT_INVOICE_CHANGED",
              result_message:
                "The package group's current tracking number changed during allocation.",
              updated_at: now,
            },
          });
          continue;
        }

        try {
          const shipment = await upsertCarrierShipment(
            {
              carrierCode: CARRIER_CODE,
              sourceType: "SELF_PRINT",
              channel: "COUPANG",
              externalOrderId: group.firstExternalOrderId,
              externalShipmentId: group.firstExternalShipmentId,
              allocationId: group.firstAllocationId,
              pgNo: group.firstPgNo,
              packageGroupId: group.packageGroupId,
              trackingNumber,
              previousTrackingNumber: group.previousTrackingNumber,
              revisionNo: group.revisionNo,
              replacesCarrierShipmentId:
                group.expectedCurrentCarrierShipmentId,
              invoiceStatus: CARRIER_INVOICE_STATUS.allocated,
              shipmentStatus: CARRIER_SHIPMENT_STATUS.allocated,
              allocatedAt: now,
              carrierRegisteredAt: null,
            },
            tx
          );

          if (
            issueType === "REISSUE" &&
            group.expectedCurrentCarrierShipmentId &&
            !deferCurrentSwitch
          ) {
            await transitionCarrierInvoiceStatus(tx, {
              carrierShipmentId: group.expectedCurrentCarrierShipmentId,
              expectedFrom: [
                group.expectedCurrentInvoiceStatus ??
                  CARRIER_INVOICE_STATUS.allocated,
              ],
              to: CARRIER_INVOICE_STATUS.replaced,
              transitionedAt: now,
            });
          }
          if (!deferCurrentSwitch) {
            await tx.shipment_package_groups.update({
              where: { package_group_id: group.packageGroupId },
              data: {
                current_carrier_shipment_id: shipment.carrier_shipment_id,
                updated_at: now,
              },
            });
          }
          await tx.carrier_invoice_issue_items.update({
            where: {
              carrier_invoice_issue_item_id:
                issueItem.carrier_invoice_issue_item_id,
            },
            data: {
              item_status: ISSUE_ITEM_STATUS.allocated,
              carrier_shipment_id: shipment.carrier_shipment_id,
              tracking_number_snapshot: trackingNumber,
              result_code: resultItem.resultCode,
              result_message: resultItem.resultMessage,
              updated_at: now,
            },
          });
          allocatedCount += 1;
        } catch (error) {
          if (error instanceof CarrierShipmentStateConflictError) {
            throw new CarrierInvoiceIssueError(
              "CURRENT_INVOICE_STATE_CHANGED",
              `Package group ${group.packageGroupId} current invoice state changed during allocation.`
            );
          }
          if (
            !(error instanceof CarrierTrackingNumberConflictError) &&
            !(error instanceof CarrierShipmentRevisionConflictError)
          ) {
            throw error;
          }
          hasConflict = true;
          await tx.carrier_invoice_issue_items.update({
            where: {
              carrier_invoice_issue_item_id:
                issueItem.carrier_invoice_issue_item_id,
            },
            data: {
              item_status: ISSUE_ITEM_STATUS.conflict,
              tracking_number_snapshot: trackingNumber,
              result_code: "TRACKING_NUMBER_CONFLICT",
              result_message:
                "The returned tracking number or revision is already assigned.",
              updated_at: now,
            },
          });
        }
      }

      const requestedCount = prepared.groups.length;
      const responseCount = call.allocation.items.length;
      const unmatchedResponseItems = call.allocation.items
        .slice(requestedCount)
        .map((item, index) => ({
          responseIndex: requestedCount + index + 1,
          trackingNumber: item.trackingNumber,
          resultCode: item.resultCode,
          resultMessage: item.resultMessage,
          succeeded: item.succeeded,
        }));
      const fullyAllocated =
        allocatedCount === requestedCount &&
        responseCount === requestedCount &&
        !hasConflict;
      const definitivelyRejected =
        allocatedCount === 0 && topLevelFailure(call.allocation.statusCode);
      const status = fullyAllocated
        ? ISSUE_BATCH_STATUS.allocated
        : definitivelyRejected
          ? ISSUE_BATCH_STATUS.failed
          : ISSUE_BATCH_STATUS.reviewRequired;
      const countMismatch = responseCount !== requestedCount;
      const errorCode = fullyAllocated
        ? null
        : definitivelyRejected
          ? "CARRIER_REJECTED"
          : countMismatch
            ? "ALLOCATION_RESPONSE_COUNT_MISMATCH"
            : hasConflict
              ? "ALLOCATION_CONFLICT"
              : "PARTIAL_ALLOCATION";
      const errorMessage = fullyAllocated
        ? null
        : call.allocation.statusMessage ??
          (countMismatch
            ? `Expected ${requestedCount} allocation results but received ${responseCount}.`
            : "Only part of the tracking-number allocation could be persisted.");

      const completed = await tx.carrier_invoice_issue_batches.updateMany({
        where: {
          carrier_invoice_issue_batch_id: prepared.issueBatchId,
          batch_status: ISSUE_BATCH_STATUS.allocating,
          attempt_count: prepared.attemptNo,
          allocation_request_dispatched: 1,
        },
        data: {
          batch_status: status,
          allocated_package_group_count: allocatedCount,
          response_item_count: responseCount,
          api_call_log_id: call.apiCallLogId,
          error_code: errorCode,
          error_message: errorMessage,
          unmatched_response_json:
            unmatchedResponseItems.length > 0
              ? JSON.stringify(unmatchedResponseItems)
              : null,
          completed_at: now,
          review_required_at:
            status === ISSUE_BATCH_STATUS.reviewRequired ? now : null,
          updated_at: now,
        },
      });
      if (completed.count !== 1) {
        throw executionOwnershipLost();
      }
    }
  );
}

async function finalizeCallFailure(
  issueBatchId: number,
  attemptNo: number,
  requestDispatched: boolean,
  error: unknown
) {
  const failure = errorDetails(error);
  const carrierFailure =
    error instanceof CarrierApiCallFailureError ? error : null;
  const outcomeUncertain = requestDispatched
    ? carrierFailure?.outcomeUncertain ?? true
    : false;
  const status = outcomeUncertain
    ? ISSUE_BATCH_STATUS.reviewRequired
    : ISSUE_BATCH_STATUS.failed;
  const itemStatus = outcomeUncertain
    ? ISSUE_ITEM_STATUS.missingResponse
    : ISSUE_ITEM_STATUS.failed;
  const now = databaseNow();

  await runMeasuredTransaction(
    prisma,
    "carrier.invoice-issue.failure",
    async (tx) => {
      const completed = await tx.carrier_invoice_issue_batches.updateMany({
        where: {
          carrier_invoice_issue_batch_id: issueBatchId,
          batch_status: ISSUE_BATCH_STATUS.allocating,
          attempt_count: attemptNo,
          allocation_request_dispatched: requestDispatched ? 1 : 0,
        },
        data: {
          batch_status: status,
          api_call_log_id: carrierFailure?.apiCallLogId ?? null,
          error_code: outcomeUncertain
            ? "ALLOCATION_OUTCOME_UNCERTAIN"
            : failure.code,
          error_message: failure.message,
          completed_at: now,
          review_required_at: outcomeUncertain ? now : null,
          updated_at: now,
        },
      });
      if (completed.count !== 1) {
        throw executionOwnershipLost();
      }

      await tx.carrier_invoice_issue_items.updateMany({
        where: { carrier_invoice_issue_batch_id: issueBatchId },
        data: {
          item_status: itemStatus,
          result_code: outcomeUncertain
            ? "OUTCOME_UNCERTAIN"
            : "REQUEST_NOT_DISPATCHED",
          result_message: failure.message,
          updated_at: now,
        },
      });
    }
  );
}

async function executeIssue(
  input: {
    shipmentListPrintBatchId: number;
    issueType: IssueType;
    requestKey: string;
    packageGroupIds: number[] | null;
    userId?: number | null;
    deferCurrentSwitch?: boolean;
  },
  dependencies: CarrierInvoiceIssueDependencies
) {
  let prepared: PreparedIssue;
  try {
    prepared = await prepareIssue(input);
  } catch (error) {
    if (isPostgresqlUniqueViolation(error)) {
      const concurrent = await prisma.carrier_invoice_issue_batches.findUnique({
        where: { request_key: input.requestKey },
        include: issueBatchInclude,
      });
      if (concurrent) return toIssueBatchDto(concurrent);
    }
    throw error;
  }
  if (!prepared.shouldAllocate) {
    return getCarrierInvoiceIssueBatch({
      issueBatchId: prepared.issueBatchId,
    });
  }

  const allocator =
    dependencies.allocateTrackingNumbers ??
    (async (quantity: number): Promise<CarrierTrackingAllocationCall> => {
      const call = await allocateLogenTrackingNumbers(quantity);
      return {
        apiCallLogId: call.apiCallLogId,
        allocation: call.allocation,
      };
    });

  let requestDispatched = false;
  try {
    await markAllocationRequestDispatched(prepared);
    requestDispatched = true;
    const call = await allocator(prepared.groups.length);
    await finalizeAllocation(
      prepared,
      input.issueType,
      call,
      input.deferCurrentSwitch === true
    );
  } catch (error) {
    if (isExecutionOwnershipLost(error)) {
      return getCarrierInvoiceIssueBatch({
        issueBatchId: prepared.issueBatchId,
      });
    }
    try {
      await finalizeCallFailure(
        prepared.issueBatchId,
        prepared.attemptNo,
        requestDispatched,
        error
      );
    } catch (finalizeError) {
      if (!isExecutionOwnershipLost(finalizeError)) {
        throw finalizeError;
      }
    }
  }

  return getCarrierInvoiceIssueBatch({
    issueBatchId: prepared.issueBatchId,
  });
}

export async function issueCarrierInvoicesForShipmentBatch(
  input: {
    shipmentListPrintBatchId?: unknown;
    userId?: number | null;
  },
  dependencies: CarrierInvoiceIssueDependencies = {}
) {
  const shipmentListPrintBatchId = requiredPositiveId(
    input.shipmentListPrintBatchId,
    "Shipment print batch ID"
  );
  return executeIssue(
    {
      shipmentListPrintBatchId,
      issueType: "INITIAL",
      requestKey: `${CARRIER_CODE}:INITIAL:${shipmentListPrintBatchId}`,
      packageGroupIds: null,
      userId: input.userId,
    },
    dependencies
  );
}

export async function reissueCarrierInvoicesForPackageGroups(
  input: {
    shipmentListPrintBatchId?: unknown;
    packageGroupIds?: unknown;
    requestKey?: unknown;
    userId?: number | null;
  },
  dependencies: CarrierInvoiceIssueDependencies = {}
) {
  const shipmentListPrintBatchId = requiredPositiveId(
    input.shipmentListPrintBatchId,
    "Shipment print batch ID"
  );
  const packageGroupIds = uniquePositiveIds(
    Array.isArray(input.packageGroupIds) ? input.packageGroupIds : []
  );
  const suppliedRequestKey = text(input.requestKey);
  if (!suppliedRequestKey) {
    throw new CarrierInvoiceIssueError(
      "REISSUE_REQUEST_KEY_REQUIRED",
      "A caller-generated idempotency key is required for reissue."
    );
  }

  return executeIssue(
    {
      shipmentListPrintBatchId,
      issueType: "REISSUE",
      requestKey: `${CARRIER_CODE}:REISSUE:${shipmentListPrintBatchId}:${suppliedRequestKey}`,
      packageGroupIds,
      userId: input.userId,
    },
    dependencies
  );
}

export async function allocateCarrierInvoiceReplacementCandidate(
  input: {
    shipmentListPrintBatchId?: unknown;
    packageGroupId?: unknown;
    requestKey?: unknown;
    userId?: number | null;
  },
  dependencies: CarrierInvoiceIssueDependencies = {}
) {
  const shipmentListPrintBatchId = requiredPositiveId(
    input.shipmentListPrintBatchId,
    "Shipment print batch ID"
  );
  const packageGroupId = requiredPositiveId(
    input.packageGroupId,
    "Package group ID"
  );
  const suppliedRequestKey = text(input.requestKey);
  if (!suppliedRequestKey) {
    throw new CarrierInvoiceIssueError(
      "REISSUE_REQUEST_KEY_REQUIRED",
      "A durable idempotency key is required for replacement allocation."
    );
  }

  return executeIssue(
    {
      shipmentListPrintBatchId,
      issueType: "REISSUE",
      requestKey: `${CARRIER_CODE}:REPLACEMENT:${shipmentListPrintBatchId}:${suppliedRequestKey}`,
      packageGroupIds: [packageGroupId],
      userId: input.userId,
      deferCurrentSwitch: true,
    },
    dependencies
  );
}

export async function retryFailedCarrierInvoiceIssueBatch(
  input: {
    issueBatchId?: unknown;
    userId?: number | null;
  },
  dependencies: CarrierInvoiceIssueDependencies = {}
) {
  const issueBatchId = requiredPositiveId(
    input.issueBatchId,
    "Issue batch ID"
  );
  const batch = await prisma.carrier_invoice_issue_batches.findUnique({
    where: { carrier_invoice_issue_batch_id: issueBatchId },
    include: { replacement_work: true },
  });
  if (!batch) {
    throw new CarrierInvoiceIssueError(
      "ISSUE_BATCH_NOT_FOUND",
      "송장 발급 작업을 찾지 못했습니다."
    );
  }
  if (
    batch.batch_status === ISSUE_BATCH_STATUS.allocating &&
    batch.issue_type === "INITIAL" &&
    !batch.replacement_work
  ) {
    return getCarrierInvoiceIssueBatch({ issueBatchId });
  }
  if (
    batch.batch_status !== ISSUE_BATCH_STATUS.failed ||
    batch.issue_type !== "INITIAL" ||
    batch.replacement_work
  ) {
    throw new CarrierInvoiceIssueError(
      "ISSUE_BATCH_NOT_RETRYABLE",
      "외부 반영 결과가 확실하게 실패한 최초 송장 발급 작업만 다시 시도할 수 있습니다."
    );
  }
  return executeIssue(
    {
      shipmentListPrintBatchId:
        batch.shipment_list_print_batch_id,
      issueType: "INITIAL",
      requestKey: batch.request_key,
      packageGroupIds: null,
      userId: input.userId,
    },
    dependencies
  );
}
