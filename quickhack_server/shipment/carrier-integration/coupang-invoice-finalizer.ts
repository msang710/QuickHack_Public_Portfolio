import type { Prisma } from "@/generated/prisma/client";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  advanceSalesChannelProjectionRevision,
  SALES_CHANNEL_PROJECTION_CHANNEL,
} from "@/quickhack_server/sales-channel/projection-revision-service";
import { enqueueLogenRegistrationWork } from "@/quickhack_server/shipment/carrier-integration/logen/shipment-registration-service";
import { confirmPackageGroupDeparture } from "@/quickhack_server/shipment/delivery-status-projection-service";
import { SALES_CHANNEL_WRITE_REQUEST_STATUS, SALES_CHANNEL_WRITE_REQUEST_TYPE } from "@/quickhack_shared/sales-channel/write-requests";

const INVOICE_ACTIVE_ORDER_STATUSES = new Set([
  "DEPARTURE",
  "DELIVERING",
  "FINAL_DELIVERY",
]);

export async function projectConfirmedCoupangInvoiceWrite(input: {
  tx: Prisma.TransactionClient;
  mode: "UPLOAD" | "UPDATE";
  targets: Array<{
    external_order_id: string | null;
    external_shipment_id: string | null;
    target_external_id: string | null;
    invoice_number_snapshot: string | null;
  }>;
  expectedPreviousInvoiceNumber?: string | null;
  finalizedAt: DateTimeInput;
}) {
  const finalizedAt = databaseDateTime(input.finalizedAt);
  const projections = Array.from(
    new Map(
      input.targets
        .map((target) => {
          const externalOrderId = String(
            target.external_order_id ?? ""
          ).trim();
          const externalShipmentId = String(
            target.external_shipment_id ?? target.target_external_id ?? ""
          ).trim();
          const invoiceNumber = String(
            target.invoice_number_snapshot ?? ""
          ).trim();

          return [
            `${externalOrderId}\u0000${externalShipmentId}`,
            { externalOrderId, externalShipmentId, invoiceNumber },
          ] as const;
        })
        .filter(
          ([, target]) =>
            target.externalOrderId &&
            target.externalShipmentId &&
            target.invoiceNumber
        )
    ).values()
  );

  if (projections.length === 0) {
    throw new Error(
      "The persisted Coupang invoice request has no exact invoice targets."
    );
  }

  const expectedPreviousInvoiceNumber = String(
    input.expectedPreviousInvoiceNumber ?? ""
  ).trim();

  if (input.mode === "UPDATE" && !expectedPreviousInvoiceNumber) {
    throw new Error(
      "The Coupang invoice update has no previous invoice snapshot."
    );
  }

  let projectionRevision: number | null = null;
  const getProjectionRevision = async () => {
    projectionRevision ??= await advanceSalesChannelProjectionRevision(
      input.tx,
      SALES_CHANNEL_PROJECTION_CHANNEL.coupang,
      finalizedAt
    );
    return projectionRevision;
  };

  for (const projection of projections) {
    const current = await input.tx.coupang_order_raw.findUnique({
      where: {
        external_order_id_external_shipment_id: {
          external_order_id: projection.externalOrderId,
          external_shipment_id: projection.externalShipmentId,
        },
      },
      select: {
        coupang_order_raw_id: true,
        external_order_status: true,
        invoice_number: true,
        invoice_uploaded_at: true,
        projection_revision: true,
        updated_at: true,
      },
    });

    if (!current) {
      throw new Error(
        `Coupang order ${projection.externalOrderId}/${projection.externalShipmentId} is missing from the local snapshot.`
      );
    }

    const currentStatus = String(current.external_order_status ?? "").trim();
    const currentInvoiceNumber = String(current.invoice_number ?? "").trim();
    const statusAllowed =
      INVOICE_ACTIVE_ORDER_STATUSES.has(currentStatus) ||
      (input.mode === "UPLOAD" && currentStatus === "INSTRUCT");
    const invoiceAllowed =
      currentInvoiceNumber === projection.invoiceNumber ||
      (input.mode === "UPLOAD" && !currentInvoiceNumber) ||
      (input.mode === "UPDATE" &&
        currentInvoiceNumber === expectedPreviousInvoiceNumber);

    if (!statusAllowed || !invoiceAllowed) {
      throw new Error(
        `Coupang invoice target ${projection.externalOrderId}/${projection.externalShipmentId} changed before local finalization.`
      );
    }

    const projectedStatus =
      input.mode === "UPLOAD" && currentStatus === "INSTRUCT"
        ? "DEPARTURE"
        : currentStatus;

    if (
      current.external_order_status === projectedStatus &&
      currentInvoiceNumber === projection.invoiceNumber &&
      current.invoice_uploaded_at
    ) {
      continue;
    }

    const updated = await input.tx.coupang_order_raw.updateMany({
      where: {
        coupang_order_raw_id: current.coupang_order_raw_id,
        external_order_status: current.external_order_status,
        invoice_number: current.invoice_number,
        invoice_uploaded_at: current.invoice_uploaded_at,
        projection_revision: current.projection_revision,
        updated_at: current.updated_at,
      },
      data: {
        external_order_status: projectedStatus,
        invoice_number: projection.invoiceNumber,
        invoice_uploaded_at:
          currentInvoiceNumber === projection.invoiceNumber
            ? current.invoice_uploaded_at ?? finalizedAt
            : finalizedAt,
        projection_revision: await getProjectionRevision(),
        updated_at: finalizedAt,
      },
    });

    if (updated.count !== 1) {
      throw new Error(
        `Coupang invoice target ${projection.externalOrderId}/${projection.externalShipmentId} changed during local finalization.`
      );
    }
  }
}

export async function finalizePersistedCoupangInvoiceUpload(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  targetIds: readonly number[];
  actorUserId?: number | null;
  finalizedAt: DateTimeInput;
}) {
  const finalizedAt = databaseDateTime(input.finalizedAt);
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
      SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload ||
    !request.package_group_id ||
    !request.carrier_shipment_id ||
    !request.carrier_shipment
  ) {
    throw new Error("쿠팡 송장 등록 내부 확정 대상을 찾지 못했습니다.");
  }
  if (
    input.targetIds.length === 0 ||
    request.targets.length !== input.targetIds.length
  ) {
    throw new Error(
      "쿠팡 송장 등록 성공 대상의 소유권 또는 외부 성공 상태가 일치하지 않습니다."
    );
  }

  const expectedInvoiceNumbers = new Set(
    request.targets
      .map((target) => String(target.invoice_number_snapshot ?? "").trim())
      .filter(Boolean)
  );
  if (
    expectedInvoiceNumbers.size !== 1 ||
    !expectedInvoiceNumbers.has(request.carrier_shipment.tracking_number)
  ) {
    throw new Error("쿠팡 송장 등록 스냅샷과 현재 택배 송장이 일치하지 않습니다.");
  }

  await projectConfirmedCoupangInvoiceWrite({
    tx: input.tx,
    mode: "UPLOAD",
    targets: request.targets,
    finalizedAt,
  });

  await input.tx.$queryRaw`
    SELECT package_group_id
    FROM shipment_package_groups
    WHERE package_group_id = ${request.package_group_id}
    FOR UPDATE
  `;
  const group = await input.tx.shipment_package_groups.findUnique({
    where: { package_group_id: request.package_group_id },
    include: {
      members: {
        where: { removed_at: null },
        select: { external_shipment_id: true },
      },
    },
  });
  if (
    !group ||
    group.current_carrier_shipment_id !== request.carrier_shipment_id
  ) {
    throw new Error("합포장 그룹의 현재 송장이 변경되었습니다.");
  }

  const expectedShipmentIds = new Set(
    group.members.map((member) => member.external_shipment_id)
  );
  const siblingRequests = await input.tx.sales_channel_write_requests.findMany({
    where: {
      channel: "COUPANG",
      request_type: SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload,
      package_group_id: request.package_group_id,
      carrier_shipment_id: request.carrier_shipment_id,
    },
    include: { targets: true },
  });
  const confirmedShipmentIds = new Set<string>();

  for (const sibling of siblingRequests) {
    const isConfirmed =
      sibling.sales_channel_write_request_id === input.requestId ||
      sibling.request_status === SALES_CHANNEL_WRITE_REQUEST_STATUS.completed;
    if (!isConfirmed) continue;

    for (const target of sibling.targets) {
      const shipmentId = String(target.external_shipment_id ?? "").trim();
      if (shipmentId) confirmedShipmentIds.add(shipmentId);
    }
  }

  const allConfirmed = [...expectedShipmentIds].every((shipmentId) =>
    confirmedShipmentIds.has(shipmentId)
  );
  if (!allConfirmed || group.group_status !== "FROZEN") {
    return { groupReady: group.group_status === "READY", allConfirmed };
  }

  const updated = await input.tx.shipment_package_groups.updateMany({
    where: {
      package_group_id: group.package_group_id,
      group_status: "FROZEN",
      current_carrier_shipment_id: request.carrier_shipment_id,
    },
    data: {
      group_status: "READY",
      revision: { increment: 1 },
      updated_at: finalizedAt,
    },
  });

  if (updated.count === 1) {
    await confirmPackageGroupDeparture(input.tx, {
      packageGroupId: group.package_group_id,
      carrierShipmentId: request.carrier_shipment_id,
      occurredAt: finalizedAt,
      actorUserId: input.actorUserId,
    });

    await enqueueLogenRegistrationWork(input.tx, {
      carrierShipmentId: request.carrier_shipment_id,
      packageGroupId: group.package_group_id,
      createdAt: finalizedAt,
    });

    await input.tx.employee_activity_logs.create({
      data: {
        user_id: input.actorUserId ?? null,
        action_type: "COUPANG_INVOICE_UPLOAD_CONFIRMED",
        target_type: "SHIPMENT_PACKAGE_GROUP",
        target_id: String(group.package_group_id),
        ...activityLogChangeData(
          { groupStatus: "FROZEN" },
          {
            groupStatus: "READY",
            carrierShipmentId: request.carrier_shipment_id,
            trackingNumber: request.carrier_shipment.tracking_number,
            shipmentCount: expectedShipmentIds.size,
          }
        ),
        result: "SUCCESS",
        created_at: finalizedAt,
      },
    });
  }

  return { groupReady: updated.count === 1, allConfirmed: true };
}
