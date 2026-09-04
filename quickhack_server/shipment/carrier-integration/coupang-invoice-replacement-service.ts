import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { isPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  normalizeKeysetLimit,
} from "@/quickhack_server/core/database/keyset-page";
import { prisma } from "@/quickhack_server/core/prisma";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { assertNoShipmentReturnConflicts } from "@/quickhack_server/returns/shipment-return-conflict-service";
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
import { requestSalesChannelWrite } from "@/quickhack_server/sales-channel/write/sales-channel-write-service";
import { isSalesChannelWriteRequestRetryable } from "@/quickhack_server/sales-channel/write/sales-channel-write-retry-policy";
import { allocateCarrierInvoiceReplacementCandidate } from "@/quickhack_server/shipment/carrier-integration/carrier-invoice-issue-service";
import { projectConfirmedCoupangInvoiceWrite } from "@/quickhack_server/shipment/carrier-integration/coupang-invoice-finalizer";
import {
  claimReplacementExecution,
  releaseReplacementExecution,
  replacementExecutionState,
  ReplacementExecutionOwnershipError,
  transitionReplacement,
  updateOwnedReplacement,
} from "@/quickhack_server/shipment/carrier-integration/carrier-invoice-replacement-execution-ownership";
import { projectReplacementFromIssueBatch } from "@/quickhack_server/shipment/carrier-integration/carrier-invoice-replacement-projection-service";
import {
  CarrierShipmentStateConflictError,
  transitionCarrierInvoiceStatus,
} from "@/quickhack_server/shipment/carrier-integration/carrier-shipment-state-service";
import { enqueueLogenRegistrationWork } from "@/quickhack_server/shipment/carrier-integration/logen/shipment-registration-service";
import { maskPhone } from "@/quickhack_server/security/sensitive-data";
import {
  personalDataRetentionCutoff,
} from "@/quickhack_server/security/personal-data-lifecycle-service";
import { findExpiredPersonalDataSubjects } from "@/quickhack_server/security/personal-data-redaction-service";
import {
  nowKstSqlDateTime,
  parseKstSqlDateTime,
} from "@/quickhack_shared/core/time";
import { CARRIER_INVOICE_STATUS } from "@/quickhack_shared/shipment/carrier-invoice-status";
import {
  CARRIER_INVOICE_OLD_HANDLING_STATUS,
  CARRIER_INVOICE_REPLACEMENT_SOURCE,
  CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE,
  CARRIER_INVOICE_REPLACEMENT_STAGE,
  CARRIER_INVOICE_REPLACEMENT_STATUS,
  ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES,
  TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES,
} from "@/quickhack_shared/shipment/invoice-replacement";
import {
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
  type SalesChannelWriteCommand,
} from "@/quickhack_shared/sales-channel/write-requests";

const DELIVERY_COMPANY_CODE = "KGB";
const REPLACEMENT_LIST_CURSOR_CONTRACT = "carrier-invoice-replacements:v1";
const ACTIVE_INVENTORY_STATUS = "DEPARTURE";
const REPLACEABLE_SHIPMENT_STATUSES = new Set(["ALLOCATED", "REGISTERED"]);
const TERMINAL_WORK_STATUSES = new Set<string>(
  TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES
);

export class CarrierInvoiceReplacementError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "CarrierInvoiceReplacementError";
    this.code = code;
    this.status = status;
  }
}

export type CarrierInvoiceReplacementDependencies = {
  getOrdersheetByOrderId?: typeof getCoupangOrdersheetByOrderId;
  credentialContext?: CoupangApiCredentialContext;
  openCredentialContext?: typeof openCoupangApiCredentialContext;
  allocateCandidate?: typeof allocateCarrierInvoiceReplacementCandidate;
  requestWrite?: typeof requestSalesChannelWrite;
};

const replacementInclude = {
  package_group: {
    include: {
      current_carrier_shipment: true,
      members: {
        where: { removed_at: null },
        orderBy: { member_sequence: "asc" as const },
        include: {
          allocation: {
            include: {
              order: true,
              device: { include: { inventory: true } },
            },
          },
        },
      },
    },
  },
  old_carrier_shipment: true,
  candidate_carrier_shipment: {
    include: {
      registration_work: true,
      invoice_issue_item: true,
    },
  },
  carrier_invoice_issue_batch: {
    include: {
      shipment_list_print_batch: true,
      items: {
        orderBy: { issue_sequence: "asc" as const },
        include: { registration_work: true },
      },
    },
  },
  shipment_address_change_work: {
    include: { fields: { orderBy: { field_name: "asc" as const } } },
  },
  requested_by: {
    select: {
      username: true,
      employee_profiles: { select: { display_name: true } },
    },
  },
  resolved_by: {
    select: {
      username: true,
      employee_profiles: { select: { display_name: true } },
    },
  },
} satisfies Prisma.carrier_invoice_replacement_worksInclude;

type ReplacementRow =
  Prisma.carrier_invoice_replacement_worksGetPayload<{
    include: typeof replacementInclude;
  }>;

type FreshReceiverSnapshot = {
  name: string;
  phone: string;
  postCode: string;
  address1: string;
  address2: string;
  shippingMemo: string;
};

function positiveId(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CarrierInvoiceReplacementError(
      "INVALID_ID",
      "INVALID_ID",
      400
    );
  }
  return parsed;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, label: string) {
  const normalized = text(value);
  if (!normalized) {
    throw new CarrierInvoiceReplacementError(
      "REQUIRED_VALUE_MISSING",
      "REQUIRED_VALUE_MISSING",
      400
    );
  }
  return normalized;
}

function compactAddress(order: NormalizedCoupangOrder) {
  return [order.receiverPostCode, order.receiverAddress1, order.receiverAddress2]
    .map(text)
    .filter(Boolean)
    .join(" / ");
}

function receiverKey(order: NormalizedCoupangOrder) {
  return [
    text(order.receiverName),
    text(order.receiverSafeNumber),
    text(order.receiverPostCode),
    text(order.receiverAddress1),
    text(order.receiverAddress2),
    text(order.shippingMemo),
  ].join("\u0000");
}

function userLabel(
  user:
    | {
        username: string;
        employee_profiles: { display_name: string } | null;
      }
    | null
) {
  return user?.employee_profiles?.display_name ?? user?.username ?? "";
}

function nextAction(row: ReplacementRow) {
  const executionState = replacementExecutionState(row);
  if (
    executionState === CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE.stale
  ) {
    return { code: "RESUME_INTERRUPTED" };
  }
  if (
    executionState === CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE.running
  ) {
    return { code: "WAIT" };
  }
  if (row.work_status === CARRIER_INVOICE_REPLACEMENT_STATUS.waitingManual) {
    return { code: "CONFIRM_OLD_INVOICE_HANDLING" };
  }
  if (row.work_status === CARRIER_INVOICE_REPLACEMENT_STATUS.waitingLabel) {
    return { code: "PRINT_REPLACEMENT_LABEL" };
  }
  if (row.work_status === CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired) {
    return { code: "REVIEW_FAILURE" };
  }
  if (row.work_status === CARRIER_INVOICE_REPLACEMENT_STATUS.completed) {
    return { code: "NONE" };
  }
  if (row.work_status === CARRIER_INVOICE_REPLACEMENT_STATUS.canceled) {
    return { code: "NONE" };
  }
  if (row.work_status === CARRIER_INVOICE_REPLACEMENT_STATUS.failed) {
    return { code: "REVIEW_FAILURE" };
  }
  return { code: "WAIT" };
}

function toDto(row: ReplacementRow) {
  const registration =
    row.candidate_carrier_shipment?.registration_work ??
    row.carrier_invoice_issue_batch?.items[0]?.registration_work ??
    null;
  const action = nextAction(row);

  return {
    replacementWorkId: row.carrier_invoice_replacement_work_id,
    sourceType: row.source_type,
    requestKey: row.request_key,
    status: row.work_status,
    stage: row.current_stage,
    oldInvoiceHandlingStatus: row.old_invoice_handling_status,
    executionState: replacementExecutionState(row),
    packageGroupId: row.package_group_id,
    packageGroupStatus: row.package_group.group_status,
    shipmentAddressChangeWorkId: row.shipment_address_change_work_id,
    issueBatchId: row.carrier_invoice_issue_batch_id,
    shipmentListPrintBatchId:
      row.carrier_invoice_issue_batch?.shipment_list_print_batch_id ?? null,
    shipmentListPrintTabKey:
      row.carrier_invoice_issue_batch?.shipment_list_print_batch.tab_key ?? null,
    shipmentListPrintBatchLabel:
      row.carrier_invoice_issue_batch?.shipment_list_print_batch.batch_label ??
      null,
    oldCarrierShipmentId: row.old_carrier_shipment_id,
    oldTrackingNumber: row.old_carrier_shipment.tracking_number,
    oldShipmentStatus: row.old_carrier_shipment.shipment_status,
    candidateCarrierShipmentId: row.candidate_carrier_shipment_id,
    candidateTrackingNumber:
      row.candidate_carrier_shipment?.tracking_number ?? null,
    candidateInvoiceStatus:
      row.candidate_carrier_shipment?.invoice_status ?? null,
    reasonCode: row.reason_code,
    reasonNote: row.reason_note,
    beforeReceiver: {
      name: row.before_receiver_name,
      phone: maskPhone(row.before_receiver_phone, 4),
      postCode: row.before_receiver_post_code,
      address1: row.before_receiver_address_1,
      address2: row.before_receiver_address_2,
      shippingMemo: row.before_shipping_memo,
    },
    afterReceiver: {
      name: row.after_receiver_name,
      phone: maskPhone(row.after_receiver_phone, 4),
      postCode: row.after_receiver_post_code,
      address1: row.after_receiver_address_1,
      address2: row.after_receiver_address_2,
      shippingMemo: row.after_shipping_memo,
    },
    memberCount: row.package_group.members.length,
    members: row.package_group.members.map((member) => ({
      allocationId: member.allocation_id,
      externalOrderId: member.external_order_id,
      externalShipmentId: member.external_shipment_id,
      pgNo: member.allocation.pg_no,
      inventoryStatus:
        member.allocation.device.inventory?.inventory_status ?? null,
    })),
    carrierRegistration: registration
      ? {
          workId: registration.carrier_shipment_registration_work_id,
          status: registration.work_status,
          errorCode: registration.last_error_code,
          errorMessage: registration.last_error_message,
          registeredAt: registration.registered_at,
        }
      : null,
    labelPrintStatus:
      row.carrier_invoice_issue_batch?.label_print_status ?? null,
    errorCode: row.last_error_code,
    errorMessage: row.last_error_message,
    requestedBy: userLabel(row.requested_by),
    resolvedBy: row.resolved_by ? userLabel(row.resolved_by) : null,
    requestedAt: row.requested_at,
    heldAt: row.held_at,
    oldInvoiceHandledAt: row.old_invoice_handled_at,
    channelUpdatedAt: row.channel_updated_at,
    carrierRegisteredAt: row.carrier_registered_at,
    labelConfirmedAt: row.label_confirmed_at,
    completedAt: row.completed_at,
    reviewRequiredAt: row.review_required_at,
    failedAt: row.failed_at,
    canceledAt: row.canceled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAction: action,
  };
}

async function loadReplacement(workId: number) {
  const row = await prisma.carrier_invoice_replacement_works.findUnique({
    where: { carrier_invoice_replacement_work_id: workId },
    include: replacementInclude,
  });
  if (!row) {
    throw new CarrierInvoiceReplacementError(
      "REPLACEMENT_WORK_NOT_FOUND",
      "REPLACEMENT_WORK_NOT_FOUND",
      404
    );
  }
  return row;
}

async function fetchFreshOrders(
  orderIds: string[],
  dependencies: CarrierInvoiceReplacementDependencies
) {
  const observation = await reserveSalesChannelProjectionObservation();
  const getOrdersheet =
    dependencies.getOrdersheetByOrderId ?? getCoupangOrdersheetByOrderId;
  const credentialContext =
    dependencies.credentialContext ??
    (await (
      dependencies.openCredentialContext ?? openCoupangApiCredentialContext
    )("CACHED_READ"));
  const results = await Promise.all(
    Array.from(new Set(orderIds)).map((orderId) =>
      getOrdersheet(orderId, credentialContext)
    )
  );
  const orders = results.flatMap(
    (result) => ordersheetsFromPayload(result.payload).orders
  );
  if (orders.length > 0) {
    await persistCoupangOrderRawSnapshots(orders, observation);
  }
  return { orders, credentialContext };
}

async function resolveFreshReceiver(
  group: ReplacementRow["package_group"],
  oldTrackingNumber: string,
  dependencies: CarrierInvoiceReplacementDependencies
) {
  const { orders, credentialContext } = await fetchFreshOrders(
    group.members.map((member) => member.external_order_id),
    dependencies
  );
  const byKey = new Map(
    orders.map((order) => [
      `${order.externalOrderId}\u0000${order.externalShipmentId}`,
      order,
    ])
  );
  const freshMembers = group.members.map((member) => {
    const order = byKey.get(
      `${member.external_order_id}\u0000${member.external_shipment_id}`
    );
    if (!order) {
      throw new CarrierInvoiceReplacementError(
        "TARGETED_ORDER_NOT_FOUND",
        "TARGETED_ORDER_NOT_FOUND"
      );
    }
    if (order.channelStatus !== "DEPARTURE") {
      throw new CarrierInvoiceReplacementError(
        "ORDER_STATUS_NOT_REPLACEABLE",
        "ORDER_STATUS_NOT_REPLACEABLE"
      );
    }
    if (text(order.invoiceNumber) !== oldTrackingNumber) {
      throw new CarrierInvoiceReplacementError(
        "CURRENT_CHANNEL_INVOICE_CHANGED",
        "CURRENT_CHANNEL_INVOICE_CHANGED"
      );
    }
    if (order.splitShipping === true) {
      throw new CarrierInvoiceReplacementError(
        "SPLIT_SHIPPING_NOT_SUPPORTED",
        "SPLIT_SHIPPING_NOT_SUPPORTED"
      );
    }
    const vendorItemId = text(member.allocation.external_vendor_item_id);
    const activeVendorItemIds = new Set(
      order.items
        .filter((item) => item.availableQuantity > 0 && item.canceled === 0)
        .map((item) => item.externalVendorItemId)
    );
    if (!vendorItemId || !activeVendorItemIds.has(vendorItemId)) {
      throw new CarrierInvoiceReplacementError(
        "VENDOR_ITEM_CHANGED",
        "VENDOR_ITEM_CHANGED"
      );
    }
    return { member, order, vendorItemId };
  });
  const receiverKeys = new Set(freshMembers.map(({ order }) => receiverKey(order)));
  if (receiverKeys.size !== 1) {
    throw new CarrierInvoiceReplacementError(
      "PACKAGE_GROUP_RECEIVER_DIVERGED",
      "PACKAGE_GROUP_RECEIVER_DIVERGED"
    );
  }
  const first = freshMembers[0]?.order;
  if (
    !first ||
    !text(first.receiverName) ||
    !text(first.receiverSafeNumber) ||
    !text(first.receiverAddress1)
  ) {
    throw new CarrierInvoiceReplacementError(
      "RECEIVER_REQUIRED_FIELD_MISSING",
      "RECEIVER_REQUIRED_FIELD_MISSING"
    );
  }
  const receiver: FreshReceiverSnapshot = {
    name: text(first.receiverName),
    phone: text(first.receiverSafeNumber),
    postCode: text(first.receiverPostCode),
    address1: text(first.receiverAddress1),
    address2: text(first.receiverAddress2),
    shippingMemo: text(first.shippingMemo),
  };
  return { freshMembers, receiver, credentialContext };
}

export async function getCarrierInvoiceReplacementForIssueBatch(input: {
  issueBatchId?: unknown;
}) {
  const issueBatchId = positiveId(input.issueBatchId, "Issue batch ID");
  const work = await prisma.carrier_invoice_replacement_works.findUnique({
    where: { carrier_invoice_issue_batch_id: issueBatchId },
    select: { carrier_invoice_replacement_work_id: true },
  });
  if (!work) return null;
  return toDto(await loadReplacement(work.carrier_invoice_replacement_work_id));
}

export async function getCarrierInvoiceReplacement(input: {
  replacementWorkId?: unknown;
}) {
  const workId = positiveId(input.replacementWorkId, "Replacement work ID");
  return toDto(await loadReplacement(workId));
}

export async function listCarrierInvoiceReplacements(input: {
  status?: unknown;
  scope?: unknown;
  search?: unknown;
  limit?: unknown;
  cursor?: unknown;
} = {}) {
  const status = text(input.status).toUpperCase();
  const scope = text(input.scope).toUpperCase() === "HISTORY" ? "HISTORY" : "OPEN";
  const search = text(input.search);
  const limit = normalizeKeysetLimit(input.limit, {
    defaultLimit: 100,
    maxLimit: 300,
  });
  const filter: Prisma.carrier_invoice_replacement_worksWhereInput = {
    ...(status && status !== "ALL"
      ? { work_status: status }
      : {
          work_status:
            scope === "HISTORY"
              ? { in: [...TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES] }
              : { in: [...ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES] },
        }),
    ...(search
      ? {
          OR: [
            { old_carrier_shipment: { tracking_number: { contains: search } } },
            {
              candidate_carrier_shipment: {
                is: { tracking_number: { contains: search } },
              },
            },
            { package_group: { members: { some: { external_order_id: { contains: search } } } } },
            { package_group: { members: { some: { allocation: { pg_no: { contains: search } } } } } },
          ],
        }
      : {}),
  };
  const queryIdentity = { status: status || "ALL", scope, search };
  const cursorText = text(input.cursor);
  const decoded = cursorText
    ? decodeKeysetCursor<
        { maxReplacementWorkId: number; totalCount: number },
        { replacementWorkId: number }
      >({
        cursor: cursorText,
        contract: REPLACEMENT_LIST_CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;
  return runConsistentReadSnapshot(
    prisma,
    "shipment.invoice-replacements.read",
    async (tx) => {
      const snapshot = decoded?.snapshot ??
        (await (async () => {
          const [aggregate, totalCount] = await Promise.all([
            tx.carrier_invoice_replacement_works.aggregate({
              where: filter,
              _max: { carrier_invoice_replacement_work_id: true },
            }),
            tx.carrier_invoice_replacement_works.count({ where: filter }),
          ]);
          return {
            maxReplacementWorkId:
              aggregate._max.carrier_invoice_replacement_work_id ?? 0,
            totalCount,
          };
        })());
      const beforeId = decoded?.position.replacementWorkId ?? null;
      const rows = await tx.carrier_invoice_replacement_works.findMany({
        where: {
          AND: [
            filter,
            {
              carrier_invoice_replacement_work_id: {
                lte: snapshot.maxReplacementWorkId,
              },
            },
            ...(beforeId
              ? [{ carrier_invoice_replacement_work_id: { lt: beforeId } }]
              : []),
          ],
        },
        orderBy: { carrier_invoice_replacement_work_id: "desc" },
        take: limit + 1,
        include: replacementInclude,
      });
      const page = createKeysetPage({
        rows,
        limit,
        coverage: search || (status && status !== "ALL") ? "FILTERED" : "COMPLETE",
        totalCount: snapshot.totalCount,
        cursorFor: (last) =>
          encodeKeysetCursor({
            contract: REPLACEMENT_LIST_CURSOR_CONTRACT,
            queryIdentity,
            snapshot,
            position: {
              replacementWorkId: last.carrier_invoice_replacement_work_id,
            },
          }),
      });
      return {
        items: page.items.map(toDto),
        totalCount: snapshot.totalCount,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        coverage: page.coverage,
        scope,
      };
    }
  );
}

async function createReplacementHold(input: {
  packageGroupId: number;
  sourceType: "ADDRESS_CHANGE" | "MANUAL";
  addressChangeWorkId: number | null;
  reasonCode: string;
  reasonNote: string | null;
  userId: number;
  receiver: FreshReceiverSnapshot;
}) {
  const now = nowKstSqlDateTime();
  return runMeasuredTransaction(
    prisma,
    "carrier.invoice-replacement.create",
    async (tx) => {
      const group = await tx.shipment_package_groups.findUnique({
        where: { package_group_id: input.packageGroupId },
        include: {
          current_carrier_shipment: {
            include: {
              registration_work: true,
              invoice_issue_item: { include: { issue_batch: true } },
            },
          },
          members: {
            where: { removed_at: null },
            include: {
              allocation: {
                include: { device: { include: { inventory: true } } },
              },
            },
          },
        },
      });
      if (!group || !group.current_carrier_shipment) {
        throw new CarrierInvoiceReplacementError(
          "CURRENT_INVOICE_NOT_FOUND",
          "CURRENT_INVOICE_NOT_FOUND"
        );
      }
      const current = group.current_carrier_shipment;
      if (group.group_status !== "READY") {
        throw new CarrierInvoiceReplacementError(
          "PACKAGE_GROUP_NOT_READY",
          "PACKAGE_GROUP_NOT_READY"
        );
      }
      if (!REPLACEABLE_SHIPMENT_STATUSES.has(current.shipment_status)) {
        throw new CarrierInvoiceReplacementError(
          "SHIPMENT_ALREADY_MOVING",
          "SHIPMENT_ALREADY_MOVING"
        );
      }
      if (
        group.members.length === 0 ||
        group.members.some(
          (member) =>
            member.allocation.device.inventory?.inventory_status !==
            ACTIVE_INVENTORY_STATUS
        )
      ) {
        throw new CarrierInvoiceReplacementError(
          "INVENTORY_NOT_DEPARTURE",
          "INVENTORY_NOT_DEPARTURE"
        );
      }
      const expiredSubjects = await findExpiredPersonalDataSubjects(tx, {
        channel: group.channel,
        subjects: group.members.map((member) => ({
          externalOrderId: member.external_order_id,
          externalShipmentId: member.external_shipment_id,
        })),
        cutoff: personalDataRetentionCutoff(
          parseKstSqlDateTime(now) ?? new Date()
        ),
      });
      if (expiredSubjects.length > 0) {
        throw new CarrierInvoiceReplacementError(
          "PERSONAL_DATA_RETENTION_EXPIRED",
          "PERSONAL_DATA_RETENTION_EXPIRED"
        );
      }
      const issueBatch =
        current.invoice_issue_item?.issue_batch ?? null;
      if (!issueBatch) {
        throw new CarrierInvoiceReplacementError(
          "ORIGINAL_ISSUE_BATCH_NOT_FOUND",
          "ORIGINAL_ISSUE_BATCH_NOT_FOUND"
        );
      }
      if (input.addressChangeWorkId) {
        const addressWork = await tx.shipment_address_change_work.findUnique({
          where: {
            shipment_address_change_work_id: input.addressChangeWorkId,
          },
        });
        if (
          !addressWork ||
          (addressWork.package_group_id &&
            addressWork.package_group_id !== group.package_group_id) ||
          addressWork.change_status !== "PENDING"
        ) {
          throw new CarrierInvoiceReplacementError(
            "ADDRESS_CHANGE_WORK_MISMATCH",
            "ADDRESS_CHANGE_WORK_MISMATCH"
          );
        }
      }
      await assertNoShipmentReturnConflicts(
        tx,
        group.members.map((member) => member.allocation_id)
      );

      const requiresManual =
        current.invoice_status === "REGISTERED" ||
        current.carrier_registered_at != null ||
        current.registration_work?.work_status === "REGISTERED";
      const executionToken = requiresManual ? null : randomUUID();
      const work = await tx.carrier_invoice_replacement_works.create({
        data: {
          source_type: input.sourceType,
          request_key: `LOGEN:REPLACEMENT:${group.package_group_id}:${randomUUID()}`,
          work_status: requiresManual
            ? CARRIER_INVOICE_REPLACEMENT_STATUS.waitingManual
            : CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
          current_stage: requiresManual
            ? CARRIER_INVOICE_REPLACEMENT_STAGE.oldInvoiceHandling
            : CARRIER_INVOICE_REPLACEMENT_STAGE.allocation,
          old_invoice_handling_status: requiresManual
            ? CARRIER_INVOICE_OLD_HANDLING_STATUS.pendingManual
            : CARRIER_INVOICE_OLD_HANDLING_STATUS.notRequired,
          workflow_version: requiresManual ? 0 : 1,
          execution_token: executionToken,
          execution_started_at: executionToken ? now : null,
          package_group_id: group.package_group_id,
          shipment_address_change_work_id: input.addressChangeWorkId,
          old_carrier_shipment_id: current.carrier_shipment_id,
          reason_code: input.reasonCode,
          reason_note: input.reasonNote,
          before_receiver_name: group.receiver_name_snapshot,
          before_receiver_phone: group.receiver_phone_snapshot,
          before_receiver_post_code: group.receiver_post_code_snapshot,
          before_receiver_address_1: group.receiver_address_1_snapshot,
          before_receiver_address_2: group.receiver_address_2_snapshot,
          before_shipping_memo: group.shipping_memo_snapshot,
          after_receiver_name: input.receiver.name,
          after_receiver_phone: input.receiver.phone,
          after_receiver_post_code: input.receiver.postCode,
          after_receiver_address_1: input.receiver.address1,
          after_receiver_address_2: input.receiver.address2,
          after_shipping_memo: input.receiver.shippingMemo,
          requested_by_user_id: input.userId,
          requested_at: now,
          held_at: now,
          created_at: now,
          updated_at: now,
        },
      });
      const held = await tx.shipment_package_groups.updateMany({
        where: {
          package_group_id: group.package_group_id,
          group_status: "READY",
          current_carrier_shipment_id: current.carrier_shipment_id,
        },
        data: { group_status: "ON_HOLD", updated_at: now },
      });
      if (held.count !== 1) {
        throw new CarrierInvoiceReplacementError(
          "PACKAGE_GROUP_HOLD_CONFLICT",
          "PACKAGE_GROUP_HOLD_CONFLICT"
        );
      }
      if (input.addressChangeWorkId) {
        await tx.shipment_address_change_work.update({
          where: {
            shipment_address_change_work_id: input.addressChangeWorkId,
          },
          data: {
            package_group_id: group.package_group_id,
            carrier_shipment_id_at_detection: current.carrier_shipment_id,
            processed_by_user_id: input.userId,
            memo: input.reasonNote,
            updated_at: now,
          },
        });
      }
      await tx.employee_activity_logs.create({
        data: {
          user_id: input.userId,
          action_type: "CARRIER_INVOICE_REPLACEMENT_STARTED",
          target_type: "CARRIER_INVOICE_REPLACEMENT_WORK",
          target_id: String(work.carrier_invoice_replacement_work_id),
          ...activityLogChangeData(
            {
              packageGroupStatus: "READY",
              carrierShipmentId: current.carrier_shipment_id,
            },
            {
              packageGroupStatus: "ON_HOLD",
              sourceType: input.sourceType,
              requiresManualOldInvoiceHandling: requiresManual,
            }
          ),
          result: "SUCCESS",
          created_at: now,
        },
      });
      return {
        workId: work.carrier_invoice_replacement_work_id,
        shipmentListPrintBatchId: issueBatch.shipment_list_print_batch_id,
        requiresManual,
        executionToken,
        workflowVersion: work.workflow_version,
      };
    }
  );
}

async function submitReplacementToCoupang(
  workId: number,
  ownership: { executionToken: string; workflowVersion: number },
  dependencies: CarrierInvoiceReplacementDependencies
) {
  const row = await loadReplacement(workId);
  const candidate = row.candidate_carrier_shipment;
  if (!candidate || !row.carrier_invoice_issue_batch_id) {
    throw new CarrierInvoiceReplacementError(
      "REPLACEMENT_CANDIDATE_NOT_FOUND",
      "REPLACEMENT_CANDIDATE_NOT_FOUND"
    );
  }
  if (
    row.package_group.current_carrier_shipment_id !==
      row.old_carrier_shipment_id ||
    row.package_group.group_status !== "ON_HOLD"
  ) {
    throw new CarrierInvoiceReplacementError(
      "REPLACEMENT_TARGET_CHANGED",
      "REPLACEMENT_TARGET_CHANGED"
    );
  }
  const fresh = await resolveFreshReceiver(
    row.package_group,
    row.old_carrier_shipment.tracking_number,
    dependencies
  );
  const desiredReceiverKey = [
    text(row.after_receiver_name),
    text(row.after_receiver_phone),
    text(row.after_receiver_post_code),
    text(row.after_receiver_address_1),
    text(row.after_receiver_address_2),
    text(row.after_shipping_memo),
  ].join("\u0000");
  if (receiverKey(fresh.freshMembers[0].order) !== desiredReceiverKey) {
    throw new CarrierInvoiceReplacementError(
      "RECEIVER_CHANGED_AGAIN",
      "RECEIVER_CHANGED_AGAIN"
    );
  }
  const membersByShipment = new Map<
    string,
    typeof fresh.freshMembers
  >();
  for (const member of fresh.freshMembers) {
    const current = membersByShipment.get(member.order.externalShipmentId) ?? [];
    current.push(member);
    membersByShipment.set(member.order.externalShipmentId, current);
  }
  const commands: SalesChannelWriteCommand[] = [];
  for (const [shipmentId, members] of membersByShipment) {
    const first = members[0];
    commands.push({
      channel: "COUPANG",
      requestType: SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate,
      idempotencyKey: `COUPANG_INVOICE_UPDATE:${candidate.carrier_shipment_id}:${shipmentId}`,
      externalOrderId: first.order.externalOrderId,
      targetType: "SHIPMENT_BOX",
      targetExternalId: shipmentId,
      packageGroupId: row.package_group_id,
      carrierShipmentId: candidate.carrier_shipment_id,
      expectedBeforeStatus: "DEPARTURE",
      requestedAfterStatus: "DEPARTURE",
      sourceMenuKey:
        row.source_type === CARRIER_INVOICE_REPLACEMENT_SOURCE.addressChange
          ? "shipment-delivery-changes"
          : "invoice-manual-issue",
      sourceEntityType: "CARRIER_INVOICE_REPLACEMENT_WORK",
      sourceEntityId: String(workId),
      requestedByUserId: row.requested_by_user_id,
      invoiceItems: members.map(({ order, vendorItemId }) => ({
        shipmentBoxId: order.externalShipmentId,
        orderId: order.externalOrderId,
        vendorItemId,
        deliveryCompanyCode: DELIVERY_COMPANY_CODE,
        invoiceNumber: candidate.tracking_number,
        splitShipping: false,
        preSplitShipped: false,
        estimatedShippingDate: "",
      })),
      targets: members.map(({ member, order, vendorItemId }) => ({
        targetType: "SHIPMENT_BOX",
        targetExternalId: order.externalShipmentId,
        allocationId: member.allocation_id,
        pgNo: member.allocation.pg_no,
        externalOrderId: order.externalOrderId,
        externalShipmentId: order.externalShipmentId,
        externalVendorItemId: vendorItemId,
        packageGroupId: row.package_group_id,
        carrierShipmentId: candidate.carrier_shipment_id,
        deliveryCompanyCode: DELIVERY_COMPANY_CODE,
        invoiceNumberSnapshot: candidate.tracking_number,
        splitShipping: false,
        preSplitShipped: false,
        estimatedShippingDate: "",
        expectedBeforeStatus: "DEPARTURE",
        requestedAfterStatus: "DEPARTURE",
      })),
    });
  }

  ownership.workflowVersion = await updateOwnedReplacement({
    workId,
    executionToken: ownership.executionToken,
    workflowVersion: ownership.workflowVersion,
    expectedStatuses: [CARRIER_INVOICE_REPLACEMENT_STATUS.processing],
    data: {
      work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
      current_stage: CARRIER_INVOICE_REPLACEMENT_STAGE.channelUpdate,
      last_error_code: null,
      last_error_message: null,
      review_required_at: null,
      updated_at: nowKstSqlDateTime(),
    },
  });
  const results = [];
  for (const command of commands) {
    const existing = await prisma.sales_channel_write_requests.findUnique({
      where: { idempotency_key: command.idempotencyKey },
      include: {
        targets: {
          where: { external_result_status: "SUCCEEDED" },
          select: { sales_channel_write_request_target_id: true },
        },
      },
    });
    if (
      existing &&
      !isSalesChannelWriteRequestRetryable(existing.request_status)
    ) {
      results.push(existing.request_status);
      if (
        existing.request_status ===
        SALES_CHANNEL_WRITE_REQUEST_STATUS.completed
      ) {
        const finalized = await prisma.$transaction((tx) =>
          finalizePersistedCoupangInvoiceUpdate({
            tx,
            requestId: existing.sales_channel_write_request_id,
            targetIds: existing.targets.map(
              (target) => target.sales_channel_write_request_target_id
            ),
            actorUserId: row.requested_by_user_id,
            finalizedAt: databaseNow(),
            replacementExecutionToken: ownership.executionToken,
            replacementWorkflowVersion: ownership.workflowVersion,
          })
        );
        if (finalized.allConfirmed) return;
      }
      continue;
    }
    try {
      const result = await (dependencies.requestWrite ?? requestSalesChannelWrite)(
        command,
        {
          finalize: ({ tx, requestId, targetIds, finalizedAt }) =>
            finalizePersistedCoupangInvoiceUpdate({
              tx,
              requestId,
              targetIds,
              actorUserId: row.requested_by_user_id,
              finalizedAt,
              replacementExecutionToken: ownership.executionToken,
              replacementWorkflowVersion: ownership.workflowVersion,
            }).then(() => undefined),
        },
        undefined
      );
      results.push(result.status);
    } catch {
      const persisted = await prisma.sales_channel_write_requests.findUnique({
        where: { idempotency_key: command.idempotencyKey },
      });
      results.push(persisted?.request_status ?? "REVIEW_REQUIRED");
    }
  }
  if (
    results.some(
      (status) => status !== SALES_CHANNEL_WRITE_REQUEST_STATUS.completed
    )
  ) {
    const now = nowKstSqlDateTime();
    ownership.workflowVersion = await releaseReplacementExecution({
      workId,
      executionToken: ownership.executionToken,
      workflowVersion: ownership.workflowVersion,
      expectedStatuses: [CARRIER_INVOICE_REPLACEMENT_STATUS.processing],
      expectedStages: [CARRIER_INVOICE_REPLACEMENT_STAGE.channelUpdate],
      data: {
        work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
        current_stage: CARRIER_INVOICE_REPLACEMENT_STAGE.channelUpdate,
        last_error_code: "COUPANG_INVOICE_UPDATE_REVIEW_REQUIRED",
        last_error_message:
          "쿠팡 송장번호 변경 결과를 자동으로 확정하지 못했습니다. 판매 채널 동기화 점검에서 상태를 확인하세요.",
        review_required_at: now,
        updated_at: now,
      },
    });
  }
}

function replacementOwnershipError(error: unknown) {
  if (error instanceof ReplacementExecutionOwnershipError) {
    return new CarrierInvoiceReplacementError(error.code, error.message);
  }
  return error;
}

async function continueReplacement(
  workId: number,
  ownership: { executionToken: string; workflowVersion: number },
  dependencies: CarrierInvoiceReplacementDependencies
) {
  let row = await loadReplacement(workId);
  if (TERMINAL_WORK_STATUSES.has(row.work_status)) return toDto(row);
  if (
    row.execution_token !== ownership.executionToken ||
    row.workflow_version !== ownership.workflowVersion
  ) {
    throw new CarrierInvoiceReplacementError(
      "REPLACEMENT_EXECUTION_OWNERSHIP_LOST",
      "REPLACEMENT_EXECUTION_OWNERSHIP_LOST"
    );
  }
  if (
    row.old_invoice_handling_status ===
    CARRIER_INVOICE_OLD_HANDLING_STATUS.pendingManual
  ) {
    return toDto(row);
  }
  if (!row.candidate_carrier_shipment_id) {
    const originalIssueItem =
      await prisma.carrier_invoice_issue_items.findUnique({
        where: {
          carrier_shipment_id: row.old_carrier_shipment_id,
        },
        include: { issue_batch: true },
      });
    if (!originalIssueItem) {
      throw new CarrierInvoiceReplacementError(
        "ORIGINAL_ISSUE_BATCH_NOT_FOUND",
        "ORIGINAL_ISSUE_BATCH_NOT_FOUND"
      );
    }
    ownership.workflowVersion = await updateOwnedReplacement({
      workId,
      executionToken: ownership.executionToken,
      workflowVersion: ownership.workflowVersion,
      expectedStatuses: [CARRIER_INVOICE_REPLACEMENT_STATUS.processing],
      data: {
        work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
        current_stage: CARRIER_INVOICE_REPLACEMENT_STAGE.allocation,
        updated_at: nowKstSqlDateTime(),
      },
    });
    const issueBatch = await (
      dependencies.allocateCandidate ??
      allocateCarrierInvoiceReplacementCandidate
    )({
      shipmentListPrintBatchId:
        originalIssueItem.issue_batch.shipment_list_print_batch_id,
      packageGroupId: row.package_group_id,
      requestKey: row.request_key,
      userId: row.requested_by_user_id,
    });
    const item = issueBatch.items[0];
    if (
      issueBatch.status !== "ALLOCATED" ||
      !item?.carrierShipmentId
    ) {
      const now = nowKstSqlDateTime();
      ownership.workflowVersion = await releaseReplacementExecution({
        workId,
        executionToken: ownership.executionToken,
        workflowVersion: ownership.workflowVersion,
        expectedStatuses: [CARRIER_INVOICE_REPLACEMENT_STATUS.processing],
        expectedStages: [CARRIER_INVOICE_REPLACEMENT_STAGE.allocation],
        data: {
          carrier_invoice_issue_batch_id: issueBatch.issueBatchId,
          work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
          current_stage: CARRIER_INVOICE_REPLACEMENT_STAGE.allocation,
          last_error_code:
            issueBatch.errorCode ?? "REPLACEMENT_ALLOCATION_NOT_COMPLETED",
          last_error_message:
            issueBatch.errorMessage ??
            "새 송장번호 채번 결과를 자동으로 확정하지 못했습니다.",
          review_required_at: now,
          updated_at: now,
        },
      });
      return getCarrierInvoiceReplacement({ replacementWorkId: workId });
    }
    ownership.workflowVersion = await updateOwnedReplacement({
      workId,
      executionToken: ownership.executionToken,
      workflowVersion: ownership.workflowVersion,
      expectedStatuses: [CARRIER_INVOICE_REPLACEMENT_STATUS.processing],
      expectedStages: [CARRIER_INVOICE_REPLACEMENT_STAGE.allocation],
      data: {
        candidate_carrier_shipment_id: item.carrierShipmentId,
        carrier_invoice_issue_batch_id: issueBatch.issueBatchId,
        current_stage: CARRIER_INVOICE_REPLACEMENT_STAGE.channelUpdate,
        updated_at: nowKstSqlDateTime(),
      },
    });
    row = await loadReplacement(workId);
  }
  if (!row.channel_updated_at) {
    await submitReplacementToCoupang(workId, ownership, dependencies);
    row = await loadReplacement(workId);
    if (row.channel_updated_at) {
      const { wakeWorkerManager } = await import(
        "@/quickhack_server/workers/manager"
      );
      wakeWorkerManager();
    }
  }
  return toDto(await loadReplacement(workId));
}

async function runOwnedReplacement(
  workId: number,
  ownership: { executionToken: string; workflowVersion: number },
  dependencies: CarrierInvoiceReplacementDependencies
) {
  try {
    return await continueReplacement(workId, ownership, dependencies);
  } catch (caught) {
    const error = replacementOwnershipError(caught);
    const current = await loadReplacement(workId);
    if (
      current.execution_token === ownership.executionToken &&
      current.workflow_version === ownership.workflowVersion &&
      !TERMINAL_WORK_STATUSES.has(current.work_status)
    ) {
      const now = nowKstSqlDateTime();
      const code =
        error instanceof CarrierInvoiceReplacementError
          ? error.code
          : error instanceof Error
            ? error.name
            : "REPLACEMENT_EXECUTION_FAILED";
      const message =
        error instanceof Error
          ? error.message
          : "The carrier invoice replacement execution failed.";
      await releaseReplacementExecution({
        workId,
        executionToken: ownership.executionToken,
        workflowVersion: ownership.workflowVersion,
        data: {
          work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
          last_error_code: code,
          last_error_message: message.slice(0, 2000),
          review_required_at: now,
          updated_at: now,
        },
      });
    }
    throw error;
  }
}

export async function startCarrierInvoiceReplacement(
  input: {
    packageGroupId?: unknown;
    sourceType?: unknown;
    shipmentAddressChangeWorkId?: unknown;
    reasonCode?: unknown;
    reasonNote?: unknown;
    userId: number;
  },
  dependencies: CarrierInvoiceReplacementDependencies = {}
) {
  const packageGroupId = positiveId(input.packageGroupId, "Package group ID");
  const sourceType = text(input.sourceType).toUpperCase();
  if (
    sourceType !== CARRIER_INVOICE_REPLACEMENT_SOURCE.addressChange &&
    sourceType !== CARRIER_INVOICE_REPLACEMENT_SOURCE.manual
  ) {
    throw new CarrierInvoiceReplacementError(
      "INVALID_SOURCE_TYPE",
      "INVALID_SOURCE_TYPE",
      400
    );
  }
  const addressChangeWorkId =
    input.shipmentAddressChangeWorkId == null
      ? null
      : positiveId(
          input.shipmentAddressChangeWorkId,
          "Shipment address change work ID"
        );
  if (
    sourceType === CARRIER_INVOICE_REPLACEMENT_SOURCE.addressChange &&
    !addressChangeWorkId
  ) {
    throw new CarrierInvoiceReplacementError(
      "ADDRESS_CHANGE_WORK_REQUIRED",
      "ADDRESS_CHANGE_WORK_REQUIRED",
      400
    );
  }
  const reasonCode = requiredText(input.reasonCode, "Reason code");
  const reasonNote = text(input.reasonNote) || null;
  if (
    sourceType === CARRIER_INVOICE_REPLACEMENT_SOURCE.manual &&
    !reasonNote
  ) {
    throw new CarrierInvoiceReplacementError(
      "REASON_NOTE_REQUIRED",
      "REASON_NOTE_REQUIRED",
      400
    );
  }
  const existing =
    await prisma.carrier_invoice_replacement_works.findFirst({
      where: {
        package_group_id: packageGroupId,
        work_status: {
          notIn: [...TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES],
        },
      },
      orderBy: { carrier_invoice_replacement_work_id: "desc" },
    });
  if (existing) {
    return getCarrierInvoiceReplacement({
      replacementWorkId:
        existing.carrier_invoice_replacement_work_id,
    });
  }
  const group = await prisma.shipment_package_groups.findUnique({
    where: { package_group_id: packageGroupId },
    include: replacementInclude.package_group.include,
  });
  if (!group?.current_carrier_shipment) {
    throw new CarrierInvoiceReplacementError(
      "CURRENT_INVOICE_NOT_FOUND",
      "CURRENT_INVOICE_NOT_FOUND"
    );
  }
  const expiredSubjects = await prisma.$transaction((tx) =>
    findExpiredPersonalDataSubjects(tx, {
      channel: group.channel,
      subjects: group.members.map((member) => ({
        externalOrderId: member.external_order_id,
        externalShipmentId: member.external_shipment_id,
      })),
      cutoff: personalDataRetentionCutoff(databaseNow()),
    })
  );
  if (expiredSubjects.length > 0) {
    throw new CarrierInvoiceReplacementError(
      "PERSONAL_DATA_RETENTION_EXPIRED",
      "PERSONAL_DATA_RETENTION_EXPIRED"
    );
  }
  const fresh = await resolveFreshReceiver(
    group,
    group.current_carrier_shipment.tracking_number,
    dependencies
  );
  let created;
  try {
    created = await createReplacementHold({
      packageGroupId,
      sourceType,
      addressChangeWorkId,
      reasonCode,
      reasonNote,
      userId: input.userId,
      receiver: fresh.receiver,
    });
  } catch (error) {
    if (!isPostgresqlUniqueViolation(error)) throw error;
    const concurrent =
      await prisma.carrier_invoice_replacement_works.findFirst({
        where: {
          package_group_id: packageGroupId,
          work_status: {
            notIn: [...TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES],
          },
        },
        orderBy: { carrier_invoice_replacement_work_id: "desc" },
      });
    if (!concurrent) throw error;
    return getCarrierInvoiceReplacement({
      replacementWorkId:
        concurrent.carrier_invoice_replacement_work_id,
    });
  }
  if (created.requiresManual) {
    return getCarrierInvoiceReplacement({
      replacementWorkId: created.workId,
    });
  }
  if (!created.executionToken) {
    throw new CarrierInvoiceReplacementError(
      "REPLACEMENT_EXECUTION_NOT_CLAIMED",
      "REPLACEMENT_EXECUTION_NOT_CLAIMED"
    );
  }
  return runOwnedReplacement(
    created.workId,
    {
      executionToken: created.executionToken,
      workflowVersion: created.workflowVersion,
    },
    {
      ...dependencies,
      credentialContext:
        dependencies.credentialContext ?? fresh.credentialContext,
    }
  );
}

export async function confirmCarrierInvoiceOldHandling(input: {
  replacementWorkId?: unknown;
  userId: number;
  note?: unknown;
}) {
  const workId = positiveId(input.replacementWorkId, "Replacement work ID");
  const note = requiredText(input.note, "Confirmation note");
  const row = await loadReplacement(workId);
  if (
    row.work_status !== CARRIER_INVOICE_REPLACEMENT_STATUS.waitingManual ||
    row.old_invoice_handling_status !==
      CARRIER_INVOICE_OLD_HANDLING_STATUS.pendingManual
  ) {
    throw new CarrierInvoiceReplacementError(
      "OLD_INVOICE_HANDLING_NOT_PENDING",
      "OLD_INVOICE_HANDLING_NOT_PENDING"
    );
  }
  const now = nowKstSqlDateTime();
  let ownership;
  try {
    ownership = await claimReplacementExecution({
      workId,
      expectedStatuses: [CARRIER_INVOICE_REPLACEMENT_STATUS.waitingManual],
      expectedStages: [
        CARRIER_INVOICE_REPLACEMENT_STAGE.oldInvoiceHandling,
      ],
      allowStaleTakeover: false,
      claimedAt: now,
    });
  } catch (error) {
    throw replacementOwnershipError(error);
  }
  try {
    ownership.workflowVersion = await runMeasuredTransaction(
      prisma,
      "carrier.invoice-replacement.confirm-old",
      async (tx) => {
        const nextWorkflowVersion = await updateOwnedReplacement({
          client: tx,
          workId,
          executionToken: ownership.executionToken,
          workflowVersion: ownership.workflowVersion,
          expectedStatuses: [
            CARRIER_INVOICE_REPLACEMENT_STATUS.waitingManual,
          ],
          expectedStages: [
            CARRIER_INVOICE_REPLACEMENT_STAGE.oldInvoiceHandling,
          ],
          data: {
            old_invoice_handling_status:
              CARRIER_INVOICE_OLD_HANDLING_STATUS.confirmed,
            work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
            current_stage: CARRIER_INVOICE_REPLACEMENT_STAGE.allocation,
            old_invoice_handled_at: now,
            resolved_by_user_id: input.userId,
            reason_note: [row.reason_note, note].filter(Boolean).join("\n"),
            updated_at: now,
          },
        });
        await tx.employee_activity_logs.create({
          data: {
            user_id: input.userId,
            action_type: "CARRIER_INVOICE_OLD_HANDLING_CONFIRMED",
            target_type: "CARRIER_INVOICE_REPLACEMENT_WORK",
            target_id: String(workId),
            ...activityLogChangeData(
              { oldInvoiceHandlingStatus: "PENDING_MANUAL" },
              { oldInvoiceHandlingStatus: "CONFIRMED" }
            ),
            result: "SUCCESS",
            created_at: now,
          },
        });
        return nextWorkflowVersion;
      }
    );
  } catch (caught) {
    const current = await loadReplacement(workId);
    if (
      current.execution_token === ownership.executionToken &&
      current.workflow_version === ownership.workflowVersion
    ) {
      await releaseReplacementExecution({
        workId,
        executionToken: ownership.executionToken,
        workflowVersion: ownership.workflowVersion,
      });
    }
    throw replacementOwnershipError(caught);
  }
  return runOwnedReplacement(workId, ownership, {});
}

export async function resumeCarrierInvoiceReplacement(input: {
  replacementWorkId?: unknown;
  userId: number;
}) {
  const workId = positiveId(input.replacementWorkId, "Replacement work ID");
  const row = await loadReplacement(workId);
  if (TERMINAL_WORK_STATUSES.has(row.work_status)) return toDto(row);
  if (
    row.current_stage ===
      CARRIER_INVOICE_REPLACEMENT_STAGE.carrierRegistration ||
    row.current_stage === CARRIER_INVOICE_REPLACEMENT_STAGE.labelPrint ||
    row.work_status === CARRIER_INVOICE_REPLACEMENT_STATUS.waitingLabel
  ) {
    if (row.execution_token) {
      let childOwnership;
      try {
        childOwnership = await claimReplacementExecution({
          workId,
          expectedStatuses: [row.work_status],
          expectedStages: [row.current_stage],
        });
      } catch (error) {
        throw replacementOwnershipError(error);
      }
      await releaseReplacementExecution({
        workId,
        executionToken: childOwnership.executionToken,
        workflowVersion: childOwnership.workflowVersion,
      });
    }
    if (row.carrier_invoice_issue_batch_id) {
      await projectReplacementFromIssueBatch({
        issueBatchId: row.carrier_invoice_issue_batch_id,
        actorUserId: input.userId,
      });
    }
    return getCarrierInvoiceReplacement({ replacementWorkId: workId });
  }
  if (
    row.old_invoice_handling_status ===
    CARRIER_INVOICE_OLD_HANDLING_STATUS.pendingManual
  ) {
    throw new CarrierInvoiceReplacementError(
      "OLD_INVOICE_HANDLING_NOT_CONFIRMED",
      "OLD_INVOICE_HANDLING_NOT_CONFIRMED"
    );
  }
  let ownership;
  try {
    ownership = await claimReplacementExecution({
      workId,
      expectedStatuses: [
        CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
        CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
        CARRIER_INVOICE_REPLACEMENT_STATUS.pending,
      ],
      expectedStages: [
        CARRIER_INVOICE_REPLACEMENT_STAGE.precheck,
        CARRIER_INVOICE_REPLACEMENT_STAGE.allocation,
        CARRIER_INVOICE_REPLACEMENT_STAGE.channelUpdate,
      ],
    });
  } catch (error) {
    throw replacementOwnershipError(error);
  }
  ownership.workflowVersion = await updateOwnedReplacement({
    workId,
    executionToken: ownership.executionToken,
    workflowVersion: ownership.workflowVersion,
    data: {
      requested_by_user_id: row.requested_by_user_id ?? input.userId,
      work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
      last_error_code: null,
      last_error_message: null,
      review_required_at: null,
      updated_at: nowKstSqlDateTime(),
    },
  });
  return runOwnedReplacement(workId, ownership, {});
}

export async function cancelCarrierInvoiceReplacement(input: {
  replacementWorkId?: unknown;
  userId: number;
  note?: unknown;
}) {
  const workId = positiveId(input.replacementWorkId, "Replacement work ID");
  const note = requiredText(input.note, "Cancellation note");
  const row = await loadReplacement(workId);
  if (row.channel_updated_at) {
    throw new CarrierInvoiceReplacementError(
      "REPLACEMENT_ALREADY_APPLIED",
      "REPLACEMENT_ALREADY_APPLIED"
    );
  }
  if (TERMINAL_WORK_STATUSES.has(row.work_status)) return toDto(row);
  const now = nowKstSqlDateTime();
  let ownership;
  try {
    ownership = await claimReplacementExecution({
      workId,
      expectedStatuses: [row.work_status],
      expectedStages: [
        CARRIER_INVOICE_REPLACEMENT_STAGE.precheck,
        CARRIER_INVOICE_REPLACEMENT_STAGE.oldInvoiceHandling,
        CARRIER_INVOICE_REPLACEMENT_STAGE.allocation,
      ],
      allowStaleTakeover: false,
    });
  } catch (error) {
    throw replacementOwnershipError(error);
  }
  try {
    ownership.workflowVersion = await runMeasuredTransaction(
      prisma,
      "carrier.invoice-replacement.cancel",
      async (tx) => {
        const nextWorkflowVersion = await updateOwnedReplacement({
          client: tx,
          workId,
          executionToken: ownership.executionToken,
          workflowVersion: ownership.workflowVersion,
          expectedStatuses: [row.work_status],
          expectedStages: [row.current_stage],
          data: {
            work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.canceled,
            execution_token: null,
            execution_started_at: null,
            canceled_at: now,
            resolved_by_user_id: input.userId,
            reason_note: [row.reason_note, note].filter(Boolean).join("\n"),
            updated_at: now,
          },
        });
        if (row.candidate_carrier_shipment_id) {
          try {
            await transitionCarrierInvoiceStatus(tx, {
              carrierShipmentId: row.candidate_carrier_shipment_id,
              expectedFrom: [CARRIER_INVOICE_STATUS.allocated],
              to: CARRIER_INVOICE_STATUS.voidLocal,
              transitionedAt: now,
            });
          } catch (error) {
            if (error instanceof CarrierShipmentStateConflictError) {
              throw new CarrierInvoiceReplacementError(
                "REPLACEMENT_CANDIDATE_STATE_CONFLICT",
                "REPLACEMENT_CANDIDATE_STATE_CONFLICT"
              );
            }
            throw error;
          }
        }
        const restored = await tx.shipment_package_groups.updateMany({
          where: {
            package_group_id: row.package_group_id,
            group_status: "ON_HOLD",
            current_carrier_shipment_id: row.old_carrier_shipment_id,
          },
          data: { group_status: "READY", updated_at: now },
        });
        if (restored.count !== 1) {
          throw new CarrierInvoiceReplacementError(
            "REPLACEMENT_CANCEL_CONFLICT",
            "REPLACEMENT_CANCEL_CONFLICT"
          );
        }
        return nextWorkflowVersion;
      }
    );
  } catch (caught) {
    const error = replacementOwnershipError(caught);
    const current = await loadReplacement(workId);
    if (
      current.execution_token === ownership.executionToken &&
      current.workflow_version === ownership.workflowVersion
    ) {
      await releaseReplacementExecution({
        workId,
        executionToken: ownership.executionToken,
        workflowVersion: ownership.workflowVersion,
        data: {
          work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
          last_error_code:
            error instanceof CarrierInvoiceReplacementError
              ? error.code
              : "REPLACEMENT_CANCEL_FAILED",
          last_error_message:
            error instanceof Error ? error.message.slice(0, 2000) : null,
          review_required_at: nowKstSqlDateTime(),
          updated_at: nowKstSqlDateTime(),
        },
      });
    }
    throw error;
  }
  return getCarrierInvoiceReplacement({ replacementWorkId: workId });
}

export async function finalizePersistedCoupangInvoiceUpdate(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  targetIds: readonly number[];
  actorUserId?: number | null;
  finalizedAt: Date;
  replacementExecutionToken?: string;
  replacementWorkflowVersion?: number;
}) {
  const request = await input.tx.sales_channel_write_requests.findUnique({
    where: { sales_channel_write_request_id: input.requestId },
    include: {
      targets: {
        where: {
          sales_channel_write_request_target_id: { in: [...input.targetIds] },
          external_result_status: "SUCCEEDED",
        },
      },
      carrier_shipment: true,
    },
  });
  if (
    !request ||
    request.channel !== "COUPANG" ||
    request.request_type !==
      SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate ||
    !request.package_group_id ||
    !request.carrier_shipment_id ||
    !request.carrier_shipment
  ) {
    throw new Error("쿠팡 송장번호 변경의 로컬 확정 대상을 찾지 못했습니다.");
  }
  const work =
    await input.tx.carrier_invoice_replacement_works.findUnique({
      where: {
        candidate_carrier_shipment_id: request.carrier_shipment_id,
      },
      include: {
        old_carrier_shipment: true,
        package_group: {
          include: {
            members: {
              where: { removed_at: null },
              select: { external_shipment_id: true },
            },
          },
        },
      },
    });
  if (!work) {
    throw new Error("쿠팡 송장번호 변경에 연결된 교체 작업을 찾지 못했습니다.");
  }
  const expectedNumbers = new Set(
    request.targets
      .map((target) => text(target.invoice_number_snapshot))
      .filter(Boolean)
  );
  if (
    expectedNumbers.size !== 1 ||
    !expectedNumbers.has(request.carrier_shipment.tracking_number)
  ) {
    throw new Error("쿠팡 송장번호 변경 스냅샷과 후보 송장이 일치하지 않습니다.");
  }
  if (
    input.targetIds.length === 0 ||
    request.targets.length !== input.targetIds.length
  ) {
    throw new Error(
      "쿠팡 송장번호 변경 성공 대상의 소유권 또는 외부 성공 상태가 일치하지 않습니다."
    );
  }
  await projectConfirmedCoupangInvoiceWrite({
    tx: input.tx,
    mode: "UPDATE",
    targets: request.targets,
    expectedPreviousInvoiceNumber:
      work.old_carrier_shipment.tracking_number,
    finalizedAt: input.finalizedAt,
  });
  const siblingRequests =
    await input.tx.sales_channel_write_requests.findMany({
      where: {
        channel: "COUPANG",
        request_type:
          SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate,
        package_group_id: work.package_group_id,
        carrier_shipment_id: request.carrier_shipment_id,
      },
      include: { targets: true },
    });
  const confirmedShipmentIds = new Set<string>();
  for (const sibling of siblingRequests) {
    const confirmed =
      sibling.sales_channel_write_request_id === input.requestId ||
      sibling.request_status === SALES_CHANNEL_WRITE_REQUEST_STATUS.completed;
    if (!confirmed) continue;
    for (const target of sibling.targets) {
      const shipmentId = text(target.external_shipment_id);
      if (shipmentId) confirmedShipmentIds.add(shipmentId);
    }
  }
  const allConfirmed = work.package_group.members.every((member) =>
    confirmedShipmentIds.has(member.external_shipment_id)
  );
  if (!allConfirmed) return { allConfirmed: false, switched: false };
  if (
    work.package_group.current_carrier_shipment_id ===
      request.carrier_shipment_id &&
    work.channel_updated_at
  ) {
    return { allConfirmed: true, switched: false };
  }
  if (
    work.package_group.group_status !== "ON_HOLD" ||
    work.package_group.current_carrier_shipment_id !==
      work.old_carrier_shipment_id
  ) {
    throw new Error("쿠팡 송장 변경 확인 전에 현재 송장 또는 보류 상태가 변경되었습니다.");
  }
  const parentData = {
    work_status: CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
    current_stage:
      CARRIER_INVOICE_REPLACEMENT_STAGE.carrierRegistration,
    channel_updated_at: input.finalizedAt,
    execution_token: null,
    execution_started_at: null,
    last_error_code: null,
    last_error_message: null,
    review_required_at: null,
    updated_at: input.finalizedAt,
  } satisfies Prisma.carrier_invoice_replacement_worksUncheckedUpdateManyInput;
  let parentTransitioned = false;
  if (input.replacementExecutionToken) {
    if (input.replacementWorkflowVersion == null) {
      throw new CarrierInvoiceReplacementError(
        "REPLACEMENT_WORKFLOW_VERSION_REQUIRED",
        "REPLACEMENT_WORKFLOW_VERSION_REQUIRED"
      );
    }
    try {
      await updateOwnedReplacement({
        client: input.tx,
        workId: work.carrier_invoice_replacement_work_id,
        executionToken: input.replacementExecutionToken,
        workflowVersion: input.replacementWorkflowVersion,
        expectedStatuses: [
          CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
          CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
        ],
        expectedStages: [CARRIER_INVOICE_REPLACEMENT_STAGE.channelUpdate],
        data: parentData,
      });
    } catch (error) {
      throw replacementOwnershipError(error);
    }
    parentTransitioned = true;
  } else {
    parentTransitioned = await transitionReplacement({
      client: input.tx,
      workId: work.carrier_invoice_replacement_work_id,
      workflowVersion: work.workflow_version,
      expectedStatuses: [
        CARRIER_INVOICE_REPLACEMENT_STATUS.processing,
        CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
      ],
      expectedStages: [CARRIER_INVOICE_REPLACEMENT_STAGE.channelUpdate],
      data: parentData,
    });
  }
  if (!parentTransitioned) {
    throw new CarrierInvoiceReplacementError(
      "REPLACEMENT_EXECUTION_OWNERSHIP_LOST",
      "REPLACEMENT_EXECUTION_OWNERSHIP_LOST"
    );
  }
  await transitionCarrierInvoiceStatus(input.tx, {
    carrierShipmentId: work.old_carrier_shipment_id,
    expectedFrom: [
      CARRIER_INVOICE_STATUS.allocated,
      CARRIER_INVOICE_STATUS.registered,
    ],
    to: CARRIER_INVOICE_STATUS.replaced,
    transitionedAt: input.finalizedAt,
  });
  const updatedGroup = await input.tx.shipment_package_groups.updateMany({
    where: {
      package_group_id: work.package_group_id,
      group_status: "ON_HOLD",
      current_carrier_shipment_id: work.old_carrier_shipment_id,
    },
    data: {
      current_carrier_shipment_id: request.carrier_shipment_id,
      receiver_name_snapshot: work.after_receiver_name ?? "",
      receiver_phone_snapshot: work.after_receiver_phone,
      receiver_post_code_snapshot: work.after_receiver_post_code,
      receiver_address_1_snapshot: work.after_receiver_address_1,
      receiver_address_2_snapshot: work.after_receiver_address_2,
      receiver_address_snapshot: [
        work.after_receiver_post_code,
        work.after_receiver_address_1,
        work.after_receiver_address_2,
      ]
        .map(text)
        .filter(Boolean)
        .join(" / "),
      shipping_memo_snapshot: work.after_shipping_memo,
      updated_at: input.finalizedAt,
    },
  });
  if (updatedGroup.count !== 1) {
    throw new Error("후보 송장을 현재 송장으로 확정하지 못했습니다.");
  }
  await enqueueLogenRegistrationWork(input.tx, {
    carrierShipmentId: request.carrier_shipment_id,
    packageGroupId: work.package_group_id,
    createdAt: input.finalizedAt,
    allowActiveReplacementHold: true,
  });
  await input.tx.employee_activity_logs.create({
    data: {
      user_id: input.actorUserId ?? work.requested_by_user_id,
      action_type: "COUPANG_INVOICE_UPDATE_CONFIRMED",
      target_type: "CARRIER_INVOICE_REPLACEMENT_WORK",
      target_id: String(work.carrier_invoice_replacement_work_id),
      ...activityLogChangeData(
        { carrierShipmentId: work.old_carrier_shipment_id },
        { carrierShipmentId: request.carrier_shipment_id }
      ),
      result: "SUCCESS",
      created_at: input.finalizedAt,
    },
  });
  return { allConfirmed: true, switched: true };
}
