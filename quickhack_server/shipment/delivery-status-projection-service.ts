import type { Prisma } from "@/generated/prisma/client";
import {
  databaseDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  observeCarrierReconciliationRevision,
  openCarrierReconciliationWork,
  resolveCarrierReconciliationWork,
} from "@/quickhack_server/shipment/carrier-integration/persistence-service";
import {
  INVENTORY_QUANTITY_MOVEMENT_TYPE,
  transitionInventoryStatusWithLedger,
} from "@/quickhack_server/inventory/inventory-quantity-ledger-service";
import { projectDeliveredSalesRecords } from "@/quickhack_server/sales/sales-record-service";
import { recordPersonalDataDeliveryCompletion } from "@/quickhack_server/security/personal-data-lifecycle-service";
import { INVENTORY_STATUS } from "@/quickhack_shared/inventory/inventory-status";
import { INVENTORY_TRANSITION_POLICY } from "@/quickhack_shared/inventory/inventory-write-rules";
import {
  CARRIER_SHIPMENT_STATUS,
  type CarrierShipmentStatus,
} from "@/quickhack_shared/shipment/carrier-tracking-status";

type TransactionClient = Prisma.TransactionClient;
type DeliveryEvidenceSource = "LOGEN" | "COUPANG";

const PROJECTABLE_CARRIER_STATUSES = new Set<CarrierShipmentStatus>([
  CARRIER_SHIPMENT_STATUS.inTransit,
  CARRIER_SHIPMENT_STATUS.delivered,
  CARRIER_SHIPMENT_STATUS.exception,
]);

export class DeliveryStatusProjectionConflictError extends Error {
  readonly code = "DELIVERY_STATUS_PROJECTION_CONFLICT";
  readonly reasonCode: string;
  readonly packageGroupId: number;
  readonly pgNo: string | null;
  readonly inventoryStatus: string | null;

  constructor(input: {
    packageGroupId: number;
    reasonCode: string;
    pgNo?: string | null;
    inventoryStatus?: string | null;
  }) {
    super(input.reasonCode);
    this.name = "DeliveryStatusProjectionConflictError";
    this.packageGroupId = input.packageGroupId;
    this.reasonCode = input.reasonCode;
    this.pgNo = input.pgNo ?? null;
    this.inventoryStatus = input.inventoryStatus ?? null;
  }
}

function uniquePgNos(
  members: Array<{ allocation: { pg_no: string } }>
) {
  return Array.from(
    new Set(
      members
        .map((member) => String(member.allocation.pg_no ?? "").trim())
        .filter(Boolean)
    )
  );
}

async function loadCurrentPackageGroup(
  tx: TransactionClient,
  input: {
    packageGroupId: number;
    carrierShipmentId?: number | null;
  }
) {
  await tx.$queryRaw`
    SELECT package_group_id
    FROM shipment_package_groups
    WHERE package_group_id = ${input.packageGroupId}
    FOR UPDATE
  `;
  const group = await tx.shipment_package_groups.findUnique({
    where: { package_group_id: input.packageGroupId },
    include: {
      members: {
        where: { removed_at: null },
        orderBy: { member_sequence: "asc" },
        include: {
          allocation: {
            select: {
              allocation_id: true,
              pg_no: true,
              sales_offer_id: true,
              inventory_sku_id: true,
              external_order_id: true,
              external_shipment_id: true,
              external_vendor_item_id: true,
              required_warranty_group: true,
              device: {
                select: {
                  model: true,
                  storage: true,
                  color: true,
                  sale_grade: true,
                  warranty: true,
                  inbounds: {
                    orderBy: { inbound_id: "desc" },
                    take: 1,
                    select: {
                      inbound_id: true,
                      purchase_price: true,
                      supplier_name: true,
                      price_agreed_at: true,
                    },
                  },
                },
              },
              coupang_return_allocations: {
                where: { action_type: "approve" },
                take: 1,
                select: {
                  coupang_return_allocation_id: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!group) {
    throw new DeliveryStatusProjectionConflictError({
      packageGroupId: input.packageGroupId,
      reasonCode: "PACKAGE_GROUP_NOT_FOUND",
    });
  }
  if (
    input.carrierShipmentId != null &&
    group.current_carrier_shipment_id !== input.carrierShipmentId
  ) {
    throw new DeliveryStatusProjectionConflictError({
      packageGroupId: input.packageGroupId,
      reasonCode: "CURRENT_CARRIER_SHIPMENT_CHANGED",
    });
  }

  const pgNos = uniquePgNos(group.members);
  if (pgNos.length === 0) {
    throw new DeliveryStatusProjectionConflictError({
      packageGroupId: input.packageGroupId,
      reasonCode: "PACKAGE_GROUP_HAS_NO_ACTIVE_MEMBERS",
    });
  }

  const approvedReturnPgNos = new Set(
    group.members
      .filter(
        (member) => member.allocation.coupang_return_allocations.length > 0
      )
      .map((member) => member.allocation.pg_no)
  );
  const deliveryInventoryPgNos = pgNos.filter(
    (pgNo) => !approvedReturnPgNos.has(pgNo)
  );

  return { group, pgNos, approvedReturnPgNos, deliveryInventoryPgNos };
}

export async function confirmPackageGroupDeparture(
  tx: TransactionClient,
  input: {
    packageGroupId: number;
    carrierShipmentId: number;
    occurredAt?: DateTimeInput;
    actorUserId?: number | null;
    workerJobId?: number | null;
  }
) {
  const occurredAt = databaseDateTime(input.occurredAt ?? databaseNow());
  const { group, pgNos, deliveryInventoryPgNos } =
    await loadCurrentPackageGroup(tx, input);

  if (group.group_status !== "READY") {
    throw new DeliveryStatusProjectionConflictError({
      packageGroupId: input.packageGroupId,
      reasonCode: "PACKAGE_GROUP_NOT_READY",
    });
  }

  const inventoryRows = await tx.inventory.findMany({
    where: { pg_no: { in: deliveryInventoryPgNos } },
    select: { pg_no: true, inventory_status: true },
  });
  const inventoryByPg = new Map(
    inventoryRows.map((row) => [row.pg_no, row.inventory_status])
  );
  let transitionedCount = 0;

  for (const pgNo of deliveryInventoryPgNos) {
    const status = inventoryByPg.get(pgNo) ?? null;
    if (!status) {
      throw new DeliveryStatusProjectionConflictError({
        packageGroupId: input.packageGroupId,
        pgNo,
        inventoryStatus: status,
        reasonCode: "INVENTORY_STATUS_NOT_FOUND",
      });
    }
    if (
      status === INVENTORY_STATUS.departure ||
      status === INVENTORY_STATUS.delivering ||
      status === INVENTORY_STATUS.finalDelivery ||
      status === INVENTORY_STATUS.noneTracking
    ) {
      continue;
    }
    if (status !== INVENTORY_STATUS.packed) {
      throw new DeliveryStatusProjectionConflictError({
        packageGroupId: input.packageGroupId,
        pgNo,
        inventoryStatus: status,
        reasonCode: "INVENTORY_NOT_PACKED",
      });
    }

    const result = await transitionInventoryStatusWithLedger(tx, {
      pgNo,
      expectedFromStatus: INVENTORY_STATUS.packed,
      toStatus: INVENTORY_STATUS.departure,
      transitionPolicy:
        INVENTORY_TRANSITION_POLICY.standardShipmentInvoiceConfirmed,
      operationKey: `shipment-package-group:${input.packageGroupId}:departure:pg:${pgNo}`,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: "COUPANG_INVOICE_CONFIRMED",
      sourceId: String(input.carrierShipmentId),
      reason: "쿠팡 송장 등록 확인",
      actorUserId: input.actorUserId ?? null,
      workerJobId: input.workerJobId ?? null,
      occurredAt,
    });
    if (result.applied) transitionedCount += 1;
  }

  return {
    packageGroupId: input.packageGroupId,
    transitionedCount,
    pgNos,
    skippedApprovedReturnCount: pgNos.length - deliveryInventoryPgNos.length,
  };
}

function projectedInventoryStatus(status: CarrierShipmentStatus) {
  if (status === CARRIER_SHIPMENT_STATUS.inTransit) {
    return INVENTORY_STATUS.delivering;
  }
  if (status === CARRIER_SHIPMENT_STATUS.delivered) {
    return INVENTORY_STATUS.finalDelivery;
  }
  if (status === CARRIER_SHIPMENT_STATUS.exception) {
    return INVENTORY_STATUS.noneTracking;
  }
  return null;
}

export async function projectPackageGroupDeliveryStatus(
  tx: TransactionClient,
  input: {
    packageGroupId: number;
    carrierShipmentId: number;
    carrierStatus: CarrierShipmentStatus;
    evidenceSource: DeliveryEvidenceSource;
    evidenceKey: string;
    rawStatusName?: string | null;
    occurredAt?: DateTimeInput;
    workerJobId?: number | null;
  }
) {
  if (!PROJECTABLE_CARRIER_STATUSES.has(input.carrierStatus)) {
    return {
      packageGroupId: input.packageGroupId,
      transitionedCount: 0,
      skippedCount: 0,
      completed: false,
    };
  }

  const occurredAt = databaseDateTime(input.occurredAt ?? databaseNow());
  let loaded = await loadCurrentPackageGroup(tx, input);
  const existingRows = await tx.inventory.findMany({
    where: { pg_no: { in: loaded.deliveryInventoryPgNos } },
    select: { pg_no: true, inventory_status: true },
  });

  if (
    existingRows.some(
      (row) => row.inventory_status === INVENTORY_STATUS.packed
    )
  ) {
    await confirmPackageGroupDeparture(tx, {
      packageGroupId: input.packageGroupId,
      carrierShipmentId: input.carrierShipmentId,
      occurredAt,
      workerJobId: input.workerJobId,
    });
    loaded = await loadCurrentPackageGroup(tx, input);
  }

  const inventoryRows = await tx.inventory.findMany({
    where: { pg_no: { in: loaded.deliveryInventoryPgNos } },
    select: { pg_no: true, inventory_status: true },
  });
  const inventoryByPg = new Map(
    inventoryRows.map((row) => [row.pg_no, row.inventory_status])
  );
  const toStatus = projectedInventoryStatus(input.carrierStatus);
  if (!toStatus) {
    return {
      packageGroupId: input.packageGroupId,
      transitionedCount: 0,
      skippedCount: loaded.pgNos.length,
      completed: false,
    };
  }

  let transitionedCount = 0;
  let skippedCount = loaded.approvedReturnPgNos.size;

  for (const pgNo of loaded.deliveryInventoryPgNos) {
    const fromStatus = inventoryByPg.get(pgNo) ?? null;
    if (!fromStatus) {
      throw new DeliveryStatusProjectionConflictError({
        packageGroupId: input.packageGroupId,
        pgNo,
        inventoryStatus: fromStatus,
        reasonCode: "INVENTORY_STATUS_NOT_FOUND",
      });
    }
    if (
      fromStatus === INVENTORY_STATUS.finalDelivery ||
      fromStatus === toStatus ||
      (input.evidenceSource === "COUPANG" &&
        input.carrierStatus === CARRIER_SHIPMENT_STATUS.inTransit &&
        fromStatus === INVENTORY_STATUS.noneTracking)
    ) {
      skippedCount += 1;
      continue;
    }

    const result = await transitionInventoryStatusWithLedger(tx, {
      pgNo,
      expectedFromStatus: fromStatus,
      toStatus,
      transitionPolicy: INVENTORY_TRANSITION_POLICY.deliveryStatusSync,
      operationKey: `delivery-status:${input.evidenceSource}:${input.evidenceKey}:pg:${pgNo}`,
      movementType: INVENTORY_QUANTITY_MOVEMENT_TYPE.statusTransfer,
      sourceType: `${input.evidenceSource}_DELIVERY_STATUS`,
      sourceId: String(input.carrierShipmentId),
      reason:
        input.rawStatusName ||
        `${input.evidenceSource} ${input.carrierStatus}`,
      workerJobId: input.workerJobId ?? null,
      occurredAt,
    });
    if (result.applied) transitionedCount += 1;
    else skippedCount += 1;
  }

  const completed =
    input.carrierStatus === CARRIER_SHIPMENT_STATUS.delivered;
  if (completed) {
    await projectDeliveredSalesRecords(tx, {
      channel: loaded.group.channel,
      soldAt: occurredAt,
      allocations: loaded.group.members.map(({ allocation }) => ({
        allocationId: allocation.allocation_id,
        pgNo: allocation.pg_no,
        salesOfferId: allocation.sales_offer_id,
        inventorySkuId: allocation.inventory_sku_id,
        externalOrderId: allocation.external_order_id,
        externalShipmentId: allocation.external_shipment_id,
        externalVendorItemId: allocation.external_vendor_item_id,
        latestPurchasePrice:
          allocation.device.inbounds[0]?.purchase_price ?? null,
        purchaseInboundId:
          allocation.device.inbounds[0]?.inbound_id ?? null,
        supplierName:
          allocation.device.inbounds[0]?.supplier_name ?? null,
        purchaseAgreedAt:
          allocation.device.inbounds[0]?.price_agreed_at ?? null,
        model: allocation.device.model,
        storage: allocation.device.storage,
        color: allocation.device.color,
        saleGrade: allocation.device.sale_grade,
        warrantyGroup:
          allocation.required_warranty_group ?? allocation.device.warranty,
        hasApprovedReturn:
          allocation.coupang_return_allocations.length > 0,
      })),
    });
    const lifecycleSubjects = new Map<
      string,
      { externalOrderId: string; externalShipmentId: string }
    >();
    for (const { allocation } of loaded.group.members) {
      const externalOrderId = String(allocation.external_order_id ?? "").trim();
      const externalShipmentId = String(
        allocation.external_shipment_id ?? ""
      ).trim();
      if (!externalOrderId || !externalShipmentId) continue;
      lifecycleSubjects.set(`${externalOrderId}\u0000${externalShipmentId}`, {
        externalOrderId,
        externalShipmentId,
      });
    }
    for (const subject of lifecycleSubjects.values()) {
      await recordPersonalDataDeliveryCompletion(tx, {
        channel: loaded.group.channel,
        externalOrderId: subject.externalOrderId,
        externalShipmentId: subject.externalShipmentId,
        completedAt: occurredAt,
        now: occurredAt,
      });
    }
    await tx.shipment_package_groups.updateMany({
      where: {
        package_group_id: input.packageGroupId,
        current_carrier_shipment_id: input.carrierShipmentId,
        group_status: { in: ["READY", "ON_HOLD"] },
      },
      data: {
        group_status: "COMPLETED",
        updated_at: occurredAt,
      },
    });
  }

  return {
    packageGroupId: input.packageGroupId,
    transitionedCount,
    skippedCount,
    completed,
  };
}

function coupangCarrierStatus(value: string | null) {
  if (value === "DELIVERING") {
    return CARRIER_SHIPMENT_STATUS.inTransit;
  }
  if (value === "FINAL_DELIVERY") {
    return CARRIER_SHIPMENT_STATUS.delivered;
  }
  return null;
}

export async function projectCoupangDeliveryStatuses(input: {
  orders: Array<{
    externalShipmentId: string;
    channelStatus: string | null;
    syncedAt: DateTimeInput;
  }>;
  workerJobId?: number | null;
}) {
  const evidenceByShipmentId = new Map(
    input.orders
      .map((order) => ({
        ...order,
        carrierStatus: coupangCarrierStatus(order.channelStatus),
      }))
      .filter((order) => order.carrierStatus)
      .map((order) => [order.externalShipmentId, order])
  );
  if (evidenceByShipmentId.size === 0) {
    return {
      projectedGroupCount: 0,
      transitionedCount: 0,
      failedGroupCount: 0,
    };
  }

  const members = await prisma.shipment_package_group_members.findMany({
    where: {
      removed_at: null,
      external_shipment_id: {
        in: Array.from(evidenceByShipmentId.keys()),
      },
      package_group: {
        is: {
          current_carrier_shipment_id: { not: null },
        },
      },
    },
    select: {
      package_group_id: true,
      external_shipment_id: true,
      package_group: {
        select: {
          current_carrier_shipment_id: true,
        },
      },
    },
  });
  const projectionByGroup = new Map<
    number,
    {
      carrierShipmentId: number;
      carrierStatus: CarrierShipmentStatus;
      externalShipmentIds: string[];
      syncedAt: Date;
    }
  >();

  for (const member of members) {
    const evidence = evidenceByShipmentId.get(member.external_shipment_id);
    const carrierShipmentId =
      member.package_group.current_carrier_shipment_id;
    if (!evidence?.carrierStatus || !carrierShipmentId) continue;
    const existing = projectionByGroup.get(member.package_group_id);
    const shouldReplace =
      !existing ||
      evidence.carrierStatus === CARRIER_SHIPMENT_STATUS.delivered;

    if (shouldReplace) {
      projectionByGroup.set(member.package_group_id, {
        carrierShipmentId,
        carrierStatus: evidence.carrierStatus,
        externalShipmentIds: [member.external_shipment_id],
        syncedAt: databaseDateTime(evidence.syncedAt),
      });
    } else if (
      !existing.externalShipmentIds.includes(member.external_shipment_id)
    ) {
      existing.externalShipmentIds.push(member.external_shipment_id);
    }
  }

  let transitionedCount = 0;
  let failedGroupCount = 0;
  for (const [packageGroupId, projection] of projectionByGroup) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const expectedRevision = await observeCarrierReconciliationRevision({
          carrierCode: "COUPANG",
          operationType: "DELIVERY_STATUS_PROJECTION",
          lookupKeyType: "PACKAGE_GROUP_ID",
          lookupKeyValue: String(packageGroupId),
          client: tx,
        });
        const projected = await projectPackageGroupDeliveryStatus(tx, {
          packageGroupId,
          carrierShipmentId: projection.carrierShipmentId,
          carrierStatus: projection.carrierStatus,
          evidenceSource: "COUPANG",
          evidenceKey: `${projection.externalShipmentIds
            .sort()
            .join(",")}:${projection.carrierStatus}:${projection.syncedAt.toISOString()}`,
          rawStatusName: projection.carrierStatus,
          occurredAt: projection.syncedAt,
          workerJobId: input.workerJobId,
        });
        await resolveCarrierReconciliationWork({
          carrierCode: "COUPANG",
          operationType: "DELIVERY_STATUS_PROJECTION",
          lookupKeyType: "PACKAGE_GROUP_ID",
          lookupKeyValue: String(packageGroupId),
          expectedRevision,
          client: tx,
        });
        return projected;
      });
      transitionedCount += result.transitionedCount;
    } catch (error) {
      failedGroupCount += 1;
      await openCarrierReconciliationWork({
        carrierCode: "COUPANG",
        operationType: "DELIVERY_STATUS_PROJECTION",
        lookupKeyType: "PACKAGE_GROUP_ID",
        lookupKeyValue: String(packageGroupId),
        reason: "쿠팡 배송상태를 합포장 재고에 반영하지 못했습니다.",
        lastErrorMessage:
          error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    projectedGroupCount: projectionByGroup.size,
    transitionedCount,
    failedGroupCount,
  };
}
