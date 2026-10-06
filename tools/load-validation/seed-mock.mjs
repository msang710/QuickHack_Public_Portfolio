import { createFixturePlan } from "./fixture-plan.mjs";
import { assertEmptyTables, insertRows, openDedicatedPool, withTransaction } from "./db.mjs";
import { profileDigest } from "./profile.mjs";

function syntheticCustomer() {
  return {
    ordererName: "부하검증 주문자", receiverName: "부하검증 수취인",
    phone: "010-0000-0000", address: "서울특별시 테스트구 합성로 1", postCode: "00000",
  };
}

async function insertCoupangOrderRange(tx, plan, start, count, batchId, orderedAtOverride = null) {
  const orderRows = [];
  const itemRows = [];
  const customer = syntheticCustomer();
  for (let index = start; index < start + count; index += 1) {
    const order = plan.order(index);
    const orderedAt = orderedAtOverride ?? order.orderedAt;
    const items = order.skuIndexes.map((skuIndex) => plan.sku(skuIndex));
    const itemPayload = items.map((sku) => ({
      productId: sku.productId, vendorItemId: sku.vendorItemId, vendorItemName: sku.skuCode,
      sellerProductId: sku.sellerProductId, sellerProductName: sku.offerCode,
      sellerProductItemName: sku.skuCode, vendorSkuCode: sku.skuCode,
      shippingCount: 1, holdCountForCancel: 0, cancelCount: 0, canceled: false,
    }));
    const payload = {
      orderId: order.orderId, shipmentBoxId: order.shipmentId, status: order.status,
      orderedAt, paidAt: orderedAt,
      orderer: { name: customer.ordererName, phone: customer.phone },
      receiver: { name: customer.receiverName, phone: customer.phone, mobile: customer.phone,
        safeNumber: "0504-0000-0000", addr1: customer.address, addr2: "", postCode: customer.postCode },
      orderItems: itemPayload,
    };
    orderRows.push([
      batchId, 1, order.orderId, order.shipmentId, order.status, orderedAt, orderedAt,
      customer.ordererName, customer.phone, customer.receiverName, customer.phone, customer.phone,
      "0504-0000-0000", customer.address, "", customer.postCode, "", JSON.stringify(payload), orderedAt, orderedAt,
    ]);
    for (const item of itemPayload) itemRows.push([
      order.orderId, item.productId, item.vendorItemId, item.vendorItemName,
      item.sellerProductId, item.sellerProductName, item.sellerProductItemName, item.vendorSkuCode,
      1, 0, 0, 0, JSON.stringify(item), orderedAt,
    ]);
  }
  await insertRows(tx, "mock_orders", ["batch_id", "page_no", "order_id", "shipment_box_id", "status", "ordered_at", "paid_at", "orderer_name", "orderer_phone", "receiver_name", "receiver_phone", "receiver_mobile", "receiver_safe_number", "receiver_addr1", "receiver_addr2", "receiver_post_code", "delivery_message", "raw_json", "created_at", "updated_at"], orderRows);
  await insertRows(tx, "mock_order_items", ["order_id", "product_id", "vendor_item_id", "vendor_item_name", "seller_product_id", "seller_product_name", "seller_product_item_name", "vendor_sku_code", "shipping_count", "hold_count_for_cancel", "cancel_count", "canceled", "raw_json", "created_at"], itemRows);
  return itemRows.length;
}

export async function seedCoupangMock(profileInput, connectionString, { onProgress = () => {} } = {}) {
  const plan = createFixturePlan(profileInput);
  const profile = plan.profile;
  const { pool, identity } = await openDedicatedPool(connectionString, "coupang-mock");
  try {
    await withTransaction(pool, async (tx) => {
      const existingOrders = await tx.query("SELECT count(*)::int AS count FROM mock_orders");
      if (existingOrders.rows[0].count !== 0) throw new Error("Dedicated Coupang Mock already has orders.");
      await tx.query("TRUNCATE mock_return_withdrawals, mock_exchange_requests, mock_return_requests, mock_order_items, mock_orders, mock_batches, mock_products, mock_counters RESTART IDENTITY CASCADE");
      await tx.query(`INSERT INTO mock_metadata (key, value, updated_at) VALUES ('product_catalog_version', $1, now()::text)
        ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, [`quickhack-load-v1:${profile.runId}:0`]);
    });
    for (let start = 0; start < profile.skuCount; start += 1_000) {
      await withTransaction(pool, async (tx) => {
        const rows = [];
        for (let index = start; index < Math.min(profile.skuCount, start + 1_000); index += 1) {
          const sku = plan.sku(index);
          rows.push([
            sku.vendorItemId, sku.productId, sku.sellerProductId, sku.offerCode, sku.skuCode,
            sku.skuCode, sku.skuCode, sku.modelKey, sku.colorKey, sku.storageKey, sku.gradeKey,
            1, 100_000, sku.warrantyKey, sku.warrantyKey, index + 1,
            JSON.stringify({ loadFixture: profile.runId, skuCode: sku.skuCode }), profile.historyEnd, profile.historyEnd,
          ]);
        }
        await insertRows(tx, "mock_products", ["vendor_item_id", "product_id", "seller_product_id", "seller_product_name", "seller_product_item_name", "vendor_item_name", "vendor_sku_code", "quickhack_model", "quickhack_color", "quickhack_capacity", "quickhack_grade", "current_quantity_snapshot", "average_price_snapshot", "quickhack_grade_group_code", "quickhack_grade_group_label", "source_row_index", "raw_json", "created_at", "updated_at"], rows);
      });
      onProgress({ stage: "mock-products", completed: Math.min(profile.skuCount, start + 1_000), total: profile.skuCount });
    }
    for (let start = 0; start < plan.counts.totalOrderCount; start += 500) {
      await withTransaction(pool, async (tx) => {
        const count = Math.min(500, plan.counts.totalOrderCount - start);
        const batchId = `lv-${profile.runId}-${start}`;
        await insertRows(tx, "mock_batches", ["batch_id", "status", "page_size", "total_orders", "total_pages", "created_at"], [[batchId, plan.order(start).status, 100, count, Math.ceil(count / 100), plan.order(start).orderedAt]]);
        await insertCoupangOrderRange(tx, plan, start, count, batchId);
      });
      if (start % 5_000 === 0 || start + 500 >= plan.counts.totalOrderCount) onProgress({ stage: "mock-orders", completed: Math.min(plan.counts.totalOrderCount, start + 500), total: plan.counts.totalOrderCount });
    }
    await withTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO mock_counters (name, value) VALUES ('order', $1)", [plan.counts.totalOrderCount]);
      await tx.query(`UPDATE mock_metadata SET value=$1, updated_at=now()::text WHERE key='product_catalog_version'`, [`quickhack-load-v1:${profile.runId}:${profile.skuCount}`]);
      await tx.query(`INSERT INTO mock_metadata (key, value, updated_at) VALUES ('load_profile_digest', $1, now()::text)
        ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, [profileDigest(profile)]);
    });
    return { database: identity, profileDigest: profileDigest(profile), skuCount: profile.skuCount, orderCount: plan.counts.totalOrderCount };
  } finally { await pool.end(); }
}

export async function appendCoupangOrders(pool, profileInput, start, count) {
  const plan = createFixturePlan(profileInput);
  if (!Number.isSafeInteger(start) || start < plan.counts.totalOrderCount || !Number.isSafeInteger(count) || count < 1 || count > 500) {
    throw new TypeError("Live Mock append must start after the initial fixture and contain 1..500 orders.");
  }
  return withTransaction(pool, async (tx) => {
    const batchId = `lv-${plan.profile.runId}-live-${start}`;
    const orderedAt = new Date().toISOString();
    await insertRows(tx, "mock_batches", ["batch_id", "status", "page_size", "total_orders", "total_pages", "created_at"], [[batchId, plan.order(start).status, 100, count, Math.ceil(count / 100), orderedAt]]);
    const itemCount = await insertCoupangOrderRange(tx, plan, start, count, batchId, orderedAt);
    return { orderCount: count, itemCount, start };
  });
}

export async function seedLogenMock(profileInput, connectionString, { onProgress = () => {} } = {}) {
  const plan = createFixturePlan(profileInput);
  const { pool, identity } = await openDedicatedPool(connectionString, "logen-mock");
  try {
    const reference = await pool.query("SELECT cust_cd FROM mock_contracts ORDER BY cust_cd LIMIT 1");
    const credential = await pool.query("SELECT user_id FROM mock_credentials ORDER BY user_id LIMIT 1");
    if (!reference.rows[0] || !credential.rows[0]) throw new Error("Initialize the dedicated Logen Mock reference data before seeding.");
    await withTransaction(pool, (tx) => assertEmptyTables(tx, ["mock_invoice_allocations", "mock_shipments"]));
    const custCd = reference.rows[0].cust_cd;
    const userId = credential.rows[0].user_id;
    for (let start = 0; start < plan.counts.historicalOrderCount; start += 500) {
      await withTransaction(pool, async (tx) => {
        const invoices = [];
        const shipments = [];
        for (let index = start; index < Math.min(start + 500, plan.counts.historicalOrderCount); index += 1) {
          const order = plan.order(index);
          const slipNo = (930000000000000000n + BigInt(index)).toString();
          invoices.push([slipNo, userId, "REGISTERED", order.orderedAt, order.orderedAt]);
          shipments.push([slipNo, custCd, order.orderId, "Y", "N", "01", order.orderedAt.slice(0, 10).replaceAll("-", ""),
            "부하검증 발송인", "부하검증 수취인", "서울특별시 테스트구 합성로 1", "합성 상품", 1, "DELIVERED",
            JSON.stringify({ loadFixture: plan.profile.runId, orderId: order.orderId, slipNo }), order.orderedAt, order.orderedAt]);
        }
        await insertRows(tx, "mock_invoice_allocations", ["slip_no", "user_id", "status", "allocated_at", "registered_at"], invoices);
        await insertRows(tx, "mock_shipments", ["slip_no", "cust_cd", "fix_take_no", "print_yn", "slip_ty", "fare_ty", "take_dt", "sender_name", "receiver_name", "receiver_address", "goods_name", "goods_amount", "shipment_state", "raw_json", "registered_at", "updated_at"], shipments);
      });
      if (start % 5_000 === 0 || start + 500 >= plan.counts.historicalOrderCount) onProgress({ stage: "logen-shipments", completed: Math.min(start + 500, plan.counts.historicalOrderCount), total: plan.counts.historicalOrderCount });
    }
    return { database: identity, profileDigest: profileDigest(plan.profile), shipmentCount: plan.counts.historicalOrderCount };
  } finally { await pool.end(); }
}
