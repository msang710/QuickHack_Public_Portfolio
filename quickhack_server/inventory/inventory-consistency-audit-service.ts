// QuickHack object: Reports inventory, inbound, inspection, and order-match inconsistencies without modifying data.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import { loadInboundInspectionEvidence } from "@/quickhack_server/inbound/inbound-inspection-evidence-loader";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import {
  INVENTORY_STATUS,
  SELLABLE_INVENTORY_STATUSES,
} from "@/quickhack_shared/inventory/inventory-status";
import { inferInspectionStatus } from "@/quickhack_shared/inspection/inspection-status";
import { nowKstSqlDateTime } from "@/quickhack_shared/core/time";
import {
  assertWorkerLeaseActive,
  throwIfWorkerLeaseAborted,
} from "@/quickhack_server/workers/lease-guard";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";

type AuditSeverity = "CRITICAL" | "WARNING" | "INFO";
type AuditIssue = {
  code: string;
  severity: AuditSeverity;
  count: number;
  samplePgNos: string[];
  message: string;
};

const SAMPLE_LIMIT = 10;
const AUDIT_DEVICE_BATCH_SIZE = 200;
const inboundStatusValues = new Set<string>(Object.values(INBOUND_STATUS));
const inventoryStatusValues = new Set<string>(Object.values(INVENTORY_STATUS));
const shipmentRequiredInventoryStatuses = new Set<string>([
  INVENTORY_STATUS.packing,
  INVENTORY_STATUS.packed,
  INVENTORY_STATUS.departure,
  INVENTORY_STATUS.delivering,
  INVENTORY_STATUS.finalDelivery,
  INVENTORY_STATUS.noneTracking,
]);
const auditDeviceSelect = {
  pg_no: true,
  model: true,
  storage: true,
  color: true,
  sale_grade: true,
  warranty: true,
  model_seq: true,
  inbounds: {
    orderBy: { inbound_id: "desc" },
    take: 1,
    select: {
      inbound_id: true,
      inbound_status: true,
      purchase_price: true,
    },
  },
  inventory: {
    select: {
      inventory_status: true,
    },
  },
  match_worker_allocations: {
    where: {
      allocation_status: {
        in: [
          "ALLOCATED",
          "API_ACKED",
          "SHIPMENT_LIST_PRINTED",
        ],
      },
    },
    take: 1,
    select: {
      allocation_id: true,
    },
  },
} satisfies Prisma.devicesSelect;

type AuditDeviceRow = Prisma.devicesGetPayload<{
  select: typeof auditDeviceSelect;
}>;

async function loadAuditDeviceRows(
  client: Prisma.TransactionClient,
  workerLease?: WorkerLeaseGuard
) {
  await assertWorkerLeaseActive(workerLease);
  const orderedDevices = await client.devices.findMany({
    orderBy: [{ device_id: "asc" }],
    select: { device_id: true },
  });
  const rows: AuditDeviceRow[] = [];

  for (
    let index = 0;
    index < orderedDevices.length;
    index += AUDIT_DEVICE_BATCH_SIZE
  ) {
    await assertWorkerLeaseActive(workerLease);
    const batchIds = orderedDevices
      .slice(index, index + AUDIT_DEVICE_BATCH_SIZE)
      .map((device) => device.device_id);
    const batchRows = await client.devices.findMany({
      where: { device_id: { in: batchIds } },
      orderBy: [{ device_id: "asc" }],
      select: auditDeviceSelect,
    });

    rows.push(...batchRows);
    throwIfWorkerLeaseAborted(workerLease);
  }

  return rows;
}

function samplePgNos(rows: { pg_no: string }[]) {
  return rows.slice(0, SAMPLE_LIMIT).map((row) => row.pg_no);
}

function issue(input: AuditIssue): AuditIssue | null {
  return input.count > 0 ? input : null;
}

function compactIssues(items: (AuditIssue | null)[]) {
  return items.filter((item): item is AuditIssue => Boolean(item));
}

function hasSellableInventory(value: string | null | undefined) {
  return SELLABLE_INVENTORY_STATUSES.has(value ?? "");
}

async function auditInventoryConsistencySnapshot(
  client: Prisma.TransactionClient,
  workerLease?: WorkerLeaseGuard
) {
  const auditedAt = nowKstSqlDateTime();
  const rows = await loadAuditDeviceRows(client, workerLease);
  await assertWorkerLeaseActive(workerLease);
  const [allInbounds, allInventory, inspectionEvidenceByInboundId] =
    await Promise.all([
      client.inbounds.findMany({
        select: {
          pg_no: true,
          inbound_status: true,
        },
      }),
      client.inventory.findMany({
        select: {
          pg_no: true,
          inventory_status: true,
        },
      }),
      loadInboundInspectionEvidence(
        client,
        rows.flatMap((row) => {
          const inboundId = row.inbounds[0]?.inbound_id;
          return inboundId === undefined
            ? []
            : [{ pgNo: row.pg_no, inboundId }];
        })
      ),
    ]);
  await assertWorkerLeaseActive(workerLease);
  const invalidInboundRows = allInbounds.filter(
    (row) => !inboundStatusValues.has(row.inbound_status)
  );
  const invalidInventoryRows = allInventory.filter(
    (row) => !inventoryStatusValues.has(row.inventory_status)
  );
  const withoutInbound = rows.filter((row) => row.inbounds.length === 0);
  const purchasedWithoutInventory = rows.filter(
    (row) =>
      row.inbounds[0]?.inbound_status === INBOUND_STATUS.purchased &&
      !row.inventory
  );
  const sellableBeforePurchase = rows.filter(
    (row) =>
      hasSellableInventory(row.inventory?.inventory_status) &&
      row.inbounds[0]?.inbound_status !== INBOUND_STATUS.purchased
  );
  const purchasedWithoutModelSeq = rows.filter(
    (row) =>
      row.inbounds[0]?.inbound_status === INBOUND_STATUS.purchased &&
      row.model_seq === null
  );
  const sellableMissingSkuFields = rows.filter(
    (row) =>
      hasSellableInventory(row.inventory?.inventory_status) &&
      (!row.model || !row.storage || !row.sale_grade || !row.warranty)
  );
  const activeMatchStillSellable = rows.filter(
    (row) =>
      row.match_worker_allocations.length > 0 &&
      hasSellableInventory(row.inventory?.inventory_status)
  );
  const deliveryStatusWithoutActiveAllocation = rows.filter(
    (row) =>
      shipmentRequiredInventoryStatuses.has(
        row.inventory?.inventory_status ?? ""
      ) &&
      row.match_worker_allocations.length === 0
  );
  const inspectionLifecycleMismatches = rows.filter((row) => {
    const latestInboundStatus = row.inbounds[0]?.inbound_status ?? null;

    if (
      !latestInboundStatus ||
      latestInboundStatus === INBOUND_STATUS.purchased ||
      latestInboundStatus === INBOUND_STATUS.supplierReturn
    ) {
      return false;
    }

    const inboundId = row.inbounds[0]?.inbound_id;
    const inferred = inferInspectionStatus(
      inboundId === undefined
        ? []
        : inspectionEvidenceByInboundId.get(inboundId) ?? []
    );

    if (inferred === "INSPECTED") {
      return latestInboundStatus !== INBOUND_STATUS.inspected;
    }

    if (inferred === "INSPECTING") {
      return latestInboundStatus === INBOUND_STATUS.received;
    }

    if (inferred === "RETURN_CHECK") {
      return latestInboundStatus !== INBOUND_STATUS.supplierReturn;
    }

    return false;
  });
  const issues = compactIssues([
    issue({
      code: "INVALID_INBOUND_STATUS",
      severity: "CRITICAL",
      count: invalidInboundRows.length,
      samplePgNos: samplePgNos(invalidInboundRows),
      message: "Known inbound status values are not being used.",
    }),
    issue({
      code: "INVALID_INVENTORY_STATUS",
      severity: "CRITICAL",
      count: invalidInventoryRows.length,
      samplePgNos: samplePgNos(invalidInventoryRows),
      message: "Known inventory status values are not being used.",
    }),
    issue({
      code: "DEVICE_WITHOUT_INBOUND",
      severity: "WARNING",
      count: withoutInbound.length,
      samplePgNos: samplePgNos(withoutInbound),
      message: "Device records exist without inbound records.",
    }),
    issue({
      code: "PURCHASED_WITHOUT_INVENTORY",
      severity: "CRITICAL",
      count: purchasedWithoutInventory.length,
      samplePgNos: samplePgNos(purchasedWithoutInventory),
      message: "Purchased devices exist without inventory records.",
    }),
    issue({
      code: "SELLABLE_BEFORE_PURCHASE",
      severity: "CRITICAL",
      count: sellableBeforePurchase.length,
      samplePgNos: samplePgNos(sellableBeforePurchase),
      message: "Sellable inventory exists before the inbound record is purchased.",
    }),
    issue({
      code: "PURCHASED_WITHOUT_MODEL_SEQ",
      severity: "WARNING",
      count: purchasedWithoutModelSeq.length,
      samplePgNos: samplePgNos(purchasedWithoutModelSeq),
      message: "Purchased devices exist without model sequence numbers.",
    }),
    issue({
      code: "SELLABLE_MISSING_SKU_FIELDS",
      severity: "WARNING",
      count: sellableMissingSkuFields.length,
      samplePgNos: samplePgNos(sellableMissingSkuFields),
      message: "Sellable inventory is missing model, storage, sale grade, or warranty.",
    }),
    issue({
      code: "ACTIVE_MATCH_STILL_SELLABLE",
      severity: "WARNING",
      count: activeMatchStillSellable.length,
      samplePgNos: samplePgNos(activeMatchStillSellable),
      message: "Active order matches exist while inventory still appears sellable.",
    }),
    issue({
      code: "DELIVERY_STATUS_WITHOUT_ACTIVE_ALLOCATION",
      severity: "WARNING",
      count: deliveryStatusWithoutActiveAllocation.length,
      samplePgNos: samplePgNos(deliveryStatusWithoutActiveAllocation),
      message:
        "Inventory is marked with a delivery-stage status without an active order allocation.",
    }),
    issue({
      code: "INSPECTION_LIFECYCLE_MISMATCH",
      severity: "INFO",
      count: inspectionLifecycleMismatches.length,
      samplePgNos: samplePgNos(inspectionLifecycleMismatches),
      message: "Inspection records and inbound lifecycle status do not match.",
    }),
  ]);
  const countBySeverity = {
    critical: issues
      .filter((item) => item.severity === "CRITICAL")
      .reduce((sum, item) => sum + item.count, 0),
    warning: issues
      .filter((item) => item.severity === "WARNING")
      .reduce((sum, item) => sum + item.count, 0),
    info: issues
      .filter((item) => item.severity === "INFO")
      .reduce((sum, item) => sum + item.count, 0),
  };

  return {
    auditedAt,
    deviceCount: rows.length,
    inboundCount: allInbounds.length,
    inventoryCount: allInventory.length,
    issueCount: issues.reduce((sum, item) => sum + item.count, 0),
    issueTypeCount: issues.length,
    countBySeverity,
    issues,
  };
}

export async function auditInventoryConsistency(
  workerLease?: WorkerLeaseGuard,
  owner: PrismaClient = prisma
) {
  await assertWorkerLeaseActive(workerLease);
  const result = await runConsistentReadSnapshot(
    owner,
    "inventory.consistency.audit",
    (tx) => auditInventoryConsistencySnapshot(tx, workerLease),
    { timeout: 120_000 }
  );
  await assertWorkerLeaseActive(workerLease);
  return result;
}
