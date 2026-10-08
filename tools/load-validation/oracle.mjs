import { createFixturePlan } from "./fixture-plan.mjs";
import { openDedicatedPool } from "./db.mjs";

async function count(pool, table) {
  if (!["inventory_skus", "devices", "inventory", "inventory_quantity_movements", "coupang_order_raw", "order_matching_work_queue", "mock_products", "mock_orders", "mock_shipments"].includes(table)) throw new TypeError("Unknown oracle count table.");
  const result = await pool.query(`SELECT count(*)::int AS value FROM ${table}`);
  return result.rows[0].value;
}

async function orderIds(pool, table, column) {
  const result = await pool.query(`SELECT ${column} AS id FROM ${table}`);
  return new Set(result.rows.map((row) => row.id));
}

async function ledgerViolations(pool) {
  const result = await pool.query(`
    WITH counted AS (
      SELECT d.inventory_sku_id, i.inventory_status, count(*)::int AS quantity
      FROM inventory i JOIN devices d ON d.pg_no=i.pg_no
      GROUP BY d.inventory_sku_id, i.inventory_status
    ), balance_diff AS (
      SELECT count(*)::int AS violations FROM counted c FULL JOIN inventory_quantity_balances b
        ON b.inventory_sku_id=c.inventory_sku_id AND b.inventory_status=c.inventory_status
      WHERE coalesce(c.quantity,0)<>coalesce(b.quantity,0)
    ), movement_diff AS (
      SELECT count(*)::int AS violations FROM inventory_quantity_balances b
      LEFT JOIN (SELECT inventory_quantity_balance_id, sum(quantity_delta)::int AS quantity
        FROM inventory_quantity_movements GROUP BY inventory_quantity_balance_id) m
        ON m.inventory_quantity_balance_id=b.inventory_quantity_balance_id
      WHERE b.quantity<>coalesce(m.quantity,0)
    ), malformed AS (
      SELECT count(*)::int AS violations FROM (
        SELECT operation_key, movement_type, count(*) AS n, sum(quantity_delta) AS delta
        FROM inventory_quantity_movements GROUP BY operation_key,movement_type
        HAVING (movement_type='INVENTORY_CREATED' AND (count(*)<>1 OR sum(quantity_delta)<>1))
          OR (movement_type='STATUS_TRANSFER' AND (count(*)<>2 OR sum(quantity_delta)<>0))
      ) bad
    )
    SELECT (SELECT violations FROM balance_diff) AS balance_diff,
      (SELECT violations FROM movement_diff) AS movement_diff,
      (SELECT violations FROM malformed) AS malformed`);
  return result.rows[0];
}

export async function verifyLoadDatabases(profileInput, { serverUrl, coupangUrl, logenUrl = null }) {
  const plan = createFixturePlan(profileInput);
  const server = await openDedicatedPool(serverUrl, "oracle-server");
  let coupang;
  let logen;
  try {
    coupang = await openDedicatedPool(coupangUrl, "oracle-coupang");
    if (server.identity === coupang.identity) throw new Error("Server and Coupang Mock must use separate databases or schemas.");
    if (logenUrl) {
      logen = await openDedicatedPool(logenUrl, "oracle-logen");
      if (logen.identity === server.identity || logen.identity === coupang.identity) throw new Error("Logen Mock must use a separate database or schema.");
    }
    const [skuCount, deviceCount, inventoryCount, movementCount, serverOrderCount, workItemCount, mockSkuCount, mockOrderCount, serverIds, workOrderIds, mockIds, ledger, logenCount] = await Promise.all([
      count(server.pool, "inventory_skus"), count(server.pool, "devices"), count(server.pool, "inventory"), count(server.pool, "inventory_quantity_movements"),
      count(server.pool, "coupang_order_raw"), count(server.pool, "order_matching_work_queue"), count(coupang.pool, "mock_products"), count(coupang.pool, "mock_orders"),
      orderIds(server.pool, "coupang_order_raw", "external_order_id"), orderIds(server.pool, "order_matching_work_queue", "external_order_id"), orderIds(coupang.pool, "mock_orders", "order_id"),
      ledgerViolations(server.pool), logen ? count(logen.pool, "mock_shipments") : Promise.resolve(null),
    ]);
    let missingInitialServer = 0;
    let missingInitialWork = 0;
    let missingInitialMock = 0;
    for (let index = 0; index < plan.counts.totalOrderCount; index += 1) {
      const id = plan.order(index).orderId;
      if (!serverIds.has(id)) missingInitialServer += 1;
      if (!workOrderIds.has(id)) missingInitialWork += 1;
      if (!mockIds.has(id)) missingInitialMock += 1;
    }
    let mockOnly = 0;
    let serverOnly = 0;
    for (const id of mockIds) if (!serverIds.has(id)) mockOnly += 1;
    for (const id of serverIds) if (!mockIds.has(id)) serverOnly += 1;
    const [serverFirstSeen, mockCreated] = await Promise.all([
      server.pool.query("SELECT external_order_id AS id, created_at AS timestamp FROM coupang_order_raw"),
      coupang.pool.query("SELECT order_id AS id, ordered_at AS timestamp FROM mock_orders"),
    ]);
    const initialIds = new Set(Array.from(
      { length: plan.counts.totalOrderCount },
      (_, index) => plan.order(index).orderId
    ));
    const mockCreatedAt = new Map(
      mockCreated.rows.map((row) => [row.id, Date.parse(row.timestamp)])
    );
    const arrivalLags = serverFirstSeen.rows
      .filter((row) => !initialIds.has(row.id) && mockCreatedAt.has(row.id))
      .map((row) => new Date(row.timestamp).getTime() - mockCreatedAt.get(row.id))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const arrivalLagP95Ms = arrivalLags.length
      ? arrivalLags[Math.ceil(arrivalLags.length * 0.95) - 1]
      : null;
    const arrivalLagMaxMs = arrivalLags.length
      ? arrivalLags.at(-1)
      : null;
    const malformedActive = await server.pool.query(`
      SELECT count(*)::int AS value FROM inventory
      WHERE pg_no >= $1 AND pg_no <= $2 AND inventory_status NOT IN ('PACKING','PACKED')`, [
      plan.order(plan.counts.historicalOrderCount).pgNo(0),
      plan.order(plan.counts.totalOrderCount - 1).pgNo(0),
    ]);
    const duplicateAllocation = await server.pool.query(`SELECT count(*)::int AS value FROM (
      SELECT pg_no FROM match_worker_allocation
      WHERE allocation_status IN ('ALLOCATED','API_ACKED','SHIPMENT_LIST_PRINTED')
      GROUP BY pg_no HAVING count(*)>1) duplicates`);
    const packed = await server.pool.query("SELECT count(*)::int AS value FROM inventory WHERE pg_no LIKE 'LV%' AND inventory_status='PACKED'");
    const findings = {
      skuCount, deviceCount, inventoryCount, movementCount, serverOrderCount, workItemCount,
      mockSkuCount, mockOrderCount, logenShipmentCount: logenCount,
      missingInitialServer, missingInitialWork, missingInitialMock, mockOnly, serverOnly,
      arrivalLagSampleCount: arrivalLags.length,
      arrivalLagP95Ms,
      arrivalLagMaxMs,
      ledger, malformedActiveInventoryCount: malformedActive.rows[0].value,
      duplicateActiveAllocationCount: duplicateAllocation.rows[0].value, packedActiveCount: packed.rows[0].value,
    };
    const mismatch = skuCount !== plan.profile.skuCount || mockSkuCount !== plan.profile.skuCount ||
      serverOrderCount < plan.counts.totalOrderCount || mockOrderCount < plan.counts.totalOrderCount ||
      inventoryCount !== deviceCount || movementCount < deviceCount || workItemCount < plan.counts.totalOrderCount || missingInitialServer || missingInitialWork || missingInitialMock || serverOnly ||
      Object.values(ledger).some((value) => value !== 0) || malformedActive.rows[0].value || duplicateAllocation.rows[0].value ||
      (logen && logenCount !== plan.counts.historicalOrderCount);
    return { schema: "quickhack-load-oracle/v1", findings, verdict: mismatch ? "FAIL" : mockOnly ? "INCONCLUSIVE" : "PASS" };
  } finally {
    await Promise.allSettled([server.pool.end(), coupang?.pool.end(), logen?.pool.end()].filter(Boolean));
  }
}
