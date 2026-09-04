import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { prisma } from "@/quickhack_server/core/prisma";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { assertNoShipmentReturnConflicts } from "@/quickhack_server/returns/shipment-return-conflict-service";
import { projectReplacementFromIssueBatch } from "@/quickhack_server/shipment/carrier-integration/carrier-invoice-replacement-projection-service";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES } from "@/quickhack_shared/shipment/invoice-replacement";
import {
  LOGEN_LABEL_PRINT_STATUS,
  LOGEN_LABEL_TEMPLATE,
  type LogenLabelBlocker,
  type LogenLabelBlockerCode,
  type LogenLabelDto,
} from "@/quickhack_shared/shipment/logen-label";

const TRACKING_NUMBER_PATTERN = /^\d{11}$/;
const ISSUE_BATCH_READY_STATUS = "ALLOCATED";
const ISSUE_ITEM_READY_STATUS = "ALLOCATED";
const PACKAGE_GROUP_READY_STATUS = "READY";
const REGISTRATION_READY_STATUS = "REGISTERED";
const ACTIVE_REPLACEMENT_STATUSES: string[] = [
  ...ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES,
];

const labelBatchInclude = {
  shipment_list_print_batch: {
    include: {
      items: {
        orderBy: [
          { print_line_no: "asc" as const },
          { shipment_list_print_batch_item_id: "asc" as const },
        ],
        select: {
          allocation_id: true,
          package_group_id: true,
          pg_no: true,
        },
      },
    },
  },
  items: {
    orderBy: { issue_sequence: "asc" as const },
    include: {
      carrier_shipment: true,
      registration_work: true,
      package_group: {
        include: {
          invoice_replacement_works: {
            where: {
              work_status: { in: ACTIVE_REPLACEMENT_STATUSES },
            },
            select: {
              candidate_carrier_shipment_id: true,
              carrier_invoice_issue_batch_id: true,
              work_status: true,
            },
          },
          members: {
            where: { removed_at: null },
            orderBy: { member_sequence: "asc" as const },
            select: {
              allocation_id: true,
              external_order_id: true,
              external_shipment_id: true,
              allocation: {
                select: {
                  pg_no: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.carrier_invoice_issue_batchesInclude;

type LabelBatch = Prisma.carrier_invoice_issue_batchesGetPayload<{
  include: typeof labelBatchInclude;
}>;

type LabelBatchClient = Pick<
  Prisma.TransactionClient,
  "carrier_invoice_issue_batches"
>;

export class LogenLabelPrintError extends Error {
  readonly code: string;
  readonly status: number;
  readonly blockers: LogenLabelBlocker[];

  constructor(
    code: string,
    message: string,
    status = 409,
    blockers: LogenLabelBlocker[] = []
  ) {
    super(message);
    this.name = "LogenLabelPrintError";
    this.code = code;
    this.status = status;
    this.blockers = blockers;
  }
}

function positiveId(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new LogenLabelPrintError(
      "INVALID_ID",
      `${label} must be a positive integer.`,
      400
    );
  }
  return parsed;
}

function positiveAttemptCount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new LogenLabelPrintError(
      "INVALID_LABEL_PRINT_ATTEMPT",
      "The expected label print attempt must be a positive integer.",
      400
    );
  }
  return parsed;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function blocker(
  code: LogenLabelBlockerCode,
  message: string,
  item?: LabelBatch["items"][number]
): LogenLabelBlocker {
  return {
    code,
    message,
    issueItemId: item?.carrier_invoice_issue_item_id ?? null,
    issueSequence: item?.issue_sequence ?? null,
    packageGroupId: item?.package_group_id ?? null,
  };
}

async function loadBatchWithClient(
  client: LabelBatchClient,
  issueBatchId: number
) {
  const batch = await client.carrier_invoice_issue_batches.findUnique({
    where: { carrier_invoice_issue_batch_id: issueBatchId },
    include: labelBatchInclude,
  });
  if (!batch) {
    throw new LogenLabelPrintError(
      "ISSUE_BATCH_NOT_FOUND",
      "The carrier invoice issue batch was not found.",
      404
    );
  }
  return batch;
}

async function loadBatch(issueBatchId: number) {
  return loadBatchWithClient(prisma, issueBatchId);
}

function labelForItem(
  item: LabelBatch["items"][number]
): { label: LogenLabelDto | null; blockers: LogenLabelBlocker[] } {
  const blockers: LogenLabelBlocker[] = [];
  const group = item.package_group;
  const shipment = item.carrier_shipment;
  const work = item.registration_work;
  const trackingNumber =
    text(shipment?.tracking_number) || text(item.tracking_number_snapshot);
  const activeReplacement =
    group.invoice_replacement_works.find(
      (replacement) =>
        replacement.candidate_carrier_shipment_id ===
          item.carrier_shipment_id &&
        replacement.carrier_invoice_issue_batch_id ===
          item.carrier_invoice_issue_batch_id
    ) ?? null;
  const groupReadyForPrint =
    group.group_status === PACKAGE_GROUP_READY_STATUS ||
    (group.group_status === "ON_HOLD" && Boolean(activeReplacement));

  if (item.item_status !== ISSUE_ITEM_READY_STATUS) {
    blockers.push(
      blocker(
        "ISSUE_ITEM_NOT_ALLOCATED",
        `Invoice item status is ${item.item_status}.`,
        item
      )
    );
  }
  if (!shipment || item.carrier_shipment_id !== shipment.carrier_shipment_id) {
    blockers.push(
      blocker(
        "CARRIER_SHIPMENT_MISSING",
        "The current carrier shipment is not connected.",
        item
      )
    );
  }
  if (!TRACKING_NUMBER_PATTERN.test(trackingNumber)) {
    blockers.push(
      blocker(
        "INVALID_TRACKING_NUMBER",
        "The Logen tracking number must contain 11 digits.",
        item
      )
    );
  }
  if (
    !groupReadyForPrint ||
    group.current_carrier_shipment_id !== item.carrier_shipment_id
  ) {
    blockers.push(
      blocker(
        "PACKAGE_GROUP_NOT_READY",
        `Package group status is ${group.group_status}.`,
        item
      )
    );
  }
  if (!work || work.work_status !== REGISTRATION_READY_STATUS) {
    blockers.push(
      blocker(
        "LOGEN_REGISTRATION_NOT_READY",
        `Logen registration status is ${work?.work_status ?? "MISSING"}.`,
        item
      )
    );
  }

  const requiredSnapshots: Array<[string, unknown]> = [
    ["receiver name", group.receiver_name_snapshot],
    ["receiver phone", group.receiver_phone_snapshot],
    ["receiver address1", group.receiver_address_1_snapshot],
    ["receiver address2", group.receiver_address_2_snapshot],
    ["customer code", work?.customer_code_snapshot],
    ["sender name", work?.sender_name_snapshot],
    ["sender telephone", work?.sender_tel_snapshot],
    ["sender address1", work?.sender_address_1_snapshot],
    ["sender address2", work?.sender_address_2_snapshot],
    ["receiver branch", work?.receiver_branch_code],
    ["classification code", work?.classification_code],
    ["classified zip code", work?.classified_zip_code],
    ["goods name", work?.goods_name_snapshot],
  ];
  const missing = requiredSnapshots
    .filter(([, value]) => !text(value))
    .map(([name]) => name);
  if (missing.length > 0) {
    blockers.push(
      blocker(
        "LABEL_SNAPSHOT_INCOMPLETE",
        `Required label snapshots are missing: ${missing.join(", ")}.`,
        item
      )
    );
  }

  if (blockers.length > 0 || !shipment || !work) {
    return { label: null, blockers };
  }

  return {
    blockers,
    label: {
      issueItemId: item.carrier_invoice_issue_item_id,
      issueSequence: item.issue_sequence,
      packageGroupId: item.package_group_id,
      trackingNumber,
      revisionNo: item.revision_no,
      receiver: {
        name: text(group.receiver_name_snapshot),
        phone: text(group.receiver_phone_snapshot),
        postCode: text(group.receiver_post_code_snapshot),
        address1: text(group.receiver_address_1_snapshot),
        address2: text(group.receiver_address_2_snapshot),
        memo: text(group.shipping_memo_snapshot),
      },
      sender: {
        customerCode: text(work.customer_code_snapshot),
        name: text(work.sender_name_snapshot),
        tel: text(work.sender_tel_snapshot),
        cell: text(work.sender_cell_snapshot),
        postCode: text(work.sender_zip_code_snapshot),
        address1: text(work.sender_address_1_snapshot),
        address2: text(work.sender_address_2_snapshot),
      },
      classification: {
        branchCode: text(work.receiver_branch_code),
        dongName: text(work.receiver_dong_name),
        classCode: text(work.classification_code),
        zipCode: text(work.classified_zip_code),
        salesOfficeName: text(work.sales_office_name),
        terminalName: text(work.terminal_name),
        branchShareYn: text(work.branch_share_yn),
      },
      parcel: {
        goodsName: text(work.goods_name_snapshot),
        goodsAmount: Number(work.goods_amount_snapshot ?? 0),
        fareType: text(work.fare_type),
        boxTypeCode: text(work.box_type_code),
        deliveryFare: Number(work.delivery_fare ?? 0),
        extraFare: Number(work.extra_fare ?? 0),
        takeDate: work.take_date,
        packageMemberCount: group.members.length,
        pgNos: group.members.map((member) => member.allocation.pg_no),
      },
    },
  };
}

function buildView(batch: LabelBatch) {
  const blockers: LogenLabelBlocker[] = [];
  if (batch.batch_status !== ISSUE_BATCH_READY_STATUS) {
    blockers.push(
      blocker(
        "ISSUE_BATCH_NOT_ALLOCATED",
        `Invoice issue batch status is ${batch.batch_status}.`
      )
    );
  }
  if (batch.items.length === 0) {
    blockers.push(blocker("ISSUE_BATCH_EMPTY", "The issue batch has no items."));
  }

  const labels: LogenLabelDto[] = [];
  for (const item of batch.items) {
    const result = labelForItem(item);
    blockers.push(...result.blockers);
    if (result.label) labels.push(result.label);
  }

  if (labels.length > LOGEN_LABEL_TEMPLATE.maxBatchSize) {
    blockers.push(
      blocker(
        "LABEL_BATCH_TOO_LARGE",
        `At most ${LOGEN_LABEL_TEMPLATE.maxBatchSize} labels can be printed at once.`
      )
    );
  }

  const activeTargetIds = batch.label_active_request_key
    ? new Set(
        batch.items
          .filter(
            (item) =>
              item.label_print_attempt_no === batch.label_print_attempt_count
          )
          .map((item) => item.carrier_invoice_issue_item_id)
      )
    : null;
  const targetLabels = activeTargetIds
    ? labels.filter((label) => activeTargetIds.has(label.issueItemId))
    : batch.label_print_status === LOGEN_LABEL_PRINT_STATUS.partial ||
        batch.label_print_status === LOGEN_LABEL_PRINT_STATUS.failed
      ? labels.filter((label) => {
          const item = batch.items.find(
            (candidate) =>
              candidate.carrier_invoice_issue_item_id === label.issueItemId
          );
          return item?.label_print_status === LOGEN_LABEL_PRINT_STATUS.failed;
        })
      : labels;

  return {
    issueBatchId: batch.carrier_invoice_issue_batch_id,
    shipmentListPrintBatchId: batch.shipment_list_print_batch_id,
    shipmentListPrintBatchLabel: batch.shipment_list_print_batch.batch_label,
    issueType: batch.issue_type,
    issueStatus: batch.batch_status,
    batchRevision: batch.revision,
    labelPrintStatus: batch.label_print_status,
    activeRequestKey: batch.label_active_request_key,
    printAttemptCount: batch.label_print_attempt_count,
    payloadHash: batch.label_payload_hash,
    previewPayloadHash: hash({ template: LOGEN_LABEL_TEMPLATE, labels: targetLabels }),
    printerName: batch.label_printer_name,
    template: LOGEN_LABEL_TEMPLATE,
    ready:
      blockers.length === 0 &&
      !batch.label_active_request_key &&
      batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.confirmed &&
      batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.spooled &&
      batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.unknown &&
      targetLabels.length > 0,
    blockers,
    labels,
    targetIssueItemIds: targetLabels.map((label) => label.issueItemId),
    items: batch.items.map((item) => ({
      issueItemId: item.carrier_invoice_issue_item_id,
      issueSequence: item.issue_sequence,
      packageGroupId: item.package_group_id,
      trackingNumber:
        item.carrier_shipment?.tracking_number ??
        item.tracking_number_snapshot,
      printStatus: item.label_print_status,
      printCount: item.label_print_count,
      lastSpooledAt: item.label_last_spooled_at,
      confirmedAt: item.label_confirmed_at,
      lastErrorCode: item.label_last_error_code,
      lastErrorMessage: item.label_last_error_message,
    })),
  };
}

async function buildValidatedView(batch: LabelBatch) {
  const allocationIds =
    batch.shipment_list_print_batch.items.map((item) => item.allocation_id);
  try {
    await assertNoShipmentReturnConflicts(prisma, allocationIds);
  } catch (error) {
    const view = buildView(batch);
    return {
      ...view,
      ready: false,
      blockers: [
        ...view.blockers,
        blocker(
          "SHIPMENT_RETURN_CONFLICT",
          error instanceof Error ? error.message : String(error)
        ),
      ],
    };
  }
  return buildView(batch);
}

export async function getLogenLabelPrintView(input: {
  issueBatchId?: unknown;
}) {
  const issueBatchId = positiveId(input.issueBatchId, "Issue batch ID");
  const batch = await loadBatch(issueBatchId);
  return buildValidatedView(batch);
}

export async function startLogenLabelPrint(input: {
  issueBatchId?: unknown;
  printerName?: unknown;
  userId?: number | null;
  sessionId: string;
  previewToken: string;
  previewTokenSecret: string;
}) {
  const issueBatchId = positiveId(input.issueBatchId, "Issue batch ID");
  const printerName = text(input.printerName);
  if (!printerName) {
    throw new LogenLabelPrintError(
      "PRINTER_REQUIRED",
      "A Windows printer queue must be selected.",
      400
    );
  }

  const existing = await loadBatch(issueBatchId);
  const existingView = await buildValidatedView(existing);
  if (existing.label_active_request_key) {
    const targetLabels = existingView.labels.filter((label) =>
      existingView.targetIssueItemIds.includes(label.issueItemId)
    );
    if (targetLabels.length === 0) {
      throw labelPrintStateConflict(
        "The active label print attempt has no persisted target items."
      );
    }
    return {
      ...existingView,
      ready: true,
      requestKey: existing.label_active_request_key,
      payloadHash: existing.label_payload_hash,
      labels: targetLabels,
    };
  }
  if (!existingView.ready) {
    throw new LogenLabelPrintError(
      "LABEL_PRINT_NOT_READY",
      "The invoice batch is not ready for label printing.",
      409,
      existingView.blockers
    );
  }

  const labels = existingView.labels.filter((label) =>
    existingView.targetIssueItemIds.includes(label.issueItemId)
  );
  const itemHashes = new Map(
    labels.map((label) => [label.issueItemId, hash(label)])
  );
  const payloadHash = hash({
    template: LOGEN_LABEL_TEMPLATE,
    labels,
  });
  const requestKey = `LOGEN-LABEL-${issueBatchId}-${randomUUID()}`;
  const printAttemptCount = existing.label_print_attempt_count + 1;
  const now = databaseNow();
  const existingItems = new Map(
    existing.items.map((item) => [
      item.carrier_invoice_issue_item_id,
      item,
    ])
  );

  await runMeasuredTransaction(
    prisma,
    "carrier.label-print.start",
    async (tx) => {
      await tx.$queryRaw`
        SELECT carrier_invoice_issue_batch_id
        FROM carrier_invoice_issue_batches
        WHERE carrier_invoice_issue_batch_id = ${issueBatchId}
        FOR UPDATE
      `;
      const locked = await loadBatchWithClient(tx, issueBatchId);
      const lockedView = buildView(locked);
      const { verifyOutputPreviewToken } = await import(
        "@/quickhack_server/shipment/output-preview-token"
      );
      try {
        verifyOutputPreviewToken(
          input.previewToken,
          {
            userId: input.userId ?? 0,
            sessionId: input.sessionId,
            issueBatchId,
            shipmentListPrintBatchId: locked.shipment_list_print_batch_id,
            revision: locked.revision,
            payloadHash: lockedView.previewPayloadHash,
          },
          input.previewTokenSecret
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : "OUTPUT_PREVIEW_TOKEN_INVALID";
        throw new LogenLabelPrintError(
          code === "OUTPUT_PREVIEW_TOKEN_EXPIRED" ? code : "OUTPUT_PREVIEW_STALE",
          code === "OUTPUT_PREVIEW_TOKEN_EXPIRED"
            ? "The output preview expired. Refresh the preview before printing."
            : "The output preview no longer matches the label batch. Refresh it before printing."
        );
      }
      const claimed = await tx.carrier_invoice_issue_batches.updateMany({
        where: {
          carrier_invoice_issue_batch_id: issueBatchId,
          label_active_request_key: null,
          label_print_attempt_count: existing.label_print_attempt_count,
          label_print_status: existing.label_print_status,
          batch_status: ISSUE_BATCH_READY_STATUS,
          revision: locked.revision,
        },
        data: {
          label_template_code: LOGEN_LABEL_TEMPLATE.code,
          label_template_version: LOGEN_LABEL_TEMPLATE.version,
          label_printer_name: printerName,
          label_payload_hash: payloadHash,
          label_active_request_key: requestKey,
          label_print_attempt_count: { increment: 1 },
          label_last_started_at: now,
          label_last_error_code: null,
          label_last_error_message: null,
          updated_at: now,
          revision: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        throw new LogenLabelPrintError(
          "LABEL_PRINT_ALREADY_ACTIVE",
          "Another label print request is already active."
        );
      }
      for (const label of labels) {
        const existingItem = existingItems.get(label.issueItemId);
        if (!existingItem) {
          throw new LogenLabelPrintError(
            "LABEL_PRINT_ITEM_MISSING",
            "A label print target disappeared before the attempt was claimed."
          );
        }
        const itemClaimed = await tx.carrier_invoice_issue_items.updateMany({
          where: {
            carrier_invoice_issue_item_id: label.issueItemId,
            carrier_invoice_issue_batch_id: issueBatchId,
            label_print_status: existingItem.label_print_status,
            label_print_attempt_no: existingItem.label_print_attempt_no,
            label_payload_hash: existingItem.label_payload_hash,
          },
          data: {
            label_payload_hash: itemHashes.get(label.issueItemId),
            label_print_attempt_no: printAttemptCount,
            label_last_error_code: null,
            label_last_error_message: null,
            updated_at: now,
          },
        });
        if (itemClaimed.count !== 1) {
          throw new LogenLabelPrintError(
            "LABEL_PRINT_ITEM_STATE_CONFLICT",
            "A label print target changed while the attempt was being claimed."
          );
        }
      }
      await tx.employee_activity_logs.create({
        data: {
          user_id: input.userId ?? null,
          action_type: "LOGEN_LABEL_PRINT_STARTED",
          target_type: "CARRIER_INVOICE_ISSUE_BATCH",
          target_id: String(issueBatchId),
          result: "SUCCESS",
          ...activityLogChangeData(null, {
            requestKey,
            payloadHash,
            printAttemptCount,
            printerName,
            issueItemIds: labels.map((label) => label.issueItemId),
          }),
        },
      });
    }
  );

  return {
    ...existingView,
    ready: true,
    activeRequestKey: requestKey,
    requestKey,
    payloadHash,
    printAttemptCount,
    printerName,
    labels,
  };
}

function attemptTargetItems(batch: LabelBatch, printAttemptCount: number) {
  return batch.items.filter(
    (item) => item.label_print_attempt_no === printAttemptCount
  );
}

function labelPrintRequestStale() {
  return new LogenLabelPrintError(
    "LABEL_PRINT_REQUEST_STALE",
    "The label print request no longer owns the active attempt."
  );
}

function labelPrintStateConflict(message: string) {
  return new LogenLabelPrintError("LABEL_PRINT_STATE_CONFLICT", message);
}

function labelPrintItemStateConflict() {
  return new LogenLabelPrintError(
    "LABEL_PRINT_ITEM_STATE_CONFLICT",
    "A label print target changed during the state transition."
  );
}

function activeRequestMatches(
  batch: LabelBatch,
  requestKey: string,
  payloadHash: string,
  printAttemptCount: number
) {
  return (
    batch.label_active_request_key === requestKey &&
    batch.label_payload_hash === payloadHash &&
    batch.label_print_attempt_count === printAttemptCount
  );
}

function completedAttemptMatches(
  batch: LabelBatch,
  payloadHash: string,
  printAttemptCount: number
) {
  return (
    batch.label_active_request_key === null &&
    batch.label_payload_hash === payloadHash &&
    batch.label_print_attempt_count === printAttemptCount
  );
}

export async function recordLogenLabelPrintSpooled(input: {
  issueBatchId?: unknown;
  requestKey?: unknown;
  payloadHash?: unknown;
  expectedPrintAttemptCount?: unknown;
  userId?: number | null;
}) {
  const issueBatchId = positiveId(input.issueBatchId, "Issue batch ID");
  const requestKey = text(input.requestKey);
  const payloadHash = text(input.payloadHash);
  const printAttemptCount = positiveAttemptCount(
    input.expectedPrintAttemptCount
  );
  const now = databaseNow();

  await runMeasuredTransaction(
    prisma,
    "carrier.label-print.spooled",
    async (tx) => {
      const batch = await loadBatchWithClient(tx, issueBatchId);
      if (
        !activeRequestMatches(
          batch,
          requestKey,
          payloadHash,
          printAttemptCount
        )
      ) {
        throw labelPrintRequestStale();
      }
      const targetItems = attemptTargetItems(batch, printAttemptCount);
      if (targetItems.length === 0) {
        throw labelPrintStateConflict(
          "The active label print attempt has no target items."
        );
      }
      if (batch.label_print_status === LOGEN_LABEL_PRINT_STATUS.spooled) {
        if (
          targetItems.every(
            (item) =>
              item.label_print_status === LOGEN_LABEL_PRINT_STATUS.spooled
          )
        ) {
          return;
        }
        throw labelPrintStateConflict(
          "The spooled label print attempt has inconsistent item states."
        );
      }
      if (
        batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.notPrinted &&
        batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.partial &&
        batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.failed
      ) {
        throw labelPrintStateConflict(
          `A ${batch.label_print_status} label print attempt cannot be marked as spooled.`
        );
      }
      const claimed = await tx.carrier_invoice_issue_batches.updateMany({
        where: {
          carrier_invoice_issue_batch_id: issueBatchId,
          label_active_request_key: requestKey,
          label_payload_hash: payloadHash,
          label_print_attempt_count: printAttemptCount,
          label_print_status: batch.label_print_status,
        },
        data: {
          label_print_status: LOGEN_LABEL_PRINT_STATUS.spooled,
          label_last_spooled_at: now,
          updated_at: now,
        },
      });
      if (claimed.count !== 1) throw labelPrintRequestStale();
      for (const item of targetItems) {
        const updated = await tx.carrier_invoice_issue_items.updateMany({
          where: {
            carrier_invoice_issue_item_id:
              item.carrier_invoice_issue_item_id,
            carrier_invoice_issue_batch_id: issueBatchId,
            label_print_attempt_no: printAttemptCount,
            label_payload_hash: item.label_payload_hash,
            label_print_status: item.label_print_status,
          },
          data: {
            label_print_status: LOGEN_LABEL_PRINT_STATUS.spooled,
            label_print_count: { increment: 1 },
            label_last_spooled_at: now,
            label_last_error_code: null,
            label_last_error_message: null,
            updated_at: now,
          },
        });
        if (updated.count !== 1) throw labelPrintItemStateConflict();
      }
      await tx.employee_activity_logs.create({
        data: {
          user_id: input.userId ?? null,
          action_type: "LOGEN_LABEL_PRINT_SPOOLED",
          target_type: "CARRIER_INVOICE_ISSUE_BATCH",
          target_id: String(issueBatchId),
          result: "SUCCESS",
          ...activityLogChangeData(null, {
            requestKey,
            payloadHash,
            printAttemptCount,
            issueItemIds: targetItems.map(
              (item) => item.carrier_invoice_issue_item_id
            ),
          }),
        },
      });
    }
  );
  return getLogenLabelPrintView({ issueBatchId });
}

export async function confirmLogenLabelPrint(input: {
  issueBatchId?: unknown;
  requestKey?: unknown;
  payloadHash?: unknown;
  expectedPrintAttemptCount?: unknown;
  failedIssueItemIds?: unknown;
  userId?: number | null;
}) {
  const issueBatchId = positiveId(input.issueBatchId, "Issue batch ID");
  const requestKey = text(input.requestKey);
  const payloadHash = text(input.payloadHash);
  const printAttemptCount = positiveAttemptCount(
    input.expectedPrintAttemptCount
  );
  const failedIds = new Set(
    (Array.isArray(input.failedIssueItemIds)
      ? input.failedIssueItemIds
      : []
    )
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  );
  const now = databaseNow();
  await runMeasuredTransaction(
    prisma,
    "carrier.label-print.confirm",
    async (tx) => {
      const batch = await loadBatchWithClient(tx, issueBatchId);
      if (batch.label_print_attempt_count !== printAttemptCount) {
        throw labelPrintRequestStale();
      }
      const targetItems = attemptTargetItems(batch, printAttemptCount);
      if (
        targetItems.length === 0 ||
        Array.from(failedIds).some(
          (id) =>
            !targetItems.some(
              (item) => item.carrier_invoice_issue_item_id === id
            )
        )
      ) {
        throw new LogenLabelPrintError(
          "INVALID_FAILED_LABEL_SELECTION",
          "A failed label does not belong to the expected print attempt.",
          400
        );
      }
      const desiredItemStatus = (issueItemId: number) =>
        failedIds.has(issueItemId)
          ? LOGEN_LABEL_PRINT_STATUS.failed
          : LOGEN_LABEL_PRINT_STATUS.confirmed;
      if (
        completedAttemptMatches(batch, payloadHash, printAttemptCount) &&
        targetItems.every(
          (item) =>
            item.label_print_status ===
            desiredItemStatus(item.carrier_invoice_issue_item_id)
        )
      ) {
        return;
      }
      if (
        !activeRequestMatches(
          batch,
          requestKey,
          payloadHash,
          printAttemptCount
        )
      ) {
        throw labelPrintRequestStale();
      }
      if (batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.spooled) {
        throw labelPrintStateConflict(
          "Only a spooled label print attempt can be confirmed."
        );
      }
      if (
        !targetItems.every(
          (item) => item.label_print_status === LOGEN_LABEL_PRINT_STATUS.spooled
        )
      ) {
        throw labelPrintStateConflict(
          "The active label print attempt has inconsistent spooled item states."
        );
      }
      const confirmedBefore = batch.items.filter(
        (item) =>
          item.label_print_attempt_no !== printAttemptCount &&
          item.label_print_status === LOGEN_LABEL_PRINT_STATUS.confirmed
      ).length;
      const confirmedNow = targetItems.length - failedIds.size;
      const confirmedCount = confirmedBefore + confirmedNow;
      const nextStatus =
        confirmedCount === batch.items.length
          ? LOGEN_LABEL_PRINT_STATUS.confirmed
          : confirmedCount > 0
            ? LOGEN_LABEL_PRINT_STATUS.partial
            : LOGEN_LABEL_PRINT_STATUS.failed;
      const claimed = await tx.carrier_invoice_issue_batches.updateMany({
        where: {
          carrier_invoice_issue_batch_id: issueBatchId,
          label_active_request_key: requestKey,
          label_payload_hash: payloadHash,
          label_print_attempt_count: printAttemptCount,
          label_print_status: LOGEN_LABEL_PRINT_STATUS.spooled,
        },
        data: {
          label_print_status: nextStatus,
          label_active_request_key: null,
          label_confirmed_at:
            nextStatus === LOGEN_LABEL_PRINT_STATUS.confirmed ? now : null,
          label_last_error_code:
            failedIds.size > 0 ? "PHYSICAL_PRINT_PARTIAL" : null,
          label_last_error_message:
            failedIds.size > 0
              ? `${failedIds.size} label(s) require recovery printing.`
              : null,
          updated_at: now,
        },
      });
      if (claimed.count !== 1) throw labelPrintRequestStale();
      for (const item of targetItems) {
        const failed = failedIds.has(item.carrier_invoice_issue_item_id);
        const updated = await tx.carrier_invoice_issue_items.updateMany({
          where: {
            carrier_invoice_issue_item_id:
              item.carrier_invoice_issue_item_id,
            carrier_invoice_issue_batch_id: issueBatchId,
            label_print_attempt_no: printAttemptCount,
            label_print_status: LOGEN_LABEL_PRINT_STATUS.spooled,
          },
          data: {
            label_print_status: failed
              ? LOGEN_LABEL_PRINT_STATUS.failed
              : LOGEN_LABEL_PRINT_STATUS.confirmed,
            label_confirmed_at: failed ? null : now,
            label_last_error_code: failed
              ? "PHYSICAL_PRINT_FAILED"
              : null,
            label_last_error_message: failed
              ? "The operator marked this label as failed."
              : null,
            updated_at: now,
          },
        });
        if (updated.count !== 1) throw labelPrintItemStateConflict();
      }
      await tx.employee_activity_logs.create({
        data: {
          user_id: input.userId ?? null,
          action_type:
            failedIds.size > 0
              ? "LOGEN_LABEL_PRINT_PARTIAL"
              : "LOGEN_LABEL_PRINT_CONFIRMED",
          target_type: "CARRIER_INVOICE_ISSUE_BATCH",
          target_id: String(issueBatchId),
          result: failedIds.size > 0 ? "PARTIAL" : "SUCCESS",
          ...activityLogChangeData(null, {
            requestKey,
            payloadHash,
            printAttemptCount,
            failedIssueItemIds: Array.from(failedIds),
          }),
        },
      });
    }
  );
  await projectReplacementFromIssueBatch({
    issueBatchId,
    projectedAt: now,
    actorUserId: input.userId,
  });
  return getLogenLabelPrintView({ issueBatchId });
}

export async function failLogenLabelPrint(input: {
  issueBatchId?: unknown;
  requestKey?: unknown;
  payloadHash?: unknown;
  expectedPrintAttemptCount?: unknown;
  uncertain?: boolean;
  errorCode?: unknown;
  errorMessage?: unknown;
  userId?: number | null;
}) {
  const issueBatchId = positiveId(input.issueBatchId, "Issue batch ID");
  const requestKey = text(input.requestKey);
  const payloadHash = text(input.payloadHash);
  const printAttemptCount = positiveAttemptCount(
    input.expectedPrintAttemptCount
  );
  const uncertain = Boolean(input.uncertain);
  const status = uncertain
    ? LOGEN_LABEL_PRINT_STATUS.unknown
    : LOGEN_LABEL_PRINT_STATUS.failed;
  const errorCode =
    text(input.errorCode) ||
    (uncertain ? "PRINT_RESULT_UNKNOWN" : "PRINT_SPOOL_FAILED");
  const errorMessage =
    text(input.errorMessage) ||
    (uncertain
      ? "The physical print result could not be determined."
      : "The label job was not accepted by the Windows spooler.");
  const now = databaseNow();

  await runMeasuredTransaction(
    prisma,
    "carrier.label-print.fail",
    async (tx) => {
      const batch = await loadBatchWithClient(tx, issueBatchId);
      if (batch.label_print_attempt_count !== printAttemptCount) {
        throw labelPrintRequestStale();
      }
      const targetItems = attemptTargetItems(batch, printAttemptCount);
      if (targetItems.length === 0) {
        throw labelPrintStateConflict(
          "The expected label print attempt has no target items."
        );
      }
      const replayMatches = uncertain
        ? batch.label_print_status === LOGEN_LABEL_PRINT_STATUS.unknown &&
          targetItems.every(
            (item) =>
              item.label_print_status === LOGEN_LABEL_PRINT_STATUS.unknown
          )
        : (batch.label_print_status === LOGEN_LABEL_PRINT_STATUS.partial ||
            batch.label_print_status === LOGEN_LABEL_PRINT_STATUS.failed) &&
          targetItems.every(
            (item) =>
              item.label_print_status === LOGEN_LABEL_PRINT_STATUS.failed
          );
      if (
        uncertain &&
        activeRequestMatches(
          batch,
          requestKey,
          payloadHash,
          printAttemptCount
        ) &&
        replayMatches
      ) {
        return;
      }
      if (
        completedAttemptMatches(batch, payloadHash, printAttemptCount) &&
        replayMatches
      ) {
        return;
      }
      if (
        !activeRequestMatches(
          batch,
          requestKey,
          payloadHash,
          printAttemptCount
        )
      ) {
        throw labelPrintRequestStale();
      }
      if (
        batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.notPrinted &&
        batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.partial &&
        batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.failed
      ) {
        throw labelPrintStateConflict(
          `A ${batch.label_print_status} label print attempt cannot be marked as ${status}.`
        );
      }
      if (
        targetItems.some(
          (item) =>
            item.label_print_status === LOGEN_LABEL_PRINT_STATUS.spooled ||
            item.label_print_status === LOGEN_LABEL_PRINT_STATUS.confirmed ||
            item.label_print_status === LOGEN_LABEL_PRINT_STATUS.unknown
        )
      ) {
        throw labelPrintStateConflict(
          "The active label print attempt has inconsistent item states."
        );
      }
      const hasConfirmed = batch.items.some(
        (item) =>
          item.label_print_attempt_no !== printAttemptCount &&
          item.label_print_status === LOGEN_LABEL_PRINT_STATUS.confirmed
      );
      const nextStatus = uncertain
        ? LOGEN_LABEL_PRINT_STATUS.unknown
        : hasConfirmed
          ? LOGEN_LABEL_PRINT_STATUS.partial
          : LOGEN_LABEL_PRINT_STATUS.failed;
      const claimed = await tx.carrier_invoice_issue_batches.updateMany({
        where: {
          carrier_invoice_issue_batch_id: issueBatchId,
          label_active_request_key: requestKey,
          label_payload_hash: payloadHash,
          label_print_attempt_count: printAttemptCount,
          label_print_status: batch.label_print_status,
        },
        data: {
          label_print_status: nextStatus,
          label_active_request_key: uncertain ? requestKey : null,
          label_last_error_code: errorCode,
          label_last_error_message: errorMessage,
          updated_at: now,
        },
      });
      if (claimed.count !== 1) throw labelPrintRequestStale();
      for (const item of targetItems) {
        const updated = await tx.carrier_invoice_issue_items.updateMany({
          where: {
            carrier_invoice_issue_item_id:
              item.carrier_invoice_issue_item_id,
            carrier_invoice_issue_batch_id: issueBatchId,
            label_print_attempt_no: printAttemptCount,
            label_print_status: item.label_print_status,
          },
          data: {
            label_print_status: status,
            label_last_error_code: errorCode,
            label_last_error_message: errorMessage,
            updated_at: now,
          },
        });
        if (updated.count !== 1) throw labelPrintItemStateConflict();
      }
      await tx.employee_activity_logs.create({
        data: {
          user_id: input.userId ?? null,
          action_type: uncertain
            ? "LOGEN_LABEL_PRINT_RESULT_UNKNOWN"
            : "LOGEN_LABEL_PRINT_FAILED",
          target_type: "CARRIER_INVOICE_ISSUE_BATCH",
          target_id: String(issueBatchId),
          result: uncertain ? "UNKNOWN" : "FAILED",
          ...activityLogChangeData(null, {
            requestKey,
            payloadHash,
            printAttemptCount,
            errorCode,
            issueItemIds: targetItems.map(
              (item) => item.carrier_invoice_issue_item_id
            ),
          }),
        },
      });
    }
  );
  await projectReplacementFromIssueBatch({
    issueBatchId,
    projectedAt: now,
    actorUserId: input.userId,
  });
  return getLogenLabelPrintView({ issueBatchId });
}

export async function resolveUnknownLogenLabelPrint(input: {
  issueBatchId?: unknown;
  printed?: boolean;
  expectedPrintAttemptCount?: unknown;
  userId?: number | null;
}) {
  const issueBatchId = positiveId(input.issueBatchId, "Issue batch ID");
  const printAttemptCount = positiveAttemptCount(
    input.expectedPrintAttemptCount
  );
  const printed = Boolean(input.printed);
  const now = databaseNow();
  await runMeasuredTransaction(
    prisma,
    "carrier.label-print.resolve-unknown",
    async (tx) => {
      const batch = await loadBatchWithClient(tx, issueBatchId);
      if (batch.label_print_attempt_count !== printAttemptCount) {
        throw labelPrintRequestStale();
      }
      const targetItems = attemptTargetItems(batch, printAttemptCount);
      if (targetItems.length === 0) {
        throw new LogenLabelPrintError(
          "UNKNOWN_LABEL_ITEMS_MISSING",
          "There are no labels owned by the expected print attempt."
        );
      }
      const desiredStatus = printed
        ? LOGEN_LABEL_PRINT_STATUS.confirmed
        : LOGEN_LABEL_PRINT_STATUS.failed;
      if (
        batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.unknown &&
        batch.label_active_request_key === null &&
        targetItems.every(
          (item) => item.label_print_status === desiredStatus
        )
      ) {
        return;
      }
      if (
        batch.label_print_status !== LOGEN_LABEL_PRINT_STATUS.unknown
      ) {
        throw labelPrintStateConflict(
          "Only the current unknown label print attempt can be resolved."
        );
      }
      if (
        !targetItems.every(
          (item) => item.label_print_status === LOGEN_LABEL_PRINT_STATUS.unknown
        )
      ) {
        throw labelPrintStateConflict(
          "The unknown label print attempt has inconsistent item states."
        );
      }
      const confirmedCount =
        batch.items.filter(
          (item) =>
            item.label_print_attempt_no !== printAttemptCount &&
            item.label_print_status === LOGEN_LABEL_PRINT_STATUS.confirmed
        ).length + (printed ? targetItems.length : 0);
      const nextStatus = printed
        ? confirmedCount === batch.items.length
          ? LOGEN_LABEL_PRINT_STATUS.confirmed
          : LOGEN_LABEL_PRINT_STATUS.partial
        : confirmedCount > 0
          ? LOGEN_LABEL_PRINT_STATUS.partial
          : LOGEN_LABEL_PRINT_STATUS.failed;
      const claimed = await tx.carrier_invoice_issue_batches.updateMany({
        where: {
          carrier_invoice_issue_batch_id: issueBatchId,
          label_print_attempt_count: printAttemptCount,
          label_print_status: LOGEN_LABEL_PRINT_STATUS.unknown,
          label_active_request_key: batch.label_active_request_key,
        },
        data: {
          label_print_status: nextStatus,
          label_active_request_key: null,
          label_confirmed_at:
            nextStatus === LOGEN_LABEL_PRINT_STATUS.confirmed ? now : null,
          ...(printed ? { label_last_spooled_at: now } : {}),
          label_last_error_code: printed
            ? null
            : "OPERATOR_CONFIRMED_NOT_PRINTED",
          label_last_error_message: printed
            ? null
            : `${targetItems.length} label(s) were returned to the recovery queue.`,
          updated_at: now,
        },
      });
      if (claimed.count !== 1) throw labelPrintRequestStale();
      for (const item of targetItems) {
        const updated = await tx.carrier_invoice_issue_items.updateMany({
          where: {
            carrier_invoice_issue_item_id:
              item.carrier_invoice_issue_item_id,
            carrier_invoice_issue_batch_id: issueBatchId,
            label_print_attempt_no: printAttemptCount,
            label_print_status: LOGEN_LABEL_PRINT_STATUS.unknown,
          },
          data: {
            label_print_status: printed
              ? LOGEN_LABEL_PRINT_STATUS.confirmed
              : LOGEN_LABEL_PRINT_STATUS.failed,
            ...(printed
              ? {
                  label_print_count: { increment: 1 },
                  label_last_spooled_at: now,
                }
              : {}),
            label_confirmed_at: printed ? now : null,
            label_last_error_code: printed
              ? null
              : "OPERATOR_CONFIRMED_NOT_PRINTED",
            label_last_error_message: printed
              ? null
              : "A manager confirmed that the unknown spool job did not print.",
            updated_at: now,
          },
        });
        if (updated.count !== 1) throw labelPrintItemStateConflict();
      }
      await tx.employee_activity_logs.create({
        data: {
          user_id: input.userId ?? null,
          action_type: printed
            ? "LOGEN_LABEL_PRINT_UNKNOWN_RESOLVED_PRINTED"
            : "LOGEN_LABEL_PRINT_UNKNOWN_RESOLVED_NOT_PRINTED",
          target_type: "CARRIER_INVOICE_ISSUE_BATCH",
          target_id: String(issueBatchId),
          result: printed ? "CONFIRMED" : "FAILED",
          ...activityLogChangeData(null, {
            printed,
            printAttemptCount,
            requestKey: batch.label_active_request_key,
            issueItemIds: targetItems.map(
              (item) => item.carrier_invoice_issue_item_id
            ),
          }),
        },
      });
    }
  );
  await projectReplacementFromIssueBatch({
    issueBatchId,
    projectedAt: now,
    actorUserId: input.userId,
  });
  return getLogenLabelPrintView({ issueBatchId });
}
