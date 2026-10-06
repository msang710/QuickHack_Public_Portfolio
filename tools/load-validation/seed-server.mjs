import { createFixturePlan } from "./fixture-plan.mjs";
import { assertEmptyTables, insertRows, openDedicatedPool, withTransaction } from "./db.mjs";
import { profileDigest } from "./profile.mjs";

function option(category, key, label = key) { return [category, key, label, ""]; }

export async function seedServerDatabase(profileInput, connectionString, { onProgress = () => {} } = {}) {
  const plan = createFixturePlan(profileInput);
  const profile = plan.profile;
  const { pool, identity } = await openDedicatedPool(connectionString, "server");
  const prefix = `LV-${profile.runId}-`;
  let deviceCount = 0;
  try {
    await withTransaction(pool, async (tx) => {
      await assertEmptyTables(tx, ["inventory_skus", "devices", "inventory", "coupang_order_raw", "order_matching_work_queue", "inventory_quantity_movements"]);
      const options = [];
      for (let model = 0; model < 200; model += 1) options.push(option("PRODUCT_MODEL", `${prefix}M${String(model).padStart(3, "0")}`));
      for (let index = 0; index < 5; index += 1) {
        options.push(option("STORAGE", `${prefix}S${index}`));
        options.push(option("DEVICE_COLOR", `${prefix}C${index}`));
      }
      for (let index = 0; index < 4; index += 1) options.push(option("SALE_GRADE", `${prefix}G${index}`));
      options.push(option("WARRANTY_GROUP", "1Y", "1년"));
      await insertRows(tx, "product_criteria_options", ["category", "option_key", "label", "parent_key"], options);
    });
    const optionsResult = await pool.query("SELECT option_id, category, option_key FROM product_criteria_options WHERE option_key LIKE $1 OR (category='WARRANTY_GROUP' AND option_key='1Y')", [`${prefix}%`]);
    const optionIds = new Map(optionsResult.rows.map((row) => [`${row.category}:${row.option_key}`, row.option_id]));
    const id = (category, key) => {
      const result = optionIds.get(`${category}:${key}`);
      if (!result) throw new Error(`Missing fixture option ${category}:${key}.`);
      return result;
    };
    for (let start = 0; start < profile.skuCount; start += 1_000) {
      await withTransaction(pool, async (tx) => {
        const rows = [];
        for (let index = start; index < Math.min(profile.skuCount, start + 1_000); index += 1) {
          const sku = plan.sku(index);
          rows.push([sku.skuCode, id("PRODUCT_MODEL", sku.modelKey), id("STORAGE", sku.storageKey), id("DEVICE_COLOR", sku.colorKey), id("SALE_GRADE", sku.gradeKey)]);
        }
        await insertRows(tx, "inventory_skus", ["sku_code", "model_option_id", "storage_option_id", "color_option_id", "sale_grade_option_id"], rows);
      });
      onProgress({ stage: "sku", completed: Math.min(profile.skuCount, start + 1_000), total: profile.skuCount });
    }
    const skuRows = await pool.query("SELECT inventory_sku_id, sku_code FROM inventory_skus WHERE sku_code LIKE $1", [`${prefix}%`]);
    const skuIds = new Map(skuRows.rows.map((row) => [row.sku_code, row.inventory_sku_id]));
    const offerCodes = new Set();
    const offerRows = [];
    for (let index = 0; index < profile.skuCount; index += 1) {
      const sku = plan.sku(index);
      if (offerCodes.has(sku.offerCode)) continue;
      offerCodes.add(sku.offerCode);
      offerRows.push([sku.offerCode, id("PRODUCT_MODEL", sku.modelKey), "EXACT", id("STORAGE", sku.storageKey), "EXACT", id("DEVICE_COLOR", sku.colorKey), id("WARRANTY_GROUP", sku.warrantyKey)]);
    }
    await withTransaction(pool, (tx) => insertRows(tx, "sales_offers", ["offer_code", "model_option_id", "storage_match_mode", "storage_option_id", "color_match_mode", "color_option_id", "warranty_group_option_id"], offerRows));
    const offerResult = await pool.query("SELECT sales_offer_id, offer_code FROM sales_offers WHERE offer_code LIKE $1", [`${prefix}%`]);
    const offerIds = new Map(offerResult.rows.map((row) => [row.offer_code, row.sales_offer_id]));
    for (let start = 0; start < profile.skuCount; start += 1_000) {
      await withTransaction(pool, async (tx) => {
        const rows = [];
        const devices = [];
        const inventory = [];
        for (let index = start; index < Math.min(profile.skuCount, start + 1_000); index += 1) {
          const sku = plan.sku(index);
          rows.push(["COUPANG", sku.productId, sku.vendorItemId, sku.salesOfferId ?? offerIds.get(sku.offerCode), "MAPPED"]);
          const pgNo = `LS${String(index).padStart(10, "0")}`;
          devices.push([pgNo, sku.modelKey, sku.modelKey, 1_000_000 + index, sku.storageKey, sku.colorKey, sku.gradeKey, skuIds.get(sku.skuCode)]);
          inventory.push([pgNo, "SELLABLE", "LOAD_FIXTURE", profile.historyEnd]);
        }
        await insertRows(tx, "sales_channel_product_mappings", ["channel", "external_product_id", "external_vendor_item_id", "sales_offer_id", "mapping_status"], rows);
        await insertRows(tx, "devices", ["pg_no", "model", "model_code", "model_seq", "storage", "color", "sale_grade", "inventory_sku_id"], devices);
        await insertRows(tx, "inventory", ["pg_no", "inventory_status", "location", "stocked_at"], inventory);
        deviceCount += devices.length;
      });
    }

    for (let start = 0; start < plan.counts.totalOrderCount; start += 500) {
      await withTransaction(pool, async (tx) => {
        const raw = [];
        const devices = [];
        const inventory = [];
        const allocations = [];
        const workItems = [];
        for (let index = start; index < Math.min(plan.counts.totalOrderCount, start + 500); index += 1) {
          const order = plan.order(index);
          raw.push([order.orderId, order.shipmentId, order.status, order.orderedAt, order.orderedAt]);
          for (let line = 0; line < order.skuIndexes.length; line += 1) {
            const sku = plan.sku(order.skuIndexes[line]);
            const pgNo = order.pgNo(line);
            devices.push([pgNo, sku.modelKey, sku.modelKey, index * 2 + line + 1, sku.storageKey, sku.colorKey, sku.gradeKey, skuIds.get(sku.skuCode)]);
            inventory.push([pgNo, order.historical ? "FINAL_DELIVERY" : "PACKING", "LOAD_FIXTURE", order.orderedAt]);
            allocations.push([order.orderId, pgNo, order.shipmentId, sku.vendorItemId, sku.productId, offerIds.get(sku.offerCode), skuIds.get(sku.skuCode), sku.modelKey, sku.storageKey, sku.colorKey, order.historical ? "API_ACKED" : "SHIPMENT_LIST_PRINTED", order.orderedAt]);
            workItems.push(["COUPANG", order.orderId, order.shipmentId, sku.vendorItemId, sku.skuCode,
              sku.sellerProductId, sku.offerCode, sku.skuCode, sku.skuCode, 100_000, 1, 1,
              order.orderedAt, "MAPPED", offerIds.get(sku.offerCode), sku.modelKey, sku.storageKey,
              sku.colorKey, sku.warrantyKey, "MATCHED", order.orderedAt]);
          }
        }
        await insertRows(tx, "coupang_order_raw", ["external_order_id", "external_shipment_id", "external_order_status", "ordered_at", "paid_at"], raw);
        await insertRows(tx, "devices", ["pg_no", "model", "model_code", "model_seq", "storage", "color", "sale_grade", "inventory_sku_id"], devices);
        await insertRows(tx, "inventory", ["pg_no", "inventory_status", "location", "stocked_at"], inventory);
        await insertRows(tx, "match_worker_allocation", ["external_order_id", "pg_no", "external_shipment_id", "external_vendor_item_id", "external_product_id", "sales_offer_id", "inventory_sku_id", "required_model", "required_storage", "required_color", "allocation_status", "allocated_at"], allocations);
        await insertRows(tx, "order_matching_work_queue", ["channel", "external_order_id", "external_shipment_id", "external_vendor_item_id", "vendor_item_name", "seller_product_id", "seller_product_name", "seller_product_item_name", "external_vendor_sku_code", "sales_price", "ordered_quantity", "matchable_quantity", "ordered_at", "mapping_status", "sales_offer_id", "required_model_label", "required_storage_label", "required_color_label", "required_warranty_group", "work_status", "matched_at"], workItems);
        deviceCount += devices.length;
      });
      if (start % 5_000 === 0 || start + 500 >= plan.counts.totalOrderCount) onProgress({ stage: "orders", completed: Math.min(plan.counts.totalOrderCount, start + 500), total: plan.counts.totalOrderCount });
    }

    await withTransaction(pool, async (tx) => {
      await tx.query(`INSERT INTO inventory_quantity_balances (inventory_sku_id, inventory_status, quantity, last_movement_at)
        SELECT d.inventory_sku_id, i.inventory_status, count(*)::int, max(i.stocked_at)
        FROM inventory i JOIN devices d ON d.pg_no=i.pg_no
        WHERE i.location='LOAD_FIXTURE'
        GROUP BY d.inventory_sku_id, i.inventory_status`);
      await tx.query(`INSERT INTO inventory_quantity_movements
        (inventory_quantity_balance_id, operation_key, idempotency_key, movement_type, pg_no, quantity_delta, before_quantity, after_quantity, source_type, source_id, occurred_at)
        SELECT ranked.inventory_quantity_balance_id, $1 || ranked.pg_no, $1 || ranked.pg_no,
          'INVENTORY_CREATED', ranked.pg_no, 1, (ranked.ordinal-1)::int, ranked.ordinal::int,
          'LOAD_FIXTURE', ranked.pg_no, ranked.stocked_at
        FROM (
          SELECT b.inventory_quantity_balance_id, i.pg_no, i.stocked_at,
            row_number() OVER (PARTITION BY b.inventory_quantity_balance_id ORDER BY i.pg_no) AS ordinal
          FROM inventory i JOIN devices d ON d.pg_no=i.pg_no
          JOIN inventory_quantity_balances b ON b.inventory_sku_id=d.inventory_sku_id AND b.inventory_status=i.inventory_status
          WHERE i.location='LOAD_FIXTURE'
        ) ranked ORDER BY ranked.inventory_quantity_balance_id, ranked.ordinal`, [`load-fixture:${profile.runId}:`]);
    });
    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM inventory_skus) AS sku_count,
      (SELECT count(*)::int FROM devices) AS device_count,
      (SELECT count(*)::int FROM coupang_order_raw) AS order_count,
      (SELECT count(*)::int FROM inventory_quantity_movements) AS movement_count`);
    const actual = counts.rows[0];
    if (actual.sku_count !== profile.skuCount || actual.order_count !== plan.counts.totalOrderCount || actual.device_count !== deviceCount || actual.movement_count !== deviceCount) {
      throw new Error(`Server fixture count mismatch: ${JSON.stringify(actual)}.`);
    }
    return { database: identity, profileDigest: profileDigest(profile), ...actual };
  } finally {
    await pool.end();
  }
}
