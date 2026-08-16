import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "@/quickhack_server/core/database/keyset-page";
import {
  publicBadRequest,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import {
  SALES_CHANNEL_WRITE_REQUEST_STATUS,
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
} from "@/quickhack_shared/sales-channel/write-requests";

const INVOICE_WRITE_TYPES = [
  SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload,
  SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate,
] as const;
const HISTORY_CURSOR_CONTRACT = "carrier-invoice-history:v1";
const MANUAL_CANDIDATE_CURSOR_CONTRACT = "carrier-invoice-manual-candidates:v1";

const invoiceHistoryInclude = {
  package_group: {
    include: {
      members: {
        where: { removed_at: null },
        orderBy: { member_sequence: "asc" as const },
        include: {
          allocation: {
            include: {
              device: { include: { inventory: true } },
            },
          },
        },
      },
    },
  },
  invoice_issue_item: {
    include: {
      issue_batch: {
        include: {
          replacement_work: {
            select: {
              carrier_invoice_replacement_work_id: true,
              work_status: true,
              current_stage: true,
              source_type: true,
            },
          },
        },
      },
    },
  },
  registration_work: true,
  tracking_events: {
    orderBy: [
      { scan_date: "desc" as const },
      { scan_time: "desc" as const },
      { carrier_tracking_event_id: "desc" as const },
    ],
    take: 20,
  },
  sales_channel_write_requests: {
    where: { request_type: { in: [...INVOICE_WRITE_TYPES] } },
    orderBy: { requested_at: "desc" as const },
    include: {
      attempts: { orderBy: { attempt_no: "desc" as const }, take: 5 },
    },
  },
} satisfies Prisma.carrier_shipmentsInclude;

type InvoiceHistoryRow = Prisma.carrier_shipmentsGetPayload<{
  include: typeof invoiceHistoryInclude;
}>;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function positiveId(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw publicBadRequest(
      "INVALID_INVOICE_OPERATION_ID",
      `${label}이 올바르지 않습니다.`
    );
  }
  return parsed;
}

function limitValue(value: unknown, fallback = 100) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 300)
    : fallback;
}

function writeStageLabel(requestType: string) {
  return requestType ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate
    ? "쿠팡 송장번호 변경"
    : "쿠팡 송장 등록";
}

function toHistoryDto(row: InvoiceHistoryRow) {
  const group = row.package_group;
  const issueItem = row.invoice_issue_item;
  const issueBatch = issueItem?.issue_batch ?? null;
  const registration = row.registration_work;
  const latestWrite = row.sales_channel_write_requests[0] ?? null;
  const replacement = issueBatch?.replacement_work ?? null;

  return {
    carrierShipmentId: row.carrier_shipment_id,
    packageGroupId: row.package_group_id,
    isCurrent:
      group?.current_carrier_shipment_id === row.carrier_shipment_id,
    carrierCode: row.carrier_code,
    sourceType: row.source_type,
    revisionNo: row.revision_no,
    trackingNumber: row.tracking_number,
    previousTrackingNumber: row.previous_tracking_number,
    invoiceStatus: row.invoice_status,
    shipmentStatus: row.shipment_status,
    channel: row.channel,
    externalOrderId: row.external_order_id,
    externalShipmentId: row.external_shipment_id,
    pgNo: row.pg_no,
    packageGroupStatus: group?.group_status ?? null,
    receiverName: group?.receiver_name_snapshot ?? "",
    receiverAddress: group?.receiver_address_snapshot ?? "",
    memberCount: group?.members.length ?? 0,
    members:
      group?.members.map((member) => ({
        allocationId: member.allocation_id,
        externalOrderId: member.external_order_id,
        externalShipmentId: member.external_shipment_id,
        pgNo: member.allocation.pg_no,
        inventoryStatus:
          member.allocation.device.inventory?.inventory_status ?? null,
      })) ?? [],
    issue: issueBatch
      ? {
          issueBatchId: issueBatch.carrier_invoice_issue_batch_id,
          issueItemId: issueItem?.carrier_invoice_issue_item_id ?? null,
          issueType: issueBatch.issue_type,
          batchStatus: issueBatch.batch_status,
          itemStatus: issueItem?.item_status ?? null,
          issueSequence: issueItem?.issue_sequence ?? null,
          requestedAt: issueBatch.created_at,
          completedAt: issueBatch.completed_at,
          labelPrintStatus: issueBatch.label_print_status,
          labelConfirmedAt: issueBatch.label_confirmed_at,
          errorCode: issueItem?.result_code ?? issueBatch.error_code,
          errorMessage: issueItem?.result_message ?? issueBatch.error_message,
        }
      : null,
    channelWrite: latestWrite
      ? {
          requestId: latestWrite.sales_channel_write_request_id,
          requestType: latestWrite.request_type,
          requestTypeLabel: writeStageLabel(latestWrite.request_type),
          status: latestWrite.request_status,
          failureStage: latestWrite.failure_stage,
          errorCode: latestWrite.error_code,
          errorMessage: latestWrite.error_message,
          requestedAt: latestWrite.requested_at,
          completedAt: latestWrite.completed_at,
          attempts: latestWrite.attempts.map((attempt) => ({
            attemptNo: attempt.attempt_no,
            type: attempt.attempt_type,
            status: attempt.attempt_status,
            startedAt: attempt.started_at,
            completedAt: attempt.completed_at,
            errorCode: attempt.error_code,
            errorMessage: attempt.error_message,
          })),
        }
      : null,
    registration: registration
      ? {
          workId: registration.carrier_shipment_registration_work_id,
          status: registration.work_status,
          attemptCount: registration.attempt_count,
          fixTakeNo: registration.fix_take_no,
          takeDate: registration.take_date,
          receiverBranchCode: registration.receiver_branch_code,
          classificationCode: registration.classification_code,
          errorCode: registration.last_error_code,
          errorMessage: registration.last_error_message,
          registeredAt: registration.registered_at,
        }
      : null,
    replacement: replacement
      ? {
          replacementWorkId:
            replacement.carrier_invoice_replacement_work_id,
          status: replacement.work_status,
          stage: replacement.current_stage,
          sourceType: replacement.source_type,
        }
      : null,
    trackingEvents: row.tracking_events.map((event) => ({
      id: event.carrier_tracking_event_id,
      scanDate: event.scan_date,
      scanTime: event.scan_time,
      statusName: event.status_name,
      branchName: event.branch_name,
    })),
    allocatedAt: row.allocated_at,
    carrierRegisteredAt: row.carrier_registered_at,
    lastTrackedAt: row.last_tracked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCarrierInvoiceHistory(input: {
  search?: unknown;
  status?: unknown;
  cursor?: unknown;
  limit?: unknown;
} = {}) {
  const search = text(input.search);
  const status = text(input.status).toUpperCase();
  const limit = limitValue(input.limit);
  const historyFilter: Prisma.carrier_shipmentsWhereInput = {
    ...(status && status !== "ALL"
      ? {
          OR: [
            { invoice_status: status },
            { shipment_status: status },
            { registration_work: { is: { work_status: status } } },
          ],
        }
      : {}),
    ...(search
      ? {
          AND: [
            {
              OR: [
                { tracking_number: { contains: search } },
                { previous_tracking_number: { contains: search } },
                { external_order_id: { contains: search } },
                { external_shipment_id: { contains: search } },
                { pg_no: { contains: search } },
                {
                  package_group: {
                    is: {
                      members: {
                        some: {
                          OR: [
                            { external_order_id: { contains: search } },
                            { external_shipment_id: { contains: search } },
                            {
                              allocation: {
                                pg_no: { contains: search },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
            },
          ],
        }
      : {}),
  };
  const queryIdentity = { search, status: status || "ALL" };
  const cursorText = text(input.cursor);
  const decoded = cursorText
    ? decodeKeysetCursor<
        { maxCarrierShipmentId: number; totalCount: number },
        { carrierShipmentId: number }
      >({
        cursor: cursorText,
        contract: HISTORY_CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;
  return runConsistentReadSnapshot(
    prisma,
    "shipment.invoice-history.read",
    async (tx) => {
      const snapshot = decoded?.snapshot ??
        (await (async () => {
          const [aggregate, totalCount] = await Promise.all([
            tx.carrier_shipments.aggregate({
              where: historyFilter,
              _max: { carrier_shipment_id: true },
            }),
            tx.carrier_shipments.count({ where: historyFilter }),
          ]);
          return {
            maxCarrierShipmentId: aggregate._max.carrier_shipment_id ?? 0,
            totalCount,
          };
        })());
      const beforeId = decoded?.position.carrierShipmentId ?? null;
      const rows = await tx.carrier_shipments.findMany({
        where: {
          AND: [
            historyFilter,
            { carrier_shipment_id: { lte: snapshot.maxCarrierShipmentId } },
            ...(beforeId ? [{ carrier_shipment_id: { lt: beforeId } }] : []),
          ],
        },
        include: invoiceHistoryInclude,
        orderBy: { carrier_shipment_id: "desc" },
        take: limit + 1,
      });
      const page = createKeysetPage({
        rows,
        limit,
        coverage: search || (status && status !== "ALL") ? "FILTERED" : "COMPLETE",
        totalCount: snapshot.totalCount,
        cursorFor: (last) =>
          encodeKeysetCursor({
            contract: HISTORY_CURSOR_CONTRACT,
            queryIdentity,
            snapshot,
            position: { carrierShipmentId: last.carrier_shipment_id },
          }),
      });
      return {
        items: page.items.map(toHistoryDto),
        totalCount: snapshot.totalCount,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        coverage: page.coverage,
      };
    }
  );
}

export async function getCarrierInvoiceHistoryDetail(input: {
  carrierShipmentId?: unknown;
}) {
  const carrierShipmentId = positiveId(
    input.carrierShipmentId,
    "택배 송장 ID"
  );
  const target = await prisma.carrier_shipments.findUnique({
    where: { carrier_shipment_id: carrierShipmentId },
    select: { package_group_id: true },
  });
  if (!target) {
    throw publicNotFound(
      "INVOICE_HISTORY_NOT_FOUND",
      "송장 이력을 찾지 못했습니다."
    );
  }
  const rows = await prisma.carrier_shipments.findMany({
    where: target.package_group_id
      ? { package_group_id: target.package_group_id }
      : { carrier_shipment_id: carrierShipmentId },
    include: invoiceHistoryInclude,
    orderBy: [
      { revision_no: "asc" },
      { carrier_shipment_id: "asc" },
    ],
  });
  return {
    carrierShipmentId,
    packageGroupId: target.package_group_id,
    revisions: rows.map(toHistoryDto),
  };
}

function manualCandidateWhere(search: string): Prisma.carrier_invoice_issue_batchesWhereInput {
  return {
    OR: [
      { batch_status: { in: ["FAILED", "REVIEW_REQUIRED"] } },
      {
        items: {
          some: {
            registration_work: {
              is: { work_status: { in: ["BLOCKED", "REVIEW_REQUIRED"] } },
            },
          },
        },
      },
    ],
    ...(search
      ? {
          AND: [{
            OR: [
              { request_key: { contains: search } },
              {
                items: {
                  some: {
                    OR: [
                      { tracking_number_snapshot: { contains: search } },
                      {
                        package_group: {
                          members: {
                            some: {
                              OR: [
                                { external_order_id: { contains: search } },
                                { allocation: { pg_no: { contains: search } } },
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }],
        }
      : {}),
  };
}

async function loadManualCandidatePageSeed(input: {
  search: string;
  cursor: string;
  limit: number;
}) {
  const queryIdentity = { search: input.search, queue: "UNRESOLVED" };
  const decoded = input.cursor
    ? decodeKeysetCursor<
        { maxIssueBatchId: number; totalCount: number },
        { issueBatchId: number }
      >({
        cursor: input.cursor,
        contract: MANUAL_CANDIDATE_CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;
  const filter = manualCandidateWhere(input.search);
  return runConsistentReadSnapshot(
    prisma,
    "shipment.invoice-manual-candidates.read",
    async (tx) => {
      const snapshot = decoded?.snapshot ??
        (await (async () => {
          const [aggregate, totalCount] = await Promise.all([
            tx.carrier_invoice_issue_batches.aggregate({
              where: filter,
              _max: { carrier_invoice_issue_batch_id: true },
            }),
            tx.carrier_invoice_issue_batches.count({ where: filter }),
          ]);
          return {
            maxIssueBatchId:
              aggregate._max.carrier_invoice_issue_batch_id ?? 0,
            totalCount,
          };
        })());
      const beforeId = decoded?.position.issueBatchId ?? null;
      const rows = await tx.carrier_invoice_issue_batches.findMany({
        where: {
          AND: [
            filter,
            {
              carrier_invoice_issue_batch_id: {
                lte: snapshot.maxIssueBatchId,
              },
            },
            ...(beforeId
              ? [{ carrier_invoice_issue_batch_id: { lt: beforeId } }]
              : []),
          ],
        },
        orderBy: { carrier_invoice_issue_batch_id: "desc" },
        take: input.limit + 1,
        select: { carrier_invoice_issue_batch_id: true },
      });
      const page = createKeysetPage({
        rows,
        limit: input.limit,
        coverage: input.search ? "FILTERED" : "COMPLETE",
        totalCount: snapshot.totalCount,
        cursorFor: (last) =>
          encodeKeysetCursor({
            contract: MANUAL_CANDIDATE_CURSOR_CONTRACT,
            queryIdentity,
            snapshot,
            position: {
              issueBatchId: last.carrier_invoice_issue_batch_id,
            },
          }),
      });
      return {
        ids: page.items.map((row) => row.carrier_invoice_issue_batch_id),
        totalCount: snapshot.totalCount,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        coverage: page.coverage,
      };
    }
  );
}

export async function listCarrierInvoiceManualCandidates(input: {
  search?: unknown;
  limit?: unknown;
  cursor?: unknown;
} = {}) {
  const search = text(input.search);
  const limit = limitValue(input.limit);
  const pageSeed = await loadManualCandidatePageSeed({
    search,
    cursor: text(input.cursor),
    limit,
  });
  const rows = await prisma.carrier_invoice_issue_batches.findMany({
    where: {
      carrier_invoice_issue_batch_id: { in: pageSeed.ids },
      OR: [
        { batch_status: { in: ["FAILED", "REVIEW_REQUIRED"] } },
        {
          items: {
            some: {
              registration_work: {
                is: { work_status: { in: ["BLOCKED", "REVIEW_REQUIRED"] } },
              },
            },
          },
        },
      ],
      ...(search
        ? {
            AND: [
              {
                OR: [
                  { request_key: { contains: search } },
                  {
                    items: {
                      some: {
                        OR: [
                          {
                            tracking_number_snapshot: {
                              contains: search,
                            },
                          },
                          {
                            package_group: {
                              members: {
                                some: {
                                  OR: [
                                    {
                                      external_order_id: {
                                        contains: search,
                                      },
                                    },
                                    {
                                      allocation: {
                                        pg_no: { contains: search },
                                      },
                                    },
                                  ],
                                },
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: { carrier_invoice_issue_batch_id: "desc" },
    include: {
      replacement_work: {
        select: {
          carrier_invoice_replacement_work_id: true,
          work_status: true,
          current_stage: true,
        },
      },
      shipment_list_print_batch: {
        select: {
          batch_label: true,
          shipment_list_print_batch_id: true,
        },
      },
      items: {
        orderBy: { issue_sequence: "asc" },
        include: {
          carrier_shipment: true,
          registration_work: true,
          package_group: {
            include: {
              members: {
                where: { removed_at: null },
                orderBy: { member_sequence: "asc" },
                include: { allocation: true },
              },
            },
          },
        },
      },
    },
  });

  return {
    items: rows.map((batch) => {
      const retryable =
        batch.batch_status === "FAILED" &&
        batch.replacement_work == null;
      const replacement = batch.replacement_work;
      return {
        issueBatchId: batch.carrier_invoice_issue_batch_id,
        shipmentListPrintBatchId:
          batch.shipment_list_print_batch_id,
        shipmentListPrintBatchLabel:
          batch.shipment_list_print_batch.batch_label,
        issueType: batch.issue_type,
        status: batch.batch_status,
        attemptCount: batch.attempt_count,
        errorCode: batch.error_code,
        errorMessage: batch.error_message,
        updatedAt: batch.updated_at,
        replacementWorkId:
          replacement?.carrier_invoice_replacement_work_id ?? null,
        replacementStatus: replacement?.work_status ?? null,
        replacementStage: replacement?.current_stage ?? null,
        nextAction: replacement
          ? {
              code: "OPEN_REPLACEMENT",
              label: "재발급 진행 상태 확인",
            }
          : retryable
            ? {
                code: "RETRY_ALLOCATION",
                label: "송장 채번 다시 시도",
              }
            : {
                code: "REVIEW_ALLOCATION",
                label: "채번 결과 직접 확인",
              },
        items: batch.items.map((item) => ({
          issueItemId: item.carrier_invoice_issue_item_id,
          packageGroupId: item.package_group_id,
          status: item.item_status,
          trackingNumber:
            item.carrier_shipment?.tracking_number ??
            item.tracking_number_snapshot,
          resultCode: item.result_code,
          resultMessage: item.result_message,
          registrationStatus: item.registration_work?.work_status ?? null,
          registrationError:
            item.registration_work?.last_error_message ?? null,
          orders: item.package_group.members.map((member) => ({
            externalOrderId: member.external_order_id,
            externalShipmentId: member.external_shipment_id,
            pgNo: member.allocation.pg_no,
          })),
        })),
      };
    }),
    totalCount: pageSeed.totalCount,
    nextCursor: pageSeed.nextCursor,
    hasMore: pageSeed.hasMore,
    coverage: pageSeed.coverage,
  };
}

export function invoiceWriteIsCompleted(status: string) {
  return status === SALES_CHANNEL_WRITE_REQUEST_STATUS.completed;
}
