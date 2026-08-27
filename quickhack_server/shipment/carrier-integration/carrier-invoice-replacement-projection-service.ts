import type { Prisma } from "@/generated/prisma/client";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { prisma } from "@/quickhack_server/core/prisma";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import { transitionReplacement } from "@/quickhack_server/shipment/carrier-integration/carrier-invoice-replacement-execution-ownership";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import {
  databaseDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import {
  CARRIER_INVOICE_REPLACEMENT_STAGE,
  CARRIER_INVOICE_REPLACEMENT_STATUS,
  TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES,
} from "@/quickhack_shared/shipment/invoice-replacement";
import { LOGEN_LABEL_PRINT_STATUS } from "@/quickhack_shared/shipment/logen-label";

const TERMINAL_STATUSES = new Set<string>(
  TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES
);
const STAGE_ORDER = new Map<string, number>([
  [CARRIER_INVOICE_REPLACEMENT_STAGE.precheck, 0],
  [CARRIER_INVOICE_REPLACEMENT_STAGE.oldInvoiceHandling, 1],
  [CARRIER_INVOICE_REPLACEMENT_STAGE.allocation, 2],
  [CARRIER_INVOICE_REPLACEMENT_STAGE.channelUpdate, 3],
  [CARRIER_INVOICE_REPLACEMENT_STAGE.carrierRegistration, 4],
  [CARRIER_INVOICE_REPLACEMENT_STAGE.labelPrint, 5],
  [CARRIER_INVOICE_REPLACEMENT_STAGE.finalize, 6],
]);

const projectionInclude = {
  package_group: {
    select: {
      group_status: true,
      current_carrier_shipment_id: true,
    },
  },
  candidate_carrier_shipment: {
    include: { registration_work: true },
  },
  carrier_invoice_issue_batch: {
    include: {
      items: {
        orderBy: { issue_sequence: "asc" as const },
        include: { registration_work: true },
      },
    },
  },
} satisfies Prisma.carrier_invoice_replacement_worksInclude;

type ProjectionClient = Pick<
  Prisma.TransactionClient,
  | "carrier_invoice_replacement_works"
  | "shipment_package_groups"
  | "shipment_address_change_work"
  | "employee_activity_logs"
  | "desktop_notification_events"
>;

type Projection = {
  workStatus: string;
  stage: string;
  errorCode: string | null;
  errorMessage: string | null;
  carrierRegisteredAt?: Date | null;
  labelConfirmedAt?: Date | null;
  complete: boolean;
};

function sameTimestamp(left: Date | null, right: Date | null) {
  return left === null || right === null
    ? left === right
    : left.getTime() === right.getTime();
}

function desiredProjection(
  work: Prisma.carrier_invoice_replacement_worksGetPayload<{
    include: typeof projectionInclude;
  }>
): Projection | null {
  const registration =
    work.candidate_carrier_shipment?.registration_work ??
    work.carrier_invoice_issue_batch?.items[0]?.registration_work ??
    null;
  const labelStatus = work.carrier_invoice_issue_batch?.label_print_status;

  if (
    work.channel_updated_at &&
    registration?.work_status === "REGISTERED" &&
    labelStatus === LOGEN_LABEL_PRINT_STATUS.confirmed
  ) {
    return {
      workStatus: CARRIER_INVOICE_REPLACEMENT_STATUS.completed,
      stage: CARRIER_INVOICE_REPLACEMENT_STAGE.finalize,
      errorCode: null,
      errorMessage: null,
      carrierRegisteredAt: registration.registered_at,
      labelConfirmedAt:
        work.carrier_invoice_issue_batch?.label_confirmed_at ?? null,
      complete: true,
    };
  }
  if (labelStatus === LOGEN_LABEL_PRINT_STATUS.unknown) {
    return {
      workStatus: CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
      stage: CARRIER_INVOICE_REPLACEMENT_STAGE.labelPrint,
      errorCode: "LABEL_PRINT_RESULT_UNKNOWN",
      errorMessage:
        "The physical replacement-label print result requires operator review.",
      complete: false,
    };
  }
  if (
    registration &&
    ["BLOCKED", "REVIEW_REQUIRED"].includes(registration.work_status)
  ) {
    return {
      workStatus: CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
      stage: CARRIER_INVOICE_REPLACEMENT_STAGE.carrierRegistration,
      errorCode:
        registration.last_error_code ??
        "LOGEN_REGISTRATION_REVIEW_REQUIRED",
      errorMessage: registration.last_error_message,
      carrierRegisteredAt: registration.registered_at,
      complete: false,
    };
  }
  if (registration?.work_status === "REGISTERED") {
    return {
      workStatus: CARRIER_INVOICE_REPLACEMENT_STATUS.waitingLabel,
      stage: CARRIER_INVOICE_REPLACEMENT_STAGE.labelPrint,
      errorCode: (
        labelStatus === LOGEN_LABEL_PRINT_STATUS.failed ||
        labelStatus === LOGEN_LABEL_PRINT_STATUS.partial
          ? work.carrier_invoice_issue_batch?.label_last_error_code
          : null) ?? null,
      errorMessage: (
        labelStatus === LOGEN_LABEL_PRINT_STATUS.failed ||
        labelStatus === LOGEN_LABEL_PRINT_STATUS.partial
          ? work.carrier_invoice_issue_batch?.label_last_error_message
          : null) ?? null,
      carrierRegisteredAt: registration.registered_at,
      complete: false,
    };
  }
  return null;
}

async function projectOnce(
  tx: ProjectionClient,
  input: {
    issueBatchId: number;
    projectedAt: Date;
    actorUserId?: number | null;
  }
) {
  const work = await tx.carrier_invoice_replacement_works.findUnique({
    where: { carrier_invoice_issue_batch_id: input.issueBatchId },
    include: projectionInclude,
  });
  if (
    !work ||
    TERMINAL_STATUSES.has(work.work_status) ||
    work.execution_token
  ) {
    return { changed: false, retry: false };
  }
  if (!work.channel_updated_at) {
    return { changed: false, retry: false };
  }
  const desired = desiredProjection(work);
  if (!desired) return { changed: false, retry: false };
  if (
    (STAGE_ORDER.get(desired.stage) ?? -1) <
    (STAGE_ORDER.get(work.current_stage) ?? -1)
  ) {
    return { changed: false, retry: false };
  }

  let projection = desired;
  if (
    desired.complete &&
    (work.package_group.group_status !== "ON_HOLD" ||
      work.package_group.current_carrier_shipment_id !==
        work.candidate_carrier_shipment_id)
  ) {
    projection = {
      workStatus: CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired,
      stage: CARRIER_INVOICE_REPLACEMENT_STAGE.finalize,
      errorCode: "REPLACEMENT_FINALIZE_CONFLICT",
      errorMessage:
        "The package group changed before the invoice replacement could be finalized.",
      complete: false,
    };
  }

  const sameProjection =
    work.work_status === projection.workStatus &&
    work.current_stage === projection.stage &&
    work.last_error_code === projection.errorCode &&
    work.last_error_message === projection.errorMessage &&
    (!projection.carrierRegisteredAt ||
      sameTimestamp(
        work.carrier_registered_at,
        projection.carrierRegisteredAt
      )) &&
    (!projection.labelConfirmedAt ||
      sameTimestamp(work.label_confirmed_at, projection.labelConfirmedAt));
  if (sameProjection) return { changed: false, retry: false };

  const changed = await transitionReplacement({
    client: tx,
    workId: work.carrier_invoice_replacement_work_id,
    workflowVersion: work.workflow_version,
    data: {
      work_status: projection.workStatus,
      current_stage: projection.stage,
      carrier_registered_at:
        projection.carrierRegisteredAt ?? work.carrier_registered_at,
      label_confirmed_at:
        projection.labelConfirmedAt ?? work.label_confirmed_at,
      completed_at: projection.complete ? input.projectedAt : null,
      review_required_at:
        projection.workStatus ===
        CARRIER_INVOICE_REPLACEMENT_STATUS.reviewRequired
          ? input.projectedAt
          : null,
      last_error_code: projection.errorCode,
      last_error_message: projection.errorMessage,
      execution_token: null,
      execution_started_at: null,
      updated_at: input.projectedAt,
    },
  });
  if (!changed) return { changed: false, retry: true };

  if (projection.complete) {
    const released = await tx.shipment_package_groups.updateMany({
      where: {
        package_group_id: work.package_group_id,
        group_status: "ON_HOLD",
        current_carrier_shipment_id: work.candidate_carrier_shipment_id,
      },
      data: { group_status: "READY", updated_at: input.projectedAt },
    });
    if (released.count !== 1) {
      throw new Error(
        "The package group changed during carrier invoice replacement finalization."
      );
    }
    if (work.shipment_address_change_work_id) {
      await tx.shipment_address_change_work.updateMany({
        where: {
          shipment_address_change_work_id:
            work.shipment_address_change_work_id,
          change_status: { not: "CONFIRMED" },
        },
        data: {
          change_status: "CONFIRMED",
          confirmed_at: input.projectedAt,
          processed_by_user_id:
            input.actorUserId ??
            work.resolved_by_user_id ??
            work.requested_by_user_id,
          updated_at: input.projectedAt,
        },
      });
      const { resolveDesktopNotificationBySource } = await import(
        "@/quickhack_server/notifications/desktop-notification-service"
      );
      await resolveDesktopNotificationBySource(tx, {
        sourceType: "SHIPMENT_ADDRESS_CHANGE_WORK",
        sourceId: String(work.shipment_address_change_work_id),
        resolvedAt: input.projectedAt,
      });
    }
    await tx.employee_activity_logs.create({
      data: {
        user_id:
          input.actorUserId ??
          work.resolved_by_user_id ??
          work.requested_by_user_id,
        action_type: "CARRIER_INVOICE_REPLACEMENT_COMPLETED",
        target_type: "CARRIER_INVOICE_REPLACEMENT_WORK",
        target_id: String(work.carrier_invoice_replacement_work_id),
        ...activityLogChangeData(
          { packageGroupStatus: "ON_HOLD" },
          {
            packageGroupStatus: "READY",
            candidateCarrierShipmentId:
              work.candidate_carrier_shipment_id,
          }
        ),
        result: "SUCCESS",
        created_at: input.projectedAt,
      },
    });
  }
  return { changed: true, retry: false };
}

export async function projectReplacementFromIssueBatch(input: {
  issueBatchId: number;
  projectedAt?: DateTimeInput;
  actorUserId?: number | null;
}) {
  const projectedAt = input.projectedAt
    ? databaseDateTime(input.projectedAt)
    : databaseNow();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runMeasuredTransaction(
      prisma,
      "carrier.invoice-replacement.project",
      (tx) =>
        projectOnce(tx, {
          ...input,
          projectedAt,
        })
    );
    if (!result.retry) return result;
  }
  return { changed: false, retry: false };
}

export async function projectReplacementFromRegistrationWork(input: {
  registrationWorkId: number;
  projectedAt?: DateTimeInput;
  actorUserId?: number | null;
}) {
  const work = await prisma.carrier_shipment_registration_works.findUnique({
    where: {
      carrier_shipment_registration_work_id: input.registrationWorkId,
    },
    select: {
      issue_item: {
        select: { carrier_invoice_issue_batch_id: true },
      },
    },
  });
  if (!work) return { changed: false, retry: false };
  return projectReplacementFromIssueBatch({
    issueBatchId: work.issue_item.carrier_invoice_issue_batch_id,
    projectedAt: input.projectedAt,
    actorUserId: input.actorUserId,
  });
}
