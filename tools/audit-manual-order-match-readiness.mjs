import { prisma } from "@/quickhack_server/core/prisma";
import { normalizePgNo } from "@/quickhack_shared/inventory/pg-no";
import {
  ACTIVE_ALLOCATION_INDEX_CONTRACT,
  assertActiveAllocationIndex,
} from "@/quickhack_shared/core/postgresql-schema-contract.mjs";

const ACTIVE_ALLOCATION_STATUSES = [...ACTIVE_ALLOCATION_INDEX_CONTRACT.statuses];
const CANONICAL_PG_PATTERN = /^[A-Z]{2}\d{10}$/;

function collectIdentityIssues(rows, source) {
  const noncanonical = [];
  const identities = new Map();
  for (const row of rows) {
    const raw = String(row.pg_no ?? "");
    const canonical = normalizePgNo(raw);
    if (!CANONICAL_PG_PATTERN.test(raw)) {
      noncanonical.push({ source, id: row.id, pgNo: raw, canonical });
    }
    const owners = identities.get(canonical) ?? [];
    owners.push({ source, id: row.id, pgNo: raw });
    identities.set(canonical, owners);
  }
  return { noncanonical, identities };
}

function crossSourceCollisions(...identityMaps) {
  const merged = new Map();
  for (const identities of identityMaps) {
    for (const [canonical, owners] of identities) {
      const existing = merged.get(canonical) ?? [];
      existing.push(...owners);
      merged.set(canonical, existing);
    }
  }
  return [...merged.entries()]
    .filter(([canonical, owners]) => canonical && new Set(owners.map((owner) => owner.pgNo)).size > 1)
    .map(([canonical, owners]) => ({ canonical, owners }));
}

try {
  const [devices, inventories, activeAllocations, movementPgs, orphanRows, activeAllocationIndexRows] =
    await Promise.all([
      prisma.devices.findMany({
        select: { device_id: true, pg_no: true },
        orderBy: { device_id: "asc" },
      }),
      prisma.inventory.findMany({
        select: { inventory_id: true, pg_no: true },
        orderBy: { inventory_id: "asc" },
      }),
      prisma.match_worker_allocation.findMany({
        where: { allocation_status: { in: ACTIVE_ALLOCATION_STATUSES } },
        select: { allocation_id: true, pg_no: true, allocation_status: true },
        orderBy: { allocation_id: "asc" },
      }),
      prisma.inventory_quantity_movements.findMany({
        where: { pg_no: { not: null } },
        select: { inventory_quantity_movement_id: true, pg_no: true },
        orderBy: { inventory_quantity_movement_id: "asc" },
      }),
      prisma.$queryRaw`
        SELECT
          allocation.allocation_id,
          allocation.pg_no,
          (device.device_id IS NULL) AS missing_device,
          (inventory.inventory_id IS NULL) AS missing_inventory
        FROM match_worker_allocation AS allocation
        LEFT JOIN devices AS device ON device.pg_no = allocation.pg_no
        LEFT JOIN inventory ON inventory.pg_no = allocation.pg_no
        WHERE allocation.allocation_status IN ('ALLOCATED', 'API_ACKED', 'SHIPMENT_LIST_PRINTED')
          AND (device.device_id IS NULL OR inventory.inventory_id IS NULL)
        ORDER BY allocation.allocation_id
      `,
      prisma.$queryRaw`
        SELECT index_class.relname AS index_name,
               table_class.relname AS table_name,
               catalog.indisvalid AS is_valid,
               catalog.indisready AS is_ready,
               catalog.indisunique AS is_unique,
               pg_get_expr(catalog.indpred, catalog.indrelid) AS predicate
        FROM pg_index AS catalog
        JOIN pg_class AS index_class ON index_class.oid = catalog.indexrelid
        JOIN pg_class AS table_class ON table_class.oid = catalog.indrelid
        WHERE index_class.relnamespace = current_schema()::regnamespace
          AND index_class.relname = ${ACTIVE_ALLOCATION_INDEX_CONTRACT.name}
      `,
    ]);

  const deviceIdentity = collectIdentityIssues(
    devices.map((row) => ({ id: row.device_id, pg_no: row.pg_no })),
    "devices"
  );
  const inventoryIdentity = collectIdentityIssues(
    inventories.map((row) => ({ id: row.inventory_id, pg_no: row.pg_no })),
    "inventory"
  );
  const allocationIdentity = collectIdentityIssues(
    activeAllocations.map((row) => ({ id: row.allocation_id, pg_no: row.pg_no })),
    "match_worker_allocation"
  );
  const movementIdentity = collectIdentityIssues(
    movementPgs.map((row) => ({
      id: row.inventory_quantity_movement_id,
      pg_no: row.pg_no,
    })),
    "inventory_quantity_movements"
  );
  const allocationGroups = new Map();
  for (const allocation of activeAllocations) {
    const canonical = normalizePgNo(allocation.pg_no);
    const group = allocationGroups.get(canonical) ?? [];
    group.push(allocation);
    allocationGroups.set(canonical, group);
  }
  const activeAllocationDuplicates = [...allocationGroups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([canonical, rows]) => ({ canonical, allocations: rows }));
  const noncanonical = [
    ...deviceIdentity.noncanonical,
    ...inventoryIdentity.noncanonical,
    ...allocationIdentity.noncanonical,
    ...movementIdentity.noncanonical,
  ];
  const collisions = crossSourceCollisions(
    deviceIdentity.identities,
    inventoryIdentity.identities,
    allocationIdentity.identities,
    movementIdentity.identities
  );
  const indexRow = activeAllocationIndexRows[0] ?? null;
  const activeAllocationIndex = [];
  try {
    if (activeAllocationIndexRows.length !== 1) throw new Error("index-count");
    assertActiveAllocationIndex(indexRow);
  } catch {
    activeAllocationIndex.push({
      expectedName: ACTIVE_ALLOCATION_INDEX_CONTRACT.name,
      expectedStatuses: ACTIVE_ALLOCATION_STATUSES,
      actual: indexRow,
    });
  }
  const issues = {
    noncanonical,
    canonicalCollisions: collisions,
    activeAllocationDuplicates,
    activeAllocationOrphans: orphanRows,
    activeAllocationIndex,
  };
  const issueCount = Object.values(issues).reduce(
    (total, entries) => total + entries.length,
    0
  );
  const report = {
    version: 1,
    audit: "manual-order-match-readiness",
    status: issueCount === 0 ? "PASS" : "BLOCKED",
    readOnly: true,
    counts: {
      devices: devices.length,
      inventories: inventories.length,
      activeAllocations: activeAllocations.length,
      movementsWithPg: movementPgs.length,
      issues: issueCount,
    },
    issues,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (issueCount > 0) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
