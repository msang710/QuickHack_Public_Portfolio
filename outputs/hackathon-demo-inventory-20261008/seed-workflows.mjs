// Add a coherent demonstration purchase, order, sale and return history to the
// already seeded 43-device inventory. This intentionally targets the installed
// demonstration database only and never calls a live sales channel.
import fs from "node:fs";
import pg from "/usr/lib/quickhack/demonstration-server/node_modules/pg/lib/index.js";
import { resolvePostgresqlConnectionStringSync } from "/usr/lib/quickhack/demonstration-server/quickhack_server/core/database/postgresql-credential.mjs";

const INVENTORY_PREFIX = "HACKATHON_DEMO_INVENTORY_20261008";
const WORKFLOW_PREFIX = "HACKATHON_DEMO_WORKFLOW_20261008";
const CSV_HEADER = "pg_no,model_option_key,model_name,storage_option_key,color_option_key,sale_grade_option_key,inventory_status,location,stocked_at";
const DAY = 86_400_000;
const OPEN_STATUSES = ["RESERVED", "RESERVED", "RESERVED", "RESERVED", "PACKING", "PACKING", "PACKED", "PACKED"];
const SNAPSHOT_ORDER_STATUSES = new Set(["PACKING", "PACKED", "DEPARTURE", "DELIVERING", "FINAL_DELIVERY", "NONE_TRACKING"]);
const SUPPLIERS = ["서울 모바일 도매", "한빛 중고기기", "동서 리퍼브", "우리모바일 매입"];

function csvRows(path) {
  const lines = fs.readFileSync(path, "utf8").replace(/^\uFEFF/u, "").trimEnd().split(/\r?\n/u);
  if (lines.shift() !== CSV_HEADER) throw new Error("CSV_HEADER_MISMATCH");
  const rows = lines.map((line) => {
    const [pgNo, modelCode, model, storage, color, grade, status, location, stockedAt] = line.split(",");
    if (!/^[A-Z]{2}\d{10}$/u.test(pgNo) || !modelCode || !model || !storage || !color || !grade ||
        !status || !location || !Number.isFinite(new Date(stockedAt).getTime())) throw new Error("CSV_ROW_INVALID");
    return { pgNo, modelCode, model, storage, color, grade, status, location, stockedAt: new Date(stockedAt) };
  });
  if (rows.length !== 43 || new Set(rows.map((row) => row.pgNo)).size !== 43) throw new Error("CSV_COVERAGE_MISMATCH");
  return rows;
}

function manifestRows(path, original) {
  const plan = JSON.parse(fs.readFileSync(path, "utf8"));
  if (plan.scenario !== WORKFLOW_PREFIX || plan.anchor_date !== "2026-10-07" || !Array.isArray(plan.sales)) {
    throw new Error("MANIFEST_IDENTITY_MISMATCH");
  }
  const originalPgs = new Set(original.map((row) => row.pgNo));
  if (plan.sales.length !== 24 || plan.sales.filter((row) => row.return).length !== 4 ||
      new Set(plan.sales.map((row) => row.pg_no)).size !== 24 ||
      plan.sales.some((row, index) => !/^[A-Z]{2}\d{10}$/u.test(row.pg_no) ||
        originalPgs.has(row.pg_no) || !originalPgs.has(row.reference_pg_no) ||
        row.sold_days_before_anchor !== 168 - index * 7 || typeof row.return !== "boolean")) {
    throw new Error("MANIFEST_ROWS_INVALID");
  }
  return plan.sales;
}

function plus(date, milliseconds) { return new Date(date.getTime() + milliseconds); }
function saleDate(daysBeforeAnchor) {
  return new Date(Date.parse("2026-10-07T03:00:00.000Z") - daysBeforeAnchor * DAY);
}
function demoImei(index) {
  const body = `99000000${String(index + 1001).padStart(6, "0")}`;
  const sum = [...body].reduce((total, digit, position) => {
    let value = Number(digit) * (position % 2 === 1 ? 2 : 1);
    if (value > 9) value -= 9;
    return total + value;
  }, 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

function priceFor(model, grade, index) {
  let base = /Fold/u.test(model) ? 910_000 : /S25 Ultra/u.test(model) ? 880_000
    : /S24 Ultra/u.test(model) ? 780_000 : /S23 Ultra/u.test(model) ? 640_000
      : /Flip7/u.test(model) ? 650_000 : /Flip6/u.test(model) ? 540_000
        : /S25/u.test(model) ? 630_000 : /S24/u.test(model) ? 520_000
          : /S23/u.test(model) ? 400_000 : 220_000;
  if (grade === "A-") base -= 30_000;
  if (grade === "B+") base -= 60_000;
  if (grade === "B") base -= 90_000;
  const purchase = Math.max(100_000, base + (index % 3) * 10_000);
  return { purchase, sale: purchase + 80_000 + (index % 4) * 20_000 };
}

async function one(client, sql, values, label) {
  const { rows } = await client.query(sql, values);
  if (rows.length !== 1) throw new Error(`${label}_ROW_COUNT ${rows.length}`);
  return rows[0];
}

async function originalRows(client, inputRows) {
  const { rows } = await client.query(`
    SELECT d.pg_no, d.model, d.model_code, d.model_seq, d.imei, d.warranty, d.inventory_sku_id,
      d.storage, d.color, d.sale_grade,
      i.inventory_status, i.stocked_at, ib.inbound_id, ib.purchase_price,
      ib.price_agreed_at, ib.purchase_price_entry_mode, ib.note
    FROM devices d JOIN inventory i USING (pg_no)
      JOIN inbounds ib ON ib.pg_no=d.pg_no AND ib.note=$2
    WHERE d.pg_no=ANY($1::text[]) ORDER BY d.pg_no FOR UPDATE OF d, i, ib
  `, [inputRows.map((row) => row.pgNo), INVENTORY_PREFIX]);
  if (rows.length !== 43) throw new Error(`ORIGINAL_SEED_ROWS_MISSING ${rows.length}`);
  const byPg = new Map(rows.map((row) => [row.pg_no, row]));
  for (const row of inputRows) {
    const actual = byPg.get(row.pgNo);
    if (!actual || actual.model !== row.model || actual.model_code !== row.modelCode ||
        actual.inventory_status !== row.status || !actual.inventory_sku_id ||
        !Number.isInteger(actual.model_seq) || !actual.imei) {
      throw new Error(`ORIGINAL_SEED_CHANGED ${row.pgNo}`);
    }
  }
  return byPg;
}

async function assertOriginalMovements(client, inputRows) {
  const { rows } = await client.query(`
    SELECT pg_no, count(*)::int AS count,
      count(*) FILTER (WHERE source_type='DEMO_INVENTORY_SEED'
        AND operation_key=$2 || ':' || pg_no)::int AS seed_count
    FROM inventory_quantity_movements WHERE pg_no=ANY($1::text[]) GROUP BY pg_no
  `, [inputRows.map((row) => row.pgNo), INVENTORY_PREFIX]);
  if (rows.length !== 43 || rows.some((row) => row.seed_count !== 1 || row.count !== 1)) {
    throw new Error("ORIGINAL_MOVEMENT_SET_CHANGED");
  }
}

async function lockModelAndBalances(client, inputRows, historical, original) {
  const models = [...new Set(historical.map((row) => original.get(row.reference_pg_no).model))].sort();
  for (const model of models) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`model-sequence:${model}`]);
  }
  const keys = new Set();
  for (const row of inputRows) {
    const sku = original.get(row.pgNo).inventory_sku_id;
    for (const status of [row.status, "SELLABLE", ...OPEN_STATUSES]) keys.add(`${sku}:${status}`);
  }
  for (const row of historical) {
    const sku = original.get(row.reference_pg_no).inventory_sku_id;
    for (const status of ["SELLABLE", "RESERVED", "PACKING", "PACKED", "DEPARTURE", "DELIVERING", "FINAL_DELIVERY", "RETURN_REQUESTED", "RETURN_CHECK", "EXCHANGE_REQUESTED"]) {
      keys.add(`${sku}:${status}`);
    }
  }
  for (const key of [...keys].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory-quantity-balance:${key}`]);
  }
}

async function allocateModelSeq(client, model) {
  const row = await one(client, `
    INSERT INTO model_sequences (model, last_seq, created_at, updated_at)
    SELECT $1, COALESCE(MAX(model_seq), 0) + 1, now(), now() FROM devices WHERE model=$1
    ON CONFLICT (model) DO UPDATE SET
      last_seq=GREATEST(model_sequences.last_seq, EXCLUDED.last_seq - 1) + 1,
      updated_at=EXCLUDED.updated_at RETURNING last_seq
  `, [model], "MODEL_SEQUENCE");
  return row.last_seq;
}

async function balanceDelta(client, { skuId, status, delta, pgNo, operationKey, movementType, occurredAt }) {
  await client.query(`
    INSERT INTO inventory_quantity_balances (inventory_sku_id, inventory_status, quantity, version, last_movement_at)
    VALUES ($1,$2,0,0,$3) ON CONFLICT (inventory_sku_id, inventory_status) DO NOTHING
  `, [skuId, status, occurredAt]);
  const balance = await one(client, `
    SELECT inventory_quantity_balance_id, quantity FROM inventory_quantity_balances
    WHERE inventory_sku_id=$1 AND inventory_status=$2 FOR UPDATE
  `, [skuId, status], "BALANCE");
  if (balance.quantity + delta < 0) throw new Error(`NEGATIVE_BALANCE ${skuId}:${status}`);
  await client.query(`
    UPDATE inventory_quantity_balances SET quantity=quantity+$1, version=version+1,
      last_movement_at=$2, updated_at=now() WHERE inventory_quantity_balance_id=$3
  `, [delta, occurredAt, balance.inventory_quantity_balance_id]);
  await client.query(`
    INSERT INTO inventory_quantity_movements
      (inventory_quantity_balance_id, operation_key, idempotency_key, movement_type,
       pg_no, quantity_delta, before_quantity, after_quantity, source_type, source_id,
       reason, occurred_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DEMO_WORKFLOW_SEED',$5,'해커톤 시연 업무 이력',$9)
  `, [balance.inventory_quantity_balance_id, operationKey,
    `${operationKey}:${delta > 0 ? `IN:${status}` : `OUT:${status}`}`,
    movementType, pgNo, delta, balance.quantity, balance.quantity + delta, occurredAt]);
}

async function transfer(client, skuId, pgNo, from, to, at, step) {
  const operationKey = `${WORKFLOW_PREFIX}:${pgNo}:STATUS:${step}`;
  await balanceDelta(client, { skuId, status: from, delta: -1, pgNo, operationKey,
    movementType: "STATUS_TRANSFER", occurredAt: at });
  await balanceDelta(client, { skuId, status: to, delta: 1, pgNo, operationKey,
    movementType: "STATUS_TRANSFER", occurredAt: at });
  await client.query("UPDATE inventory SET inventory_status=$1, updated_at=$2, revision=revision+1 WHERE pg_no=$3",
    [to, at, pgNo]);
}

async function ensureOffer(client, skuId, mappingAt) {
  const sku = await one(client, `
    SELECT model_option_id, storage_option_id, color_option_id FROM inventory_skus WHERE inventory_sku_id=$1
  `, [skuId], "SKU");
  const warranty = await one(client, `
    SELECT option_id FROM product_criteria_options
    WHERE category='WARRANTY_GROUP' AND option_key='1Y' AND is_active=1
  `, [], "WARRANTY_OPTION");
  const offerCode = `${WORKFLOW_PREFIX}:SKU:${skuId}`;
  await client.query(`
    INSERT INTO sales_offers (offer_code, model_option_id, storage_match_mode, storage_option_id,
      color_match_mode, color_option_id, warranty_group_option_id, created_at, updated_at)
    VALUES ($1,$2,'EXACT',$3,'EXACT',$4,$5,$6,$6) ON CONFLICT (offer_code) DO NOTHING
  `, [offerCode, sku.model_option_id, sku.storage_option_id, sku.color_option_id, warranty.option_id, mappingAt]);
  const offer = await one(client, "SELECT sales_offer_id FROM sales_offers WHERE offer_code=$1", [offerCode], "OFFER");
  const vendorItem = `${WORKFLOW_PREFIX}:ITEM:${skuId}`;
  await client.query(`
    INSERT INTO sales_channel_product_mappings
      (channel, external_vendor_item_id, external_option_name, sales_offer_id,
       mapping_status, mapped_at, created_at, updated_at)
    VALUES ('COUPANG',$1,'시연 상품 옵션',$2,'MAPPED',$3,$3,$3)
    ON CONFLICT (channel, external_vendor_item_id) DO NOTHING
  `, [vendorItem, offer.sales_offer_id, mappingAt]);
  return { offerId: offer.sales_offer_id, vendorItem };
}

async function insertOrder(client, { pgNo, model, storage, color, skuId, orderedAt, soldAt,
  salesPrice, sequence, openStatus }) {
  const externalOrderId = `${WORKFLOW_PREFIX}:ORDER:${sequence}`;
  const externalShipmentId = `${WORKFLOW_PREFIX}:SHIP:${sequence}`;
  const { offerId, vendorItem } = await ensureOffer(client, skuId, orderedAt);
  const channelStatus = !openStatus ? "FINAL_DELIVERY"
    : openStatus === "DELIVERING" || openStatus === "NONE_TRACKING" ? "DELIVERING" : "INSTRUCT";
  await client.query(`
    INSERT INTO coupang_order_raw
      (external_order_id, external_shipment_id, external_order_status, ordered_at,
       paid_at, orderer_name, receiver_name, receiver_safe_number, receiver_address_1,
       receiver_post_code, delivery_company_name, invoice_number, delivered_at,
       delivery_occurred_at, delivery_time_source, synced_at, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,'00000','시연택배',$9,$10,$10,$11,$12,$12,$12)
  `, [externalOrderId, externalShipmentId, channelStatus, orderedAt, plus(orderedAt, 60_000),
    `시연 고객 ${String(sequence).padStart(2, "0")}`, `0504-0000-${String(sequence).padStart(4, "0")}`,
    "서울특별시 시연구 데모로 1", openStatus ? null : `DEMO-${String(sequence).padStart(6, "0")}`,
    soldAt, openStatus ? null : "COUPANG_DELIVERED_DATE", orderedAt]);
  await client.query(`
    INSERT INTO order_matching_work_queue
      (channel, external_order_id, external_shipment_id, external_vendor_item_id,
       vendor_item_name, seller_product_name, seller_product_item_name, sales_price,
       ordered_quantity, matchable_quantity, ordered_at, mapping_status,
       sales_offer_id, required_model_label, required_storage_label,
       required_color_label, required_warranty_group, work_status, matched_at,
       created_at, updated_at)
    VALUES ('COUPANG',$1,$2,$3,$4,$4,$4,$5,1,1,$6,'MAPPED',$7,$8,$9,$10,'1년 보증','MATCHED',$6,$6,$6)
  `, [externalOrderId, externalShipmentId, vendorItem, `${model} ${storage} ${color}`,
    salesPrice, orderedAt, offerId, model, storage, color]);
  const allocation = await one(client, `
    INSERT INTO match_worker_allocation
      (external_order_id, external_shipment_id, external_vendor_item_id,
       vendor_item_name, pg_no, allocation_status, sales_offer_id, inventory_sku_id,
       required_model, required_storage, required_color, required_warranty_group,
       inventory_status_before_allocation, allocated_at, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,'API_ACKED',$6,$7,$8,$9,$10,'1Y','SELLABLE',$11,$11,$11)
    RETURNING allocation_id
  `, [externalOrderId, externalShipmentId, vendorItem, `${model} ${storage} ${color}`,
    pgNo, offerId, skuId, model, storage, color, orderedAt], "ALLOCATION");
  return { externalOrderId, externalShipmentId, vendorItem, allocationId: allocation.allocation_id, offerId };
}

async function insertInspection(client, { pgNo, inboundId, checkedAt, grade, defect, type = "APPEARANCE",
  returnAllocationId = null }) {
  await client.query(`
    INSERT INTO inspections
      (pg_no, inbound_id, inspection_type, inspection_result, source_type,
       coupang_return_allocation_id, checked_at, appearance_checked_at,
       appearance_grade, appearance_defect, return_yn, note, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,'N',$10,$7)
  `, [pgNo, type === "RETURN_CHECK" ? null : inboundId, type, "PASSED",
    type === "RETURN_CHECK" ? "COUPANG_RETURN" : "INBOUND", returnAllocationId,
    checkedAt, grade, defect, WORKFLOW_PREFIX]);
}

async function seedOriginalPurchases(client, inputRows, original) {
  for (const [index, row] of inputRows.entries()) {
    const current = original.get(row.pgNo);
    const agreedAt = plus(row.stockedAt, 2 * 3_600_000);
    const checkedAt = plus(row.stockedAt, 30 * 60_000);
    const { purchase } = priceFor(row.model, row.grade, index);
    await client.query(`
      UPDATE inbounds SET supplier_name=$1, purchase_price=$2,
        purchase_price_entry_mode='MANUAL', price_agreed_at=$3,
        purchase_price_updated_at=$3, updated_at=now()
      WHERE inbound_id=$4 AND purchase_price IS NULL AND price_agreed_at IS NULL
    `, [SUPPLIERS[index % SUPPLIERS.length], purchase, agreedAt, current.inbound_id]);
    await client.query("UPDATE devices SET warranty='1년 보증', revision=revision+1, updated_at=now() WHERE pg_no=$1 AND warranty IS NULL", [row.pgNo]);
    await insertInspection(client, { pgNo: row.pgNo, inboundId: current.inbound_id,
      checkedAt, grade: row.grade, defect: row.status === "DEFECTIVE" ? "생활 흠집" : null });
    const movement = await client.query(`
      UPDATE inventory_quantity_movements SET occurred_at=$1
      WHERE pg_no=$2 AND source_type='DEMO_INVENTORY_SEED'
        AND operation_key=$3 || ':' || $2 RETURNING inventory_quantity_movement_id
    `, [row.stockedAt, row.pgNo, INVENTORY_PREFIX]);
    if (movement.rowCount !== 1) throw new Error(`ORIGINAL_MOVEMENT_UPDATE_FAILED ${row.pgNo}`);
  }
}

async function seedReturn(client, { row, order, soldAt, inboundId, grade, sequence }) {
  const claimAt = plus(soldAt, 2 * DAY);
  const checkedAt = plus(claimAt, DAY);
  const receiptId = `${WORKFLOW_PREFIX}:RETURN:${sequence}`;
  const reason = sequence % 2 === 0
    ? { code: "DEFECT", label: "작동 불량", category: "상품 문제", detail: "충전 불량", fault: "VENDOR" }
    : { code: "CHANGE_MIND", label: "단순 변심", category: "고객 사유", detail: "구매 의사 변경", fault: "CUSTOMER" };
  const raw = await one(client, `
    INSERT INTO coupang_return_raw
      (external_receipt_id, external_order_id, external_shipment_id,
       cancel_type, return_receipt_status, return_release_status,
       reason_code, reason_label, reason_category, reason_detail,
       cancel_count, synced_at, created_at, updated_at)
    VALUES ($1,$2,$3,'RETURN','RETURNS_COMPLETED','COMPLETED',$4,$5,$6,$7,1,$8,$8,$8)
    RETURNING coupang_return_raw_id
  `, [receiptId, order.externalOrderId, order.externalShipmentId, reason.code,
    reason.label, reason.category, reason.detail, claimAt], "RETURN_RAW");
  await client.query(`
    INSERT INTO coupang_return_raw_item
      (coupang_return_raw_id, external_receipt_id, external_order_id,
       external_shipment_id, external_vendor_item_id, vendor_item_name,
       cancel_count, reason_code, reason_label, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$9)
  `, [raw.coupang_return_raw_id, receiptId, order.externalOrderId,
    order.externalShipmentId, order.vendorItem, `${row.model} ${row.storage}`,
    reason.code, reason.label, claimAt]);
  const event = await one(client, `
    INSERT INTO coupang_raw_change_event
      (source_table, source_pk, external_order_id, external_shipment_id,
       external_receipt_id, event_type, change_hash, process_status,
       detected_at, processed_at, created_at, updated_at)
    VALUES ('coupang_return_raw',$1,$2,$3,$1,'COUPANG_RETURN_OBSERVED',
      $4,'DONE',$5,$5,$5,$5) RETURNING coupang_raw_change_event_id
  `, [receiptId, order.externalOrderId, order.externalShipmentId,
    `${WORKFLOW_PREFIX}:EVENT:${sequence}`, claimAt], "RETURN_EVENT");
  const snapshot = {
    external_created_at: claimAt.toISOString(),
    external_modified_at: checkedAt.toISOString(),
    external_completed_at: checkedAt.toISOString(),
    external_completion_type: "VENDOR_CONFIRM",
    receipt_type: "RETURN", receipt_status: "RETURNS_COMPLETED", release_status: "COMPLETED",
    fault_by_type: reason.fault, reason_code: reason.code, reason_label: reason.label,
    reason_category: reason.category, reason_detail: reason.detail, cancel_count: "1",
    items_json: JSON.stringify([{ externalVendorItemId: order.vendorItem,
      sellerProductItemId: null, vendorItemName: `${row.model} ${row.storage}`, cancelCount: 1 }]),
  };
  for (const [field, value] of Object.entries(snapshot)) {
    await client.query(`
      INSERT INTO coupang_raw_change_event_field
        (raw_change_event_id, field_name, before_value, after_value, created_at)
      VALUES ($1,$2,NULL,$3,$4)
    `, [event.coupang_raw_change_event_id, field, value, claimAt]);
  }
  const link = await one(client, `
    INSERT INTO coupang_return_allocation
      (coupang_return_raw_id, allocation_id, external_receipt_id,
       external_order_id, external_shipment_id, external_vendor_item_id,
       pg_no, action_type, linked_at, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'approve',$8,$8,$8)
    RETURNING coupang_return_allocation_id
  `, [raw.coupang_return_raw_id, order.allocationId, receiptId,
    order.externalOrderId, order.externalShipmentId, order.vendorItem,
    row.pgNo, claimAt], "RETURN_ALLOCATION");
  await insertInspection(client, { pgNo: row.pgNo, inboundId, checkedAt,
    grade, defect: reason.fault === "VENDOR" ? "충전 불량" : null,
    type: "RETURN_CHECK", returnAllocationId: link.coupang_return_allocation_id });
  await transfer(client, row.skuId, row.pgNo, "FINAL_DELIVERY", "RETURN_REQUESTED", claimAt, "RETURN_REQUESTED");
  await transfer(client, row.skuId, row.pgNo, "RETURN_REQUESTED", "RETURN_CHECK", checkedAt, "RETURN_CHECK");
}

async function seedExchange(client, { row, order, soldAt, sequence }) {
  const requestedAt = plus(soldAt, 3 * DAY);
  const exchangeId = `${WORKFLOW_PREFIX}:EXCHANGE:${sequence}`;
  const raw = await one(client, `
    INSERT INTO coupang_exchange_raw
      (external_exchange_id, external_order_id, external_shipment_id,
       exchange_status, reason_code, reason_label, synced_at, created_at, updated_at)
    VALUES ($1,$2,$3,'RECEIPT','COLOR_CHANGE','색상 변경 요청',$4,$4,$4)
    RETURNING coupang_exchange_raw_id
  `, [exchangeId, order.externalOrderId, order.externalShipmentId, requestedAt], "EXCHANGE_RAW");
  await client.query(`
    INSERT INTO coupang_exchange_shipment_scope
      (coupang_exchange_raw_id, external_exchange_id, external_order_id,
       external_shipment_id, created_at)
    VALUES ($1,$2,$3,$4,$5)
  `, [raw.coupang_exchange_raw_id, exchangeId,
    order.externalOrderId, order.externalShipmentId, requestedAt]);
  const event = await one(client, `
    INSERT INTO coupang_raw_change_event
      (source_table, source_pk, external_order_id, external_shipment_id,
       external_exchange_id, event_type, change_hash, process_status,
       detected_at, processed_at, created_at, updated_at)
    VALUES ('coupang_exchange_raw',$1,$2,$3,$1,'COUPANG_EXCHANGE_OBSERVED',
      $4,'DONE',$5,$5,$5,$5) RETURNING coupang_raw_change_event_id
  `, [exchangeId, order.externalOrderId, order.externalShipmentId,
    `${WORKFLOW_PREFIX}:EXCHANGE_EVENT:${sequence}`, requestedAt], "EXCHANGE_EVENT");
  const snapshot = {
    external_created_at: requestedAt.toISOString(),
    external_modified_at: requestedAt.toISOString(),
    exchange_status: "RECEIPT", fault_by_type: "CUSTOMER",
    reason_code: "COLOR_CHANGE", reason_label: "색상 변경 요청", reason_detail: "다른 색상 희망",
  };
  for (const [field, value] of Object.entries(snapshot)) {
    await client.query(`
      INSERT INTO coupang_raw_change_event_field
        (raw_change_event_id, field_name, before_value, after_value, created_at)
      VALUES ($1,$2,NULL,$3,$4)
    `, [event.coupang_raw_change_event_id, field, value, requestedAt]);
  }
  await transfer(client, row.skuId, row.pgNo,
    "FINAL_DELIVERY", "EXCHANGE_REQUESTED", requestedAt, "EXCHANGE_REQUESTED");
}

async function seedHistoricalSales(client, manifest, original) {
  for (const [index, scenario] of manifest.entries()) {
    const reference = original.get(scenario.reference_pg_no);
    const soldAt = saleDate(scenario.sold_days_before_anchor);
    const receivedAt = plus(soldAt, -10 * DAY);
    const inspectedAt = plus(soldAt, -9 * DAY);
    const agreedAt = plus(soldAt, -8 * DAY);
    const stockedAt = plus(soldAt, -7 * DAY);
    const orderedAt = plus(soldAt, -3 * DAY);
    const purchaseAndSale = priceFor(reference.model, reference.sale_grade, index + 43);
    const skuId = reference.inventory_sku_id;
    const modelSeq = await allocateModelSeq(client, reference.model);
    const imei = demoImei(index);
    await client.query(`
      INSERT INTO devices (pg_no, imei, model, model_code, model_seq, storage,
        color, sale_grade, warranty, inventory_sku_id, created_at, updated_at)
      SELECT $1,$2,model,model_code,$3,storage,color,sale_grade,'1년 보증',
        inventory_sku_id,$4,$4 FROM devices WHERE pg_no=$5
    `, [scenario.pg_no, imei, modelSeq, receivedAt, scenario.reference_pg_no]);
    const inbound = await one(client, `
      INSERT INTO inbounds
        (pg_no, supplier_name, purchase_price, purchase_price_entry_mode,
         received_at, price_agreed_at, purchase_price_updated_at,
         inbound_status, note, created_at, updated_at)
      VALUES ($1,$2,$3,'MANUAL',$4,$5,$5,'PURCHASED',$6,$4,$5)
      RETURNING inbound_id
    `, [scenario.pg_no, SUPPLIERS[index % SUPPLIERS.length], purchaseAndSale.purchase,
      receivedAt, agreedAt, WORKFLOW_PREFIX], "HISTORICAL_INBOUND");
    await insertInspection(client, { pgNo: scenario.pg_no, inboundId: inbound.inbound_id,
      checkedAt: inspectedAt, grade: reference.sale_grade,
      defect: reference.sale_grade === "B" ? "생활 흠집" : null });
    await client.query(`
      INSERT INTO inventory (pg_no, inventory_status, location, stocked_at, created_at, updated_at)
      VALUES ($1,'SELLABLE','시연 판매 재고',$2,$2,$2)
    `, [scenario.pg_no, stockedAt]);
    await balanceDelta(client, { skuId, status: "SELLABLE", delta: 1, pgNo: scenario.pg_no,
      operationKey: `${WORKFLOW_PREFIX}:${scenario.pg_no}:CREATE`, movementType: "INVENTORY_CREATED",
      occurredAt: stockedAt });
    const row = { pgNo: scenario.pg_no, model: reference.model, storage: reference.storage,
      color: reference.color, skuId };
    const order = await insertOrder(client, { ...row, orderedAt, soldAt,
      salesPrice: purchaseAndSale.sale, sequence: index + 1, openStatus: null });
    const path = ["RESERVED", "PACKING", "PACKED", "DEPARTURE", "DELIVERING", "FINAL_DELIVERY"];
    const transitionTimes = [orderedAt, plus(orderedAt, 3_600_000), plus(orderedAt, 4 * 3_600_000),
      plus(orderedAt, DAY), plus(orderedAt, 2 * DAY), soldAt];
    let status = "SELLABLE";
    for (const [step, next] of path.entries()) {
      await transfer(client, skuId, scenario.pg_no, status, next, transitionTimes[step], next);
      status = next;
    }
    await client.query(`
      INSERT INTO sales_records
        (allocation_id, pg_no, sales_offer_id, inventory_sku_id, channel,
         external_order_id, external_shipment_id, external_vendor_item_id,
         sold_at, sale_status, sales_price, purchase_price, purchase_inbound_id,
         supplier_name, purchase_agreed_at, model, storage, color, sale_grade,
         warranty_group, created_at, updated_at)
      VALUES ($1,$2,$3,$4,'COUPANG',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'1년 보증',$8,$8)
    `, [order.allocationId, scenario.pg_no, order.offerId, skuId,
      order.externalOrderId, order.externalShipmentId, order.vendorItem, soldAt,
      scenario.return ? "RETURNED" : "SOLD", purchaseAndSale.sale, purchaseAndSale.purchase,
      inbound.inbound_id, SUPPLIERS[index % SUPPLIERS.length], agreedAt,
      reference.model, reference.storage, reference.color, reference.sale_grade]);
    if (scenario.return) await seedReturn(client, { row, order, soldAt,
      inboundId: inbound.inbound_id, grade: reference.sale_grade, sequence: index + 1 });
    if (index === 20) await seedExchange(client, { row, order, soldAt, sequence: index + 1 });
  }
}

async function seedOpenOrders(client, originalInput, original, now) {
  const sellable = originalInput.filter((row) => row.status === "SELLABLE").slice(0, 8);
  if (sellable.length !== 8) throw new Error("OPEN_ORDER_SOURCE_MISSING");
  for (const [index, row] of sellable.entries()) {
    const reference = original.get(row.pgNo);
    const orderedAt = plus(now, -3_600_000 + index * 60_000);
    const { sale } = priceFor(row.model, row.grade, index);
    await insertOrder(client, { pgNo: row.pgNo, model: row.model, storage: row.storage,
      color: row.color, skuId: reference.inventory_sku_id, orderedAt,
      soldAt: null, salesPrice: sale, sequence: index + 25, openStatus: OPEN_STATUSES[index] });
    const path = ["RESERVED", "PACKING", "PACKED"];
    const target = OPEN_STATUSES[index];
    let current = "SELLABLE";
    for (const [step, next] of path.entries()) {
      await transfer(client, reference.inventory_sku_id, row.pgNo, current, next,
        plus(orderedAt, step * 10 * 60_000), next);
      current = next;
      if (next === target) break;
    }
  }
}

async function seedSnapshotOrders(client, originalInput, original) {
  const snapshotRows = originalInput
    .map((row, index) => ({ ...row, originalIndex: index }))
    .filter((row) => SNAPSHOT_ORDER_STATUSES.has(row.status));
  if (snapshotRows.length !== 14) throw new Error("SNAPSHOT_ORDER_COVERAGE_MISMATCH");
  for (const [index, row] of snapshotRows.entries()) {
    const current = original.get(row.pgNo);
    const orderedAt = plus(row.stockedAt, 3 * 3_600_000);
    const soldAt = row.status === "FINAL_DELIVERY" ? plus(row.stockedAt, 6 * 3_600_000) : null;
    const prices = priceFor(row.model, row.grade, row.originalIndex);
    const order = await insertOrder(client, { pgNo: row.pgNo, model: row.model,
      storage: row.storage, color: row.color, skuId: current.inventory_sku_id,
      orderedAt, soldAt, salesPrice: prices.sale, sequence: index + 33,
      openStatus: soldAt ? null : row.status });
    if (soldAt) {
      await client.query(`
        INSERT INTO sales_records
          (allocation_id, pg_no, sales_offer_id, inventory_sku_id, channel,
           external_order_id, external_shipment_id, external_vendor_item_id,
           sold_at, sale_status, sales_price, purchase_price, purchase_inbound_id,
           supplier_name, purchase_agreed_at, model, storage, color, sale_grade,
           warranty_group, created_at, updated_at)
        VALUES ($1,$2,$3,$4,'COUPANG',$5,$6,$7,$8,'SOLD',$9,$10,$11,$12,$13,$14,$15,$16,$17,'1년 보증',$8,$8)
      `, [order.allocationId, row.pgNo, order.offerId, current.inventory_sku_id,
        order.externalOrderId, order.externalShipmentId, order.vendorItem,
        soldAt, prices.sale, prices.purchase, current.inbound_id,
        SUPPLIERS[row.originalIndex % SUPPLIERS.length], plus(row.stockedAt, 2 * 3_600_000),
        row.model, row.storage, row.color, row.grade]);
    }
  }
}

async function assertBalancesConsistent(client, skuIds) {
  const { rows } = await client.query(`
    WITH actual AS (
      SELECT d.inventory_sku_id AS sku_id, i.inventory_status AS status, count(*)::int AS quantity
      FROM inventory i JOIN devices d USING (pg_no)
      WHERE d.inventory_sku_id=ANY($1::int[])
      GROUP BY d.inventory_sku_id, i.inventory_status
    ), balances AS (
      SELECT inventory_sku_id AS sku_id, inventory_status AS status, quantity
      FROM inventory_quantity_balances WHERE inventory_sku_id=ANY($1::int[])
    )
    SELECT COALESCE(a.sku_id,b.sku_id) AS sku_id, COALESCE(a.status,b.status) AS status,
      COALESCE(a.quantity,0) AS actual, COALESCE(b.quantity,0) AS balance
    FROM actual a FULL OUTER JOIN balances b USING (sku_id,status)
    WHERE COALESCE(a.quantity,0)<>COALESCE(b.quantity,0) LIMIT 5
  `, [skuIds]);
  if (rows.length) throw new Error(`INVENTORY_BALANCE_MISMATCH ${JSON.stringify(rows)}`);
}

async function rebaseDemoMovementTimeline(client, skuIds) {
  // The inventory statistics and ledger audit treat movement IDs as append order.
  // These SKUs contain only the original demonstration seed before this run, so
  // give the synthetic history fresh IDs in business-time order as well.
  const { rows: globalTail } = await client.query(
    "SELECT COALESCE(MAX(inventory_quantity_movement_id),0)::int AS id FROM inventory_quantity_movements",
  );
  const maxExistingId = globalTail[0].id;
  const { rows: movements } = await client.query(`
    SELECT m.inventory_quantity_movement_id AS id, m.inventory_quantity_balance_id AS balance_id,
      m.quantity_delta AS delta, m.before_quantity AS before_quantity,
      m.after_quantity AS after_quantity, m.occurred_at AS occurred_at
    FROM inventory_quantity_movements m
      JOIN inventory_quantity_balances b USING (inventory_quantity_balance_id)
    WHERE b.inventory_sku_id=ANY($1::int[])
    ORDER BY m.occurred_at, m.inventory_quantity_movement_id
  `, [skuIds]);
  const running = new Map();
  const lastAt = new Map();
  for (const movement of movements) {
    const before = running.get(movement.balance_id) ?? 0;
    const after = before + movement.delta;
    if (after < 0) throw new Error(`HISTORICAL_LEDGER_NEGATIVE ${movement.balance_id}`);
    const assigned = await one(client, `
      SELECT nextval(pg_get_serial_sequence('inventory_quantity_movements',
        'inventory_quantity_movement_id'))::int AS id
    `, [], "MOVEMENT_SEQUENCE");
    if (assigned.id <= maxExistingId) throw new Error("MOVEMENT_SEQUENCE_BEHIND_TABLE");
    await client.query(`
      UPDATE inventory_quantity_movements
      SET inventory_quantity_movement_id=$1, before_quantity=$2, after_quantity=$3
      WHERE inventory_quantity_movement_id=$4
    `, [assigned.id, before, after, movement.id]);
    running.set(movement.balance_id, after);
    lastAt.set(movement.balance_id, movement.occurred_at);
  }
  const { rows: balances } = await client.query(`
    SELECT inventory_quantity_balance_id AS id, quantity FROM inventory_quantity_balances
    WHERE inventory_sku_id=ANY($1::int[])
  `, [skuIds]);
  for (const balance of balances) {
    if ((running.get(balance.id) ?? 0) !== balance.quantity) {
      throw new Error(`HISTORICAL_LEDGER_TOTAL_MISMATCH ${balance.id}`);
    }
    if (lastAt.has(balance.id)) {
      await client.query(`
        UPDATE inventory_quantity_balances SET last_movement_at=$1
        WHERE inventory_quantity_balance_id=$2
      `, [lastAt.get(balance.id), balance.id]);
    }
  }
}

async function count(client, table, column, prefix) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM ${table} WHERE left(${column},length($1))=$1`, [prefix],
  );
  return rows[0].count;
}

async function staleStatisticsSnapshots(client, inputRows, manifest) {
  // All original inbounds receive updated_at=now() in seedOriginalPurchases.
  // This is the durable seed watermark on reruns; snapshots completed before
  // it were calculated without the newly added workflow rows.
  const watermark = await one(client, `
    SELECT min(updated_at) AS seeded_at FROM inbounds
    WHERE pg_no=ANY($1::text[]) AND note=$2
  `, [inputRows.map((row) => row.pgNo), INVENTORY_PREFIX], "SEED_WATERMARK");
  if (!watermark.seeded_at) throw new Error("SEED_WATERMARK_MISSING");
  const earliestPurchaseDate = plus(saleDate(manifest[0].sold_days_before_anchor), -10 * DAY)
    .toISOString().slice(0, 10);
  const { rows } = await client.query(`
    SELECT snapshot_batch_id FROM statistics_snapshot_batches
    WHERE status='COMPLETE' AND completed_at < $1
      AND data_cutoff_date >= $2::date
    ORDER BY snapshot_batch_id
  `, [watermark.seeded_at, earliestPurchaseDate]);
  return rows.map((row) => row.snapshot_batch_id);
}

async function supersedeStaleStatisticsSnapshots(client, inputRows, manifest) {
  const ids = await staleStatisticsSnapshots(client, inputRows, manifest);
  if (ids.length === 0) return 0;
  const result = await client.query(`
    UPDATE statistics_snapshot_batches
    SET status='SUPERSEDED', updated_at=now()
    WHERE snapshot_batch_id=ANY($1::int[]) AND status='COMPLETE'
  `, [ids]);
  if (result.rowCount !== ids.length) throw new Error("STATISTICS_SNAPSHOT_SUPERSEDE_RACE");
  return ids.length;
}

async function verifyScenario(client, inputRows, manifest) {
  const originalPgs = inputRows.map((row) => row.pgNo);
  const historicalPgs = manifest.map((row) => row.pg_no);
  const { rows: original } = await client.query(`
    SELECT d.pg_no, d.inventory_sku_id, d.model_seq, d.imei, d.warranty,
      i.inventory_status, ib.purchase_price, ib.price_agreed_at,
      ib.purchase_price_entry_mode,
      (SELECT count(*)::int FROM inspections x WHERE x.pg_no=d.pg_no AND x.note=$2) AS inspection_count
    FROM devices d JOIN inventory i USING (pg_no)
      JOIN inbounds ib ON ib.pg_no=d.pg_no AND ib.note=$3
    WHERE d.pg_no=ANY($1::text[])
  `, [originalPgs, WORKFLOW_PREFIX, INVENTORY_PREFIX]);
  const openPgs = inputRows.filter((row) => row.status === "SELLABLE").slice(0, 8).map((row) => row.pgNo);
  const openIndex = new Map(openPgs.map((pgNo, index) => [pgNo, index]));
  if (original.length !== 43 || original.some((row) => {
    const expectedStatus = openIndex.has(row.pg_no)
      ? OPEN_STATUSES[openIndex.get(row.pg_no)]
      : inputRows.find((source) => source.pgNo === row.pg_no)?.status;
    return row.inventory_status !== expectedStatus || !row.inventory_sku_id ||
      !Number.isInteger(row.model_seq) || !row.imei || row.warranty !== "1년 보증" ||
      !Number.isInteger(row.purchase_price) || row.purchase_price <= 0 ||
      !row.price_agreed_at || row.purchase_price_entry_mode !== "MANUAL" || row.inspection_count !== 1;
  })) throw new Error("ORIGINAL_PURCHASE_VERIFICATION_FAILED");

  const { rows: historical } = await client.query(`
    SELECT d.pg_no, d.inventory_sku_id, d.model_seq, d.imei, d.warranty,
      i.inventory_status, ib.inbound_id, ib.purchase_price, ib.price_agreed_at,
      (SELECT count(*)::int FROM inspections x WHERE x.pg_no=d.pg_no AND x.note=$2) AS inspection_count,
      (SELECT count(*)::int FROM sales_records s WHERE s.pg_no=d.pg_no) AS sale_count
    FROM devices d JOIN inventory i USING (pg_no)
      JOIN inbounds ib ON ib.pg_no=d.pg_no AND ib.note=$2
    WHERE d.pg_no=ANY($1::text[])
  `, [historicalPgs, WORKFLOW_PREFIX]);
  const historicalByPg = new Map(historical.map((row) => [row.pg_no, row]));
  if (historical.length !== 24 || manifest.some((scenario, index) => {
    const row = historicalByPg.get(scenario.pg_no);
    return !row || !row.inventory_sku_id || !Number.isInteger(row.model_seq) ||
      row.imei !== demoImei(index) || row.warranty !== "1년 보증" ||
      row.inventory_status !== (scenario.return ? "RETURN_CHECK" : index === 20 ? "EXCHANGE_REQUESTED" : "FINAL_DELIVERY") ||
      !Number.isInteger(row.purchase_price) || row.purchase_price <= 0 ||
      !row.price_agreed_at || row.sale_count !== 1 ||
      row.inspection_count !== (scenario.return ? 2 : 1);
  })) throw new Error("HISTORICAL_DEVICE_VERIFICATION_FAILED");

  const expectedCounts = [
    ["orders", await count(client, "coupang_order_raw", "external_order_id", WORKFLOW_PREFIX), 46],
    ["allocations", await count(client, "match_worker_allocation", "external_order_id", WORKFLOW_PREFIX), 46],
    ["workItems", await count(client, "order_matching_work_queue", "external_order_id", WORKFLOW_PREFIX), 46],
    ["sales", await count(client, "sales_records", "external_order_id", WORKFLOW_PREFIX), 26],
    ["returns", await count(client, "coupang_return_raw", "external_receipt_id", WORKFLOW_PREFIX), 4],
    ["exchanges", await count(client, "coupang_exchange_raw", "external_exchange_id", WORKFLOW_PREFIX), 1],
    ["claimEvents", await count(client, "coupang_raw_change_event", "source_pk", WORKFLOW_PREFIX), 5],
    ["returnLinks", await count(client, "coupang_return_allocation", "external_receipt_id", WORKFLOW_PREFIX), 4],
  ];
  for (const [name, actual, expected] of expectedCounts) {
    if (actual !== expected) throw new Error(`COUNT_MISMATCH ${name} ${actual}/${expected}`);
  }
  const { rows: orphaned } = await client.query(`
    SELECT s.sale_record_id FROM sales_records s
      LEFT JOIN match_worker_allocation a ON a.allocation_id=s.allocation_id
      LEFT JOIN inbounds ib ON ib.inbound_id=s.purchase_inbound_id
    WHERE left(s.external_order_id,length($1))=$1
      AND (a.allocation_id IS NULL OR ib.inbound_id IS NULL OR
        ib.pg_no<>s.pg_no OR s.purchase_price IS NULL OR s.sales_price IS NULL)
    LIMIT 1
  `, [WORKFLOW_PREFIX]);
  if (orphaned.length) throw new Error("SALE_EVIDENCE_LINK_MISSING");
  const snapshotPgs = inputRows.filter((row) => SNAPSHOT_ORDER_STATUSES.has(row.status)).map((row) => row.pgNo);
  const { rows: snapshotLinks } = await client.query(`
    SELECT pg_no, count(*)::int AS count FROM match_worker_allocation
    WHERE pg_no=ANY($1::text[]) AND left(external_order_id,length($2))=$2
      AND allocation_status IN ('ALLOCATED','API_ACKED','SHIPMENT_LIST_PRINTED')
    GROUP BY pg_no
  `, [snapshotPgs, WORKFLOW_PREFIX]);
  if (snapshotLinks.length !== 14 || snapshotLinks.some((row) => row.count !== 1)) {
    throw new Error("SNAPSHOT_ORDER_LINK_VERIFICATION_FAILED");
  }
  await assertBalancesConsistent(client, [...new Set([...original, ...historical].map((row) => row.inventory_sku_id))]);
  return { verified: true, originalPurchases: 43, historicalSales: 24,
    snapshotSales: 2, returnedSales: 4, exchangeRequests: 1, orders: 46,
    snapshotOrders: 14, currentOpenOrders: 8,
    inventoryDevices: 67, inspections: 71 };
}

async function preflight(client, inputRows, manifest, original) {
  for (const row of original.values()) {
    if (row.purchase_price !== null || row.price_agreed_at !== null ||
        row.purchase_price_entry_mode !== null ||
        (row.warranty !== null && row.warranty !== "1년 보증")) {
      throw new Error(`ORIGINAL_PURCHASE_ALREADY_EDITED ${row.pg_no}`);
    }
  }
  await assertOriginalMovements(client, inputRows);
  const { rows: inspections } = await client.query(`
    SELECT pg_no FROM inspections WHERE pg_no=ANY($1::text[]) LIMIT 1
  `, [inputRows.map((row) => row.pgNo)]);
  if (inspections.length) throw new Error(`ORIGINAL_INSPECTION_ALREADY_EXISTS ${inspections[0].pg_no}`);
  const openPgs = inputRows.filter((row) => row.status === "SELLABLE").slice(0, 8).map((row) => row.pgNo);
  if (openPgs.length !== 8) throw new Error("OPEN_ORDER_SOURCE_MISSING");
  const snapshotPgs = inputRows.filter((row) => SNAPSHOT_ORDER_STATUSES.has(row.status)).map((row) => row.pgNo);
  const { rows: existingAllocations } = await client.query(
    "SELECT pg_no FROM match_worker_allocation WHERE pg_no=ANY($1::text[]) LIMIT 1", [[...openPgs, ...snapshotPgs]],
  );
  if (existingAllocations.length) throw new Error(`OPEN_ORDER_DEVICE_ALREADY_ALLOCATED ${existingAllocations[0].pg_no}`);
  const { rows: pgConflict } = await client.query(
    "SELECT pg_no FROM devices WHERE pg_no=ANY($1::text[]) LIMIT 1", [manifest.map((row) => row.pg_no)],
  );
  if (pgConflict.length) throw new Error(`HISTORICAL_PG_ALREADY_EXISTS ${pgConflict[0].pg_no}`);
  const { rows: imeiConflict } = await client.query(
    "SELECT pg_no FROM devices WHERE imei=ANY($1::text[]) LIMIT 1", [manifest.map((_, index) => demoImei(index))],
  );
  if (imeiConflict.length) throw new Error(`HISTORICAL_IMEI_ALREADY_EXISTS ${imeiConflict[0].pg_no}`);
  const { rows: warranty } = await client.query(`
    SELECT option_id FROM product_criteria_options
    WHERE category='WARRANTY_GROUP' AND option_key='1Y' AND is_active=1
  `);
  if (warranty.length !== 1) throw new Error("WARRANTY_OPTION_UNAVAILABLE");
  const skuIds = [...new Set([...original.values()].map((row) => row.inventory_sku_id))];
  const { rows: otherDevices } = await client.query(`
    SELECT pg_no FROM devices WHERE inventory_sku_id=ANY($1::int[])
      AND NOT (pg_no=ANY($2::text[])) LIMIT 1
  `, [skuIds, inputRows.map((row) => row.pgNo)]);
  if (otherDevices.length) throw new Error(`AFFECTED_SKU_HAS_OTHER_DEVICE ${otherDevices[0].pg_no}`);
  const { rows: otherMovements } = await client.query(`
    SELECT m.inventory_quantity_movement_id AS id FROM inventory_quantity_movements m
      JOIN inventory_quantity_balances b USING (inventory_quantity_balance_id)
    WHERE b.inventory_sku_id=ANY($1::int[]) AND m.source_type<>'DEMO_INVENTORY_SEED'
    LIMIT 1
  `, [skuIds]);
  if (otherMovements.length) throw new Error(`AFFECTED_SKU_HAS_OTHER_MOVEMENT ${otherMovements[0].id}`);
  await assertBalancesConsistent(client, skuIds);
}

async function main() {
  const argument = (name) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? "" : process.argv[index + 1];
  };
  const csvPath = argument("--csv");
  const manifestPath = argument("--manifest");
  if (!csvPath || !manifestPath) throw new Error("CSV_AND_MANIFEST_REQUIRED");
  const inputRows = csvRows(csvPath);
  const manifest = manifestRows(manifestPath, inputRows);
  if (process.argv.includes("--validate-plan")) {
    console.log(JSON.stringify({ planValid: true, existingInventory: 43,
      historicalSales: 24, returns: 4, exchanges: 1, snapshotOrders: 14, openOrders: 8 }));
    return;
  }

  const connectionString = resolvePostgresqlConnectionStringSync({
    role: "runtime", applicationName: "quickhack-hackathon-demo-workflows",
    runtimeConfigPath: "/etc/quickhack/demonstration-server/server-runtime.json",
  });
  const parsed = new URL(connectionString);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/quickhack" || parsed.username !== "quickhack_runtime") {
    throw new Error("INSTALLED_DEMONSTRATION_DATABASE_IDENTITY_MISMATCH");
  }
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 120_000 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_894_475_108]);
    const identity = await one(client, "SELECT current_database() AS database, current_user AS role", [], "DATABASE_IDENTITY");
    if (identity.database !== "quickhack" || identity.role !== "quickhack_runtime") {
      throw new Error("DATABASE_IDENTITY_MISMATCH");
    }
    const timeZone = (await one(client, "SELECT current_setting('TimeZone') AS timezone", [], "DATABASE_TIMEZONE")).timezone;
    const existing = await count(client, "coupang_order_raw", "external_order_id", WORKFLOW_PREFIX);
    if (process.argv.includes("--verify") || existing > 0) {
      if (existing === 0) throw new Error("WORKFLOW_SCENARIO_NOT_APPLIED");
      const report = await verifyScenario(client, inputRows, manifest);
      const staleSnapshotIds = await staleStatisticsSnapshots(client, inputRows, manifest);
      const supersededSnapshots = process.argv.includes("--apply")
        ? await supersedeStaleStatisticsSnapshots(client, inputRows, manifest) : 0;
      if (process.argv.includes("--verify") && staleSnapshotIds.length > 0) {
        throw new Error(`STATISTICS_SNAPSHOT_STILL_STALE ${staleSnapshotIds.length}`);
      }
      if (process.argv.includes("--apply")) await client.query("COMMIT");
      else await client.query("ROLLBACK");
      console.log(JSON.stringify({ ...report, databaseTimeZone: timeZone,
        alreadyApplied: true, staleStatisticsSnapshots: staleSnapshotIds.length,
        supersededStatisticsSnapshots: supersededSnapshots }));
      return;
    }
    const original = await originalRows(client, inputRows);
    await preflight(client, inputRows, manifest, original);
    if (!process.argv.includes("--apply")) {
      await client.query("ROLLBACK");
      console.log(JSON.stringify({ readyToApply: true, existingInventory: 43,
        historicalSales: 24, returns: 4, exchanges: 1, snapshotOrders: 14, openOrders: 8,
        databaseTimeZone: timeZone }));
      return;
    }
    await lockModelAndBalances(client, inputRows, manifest, original);
    await seedOriginalPurchases(client, inputRows, original);
    await seedHistoricalSales(client, manifest, original);
    await seedSnapshotOrders(client, inputRows, original);
    await seedOpenOrders(client, inputRows, original, new Date());
    await rebaseDemoMovementTimeline(client, [...new Set([...original.values()].map((row) => row.inventory_sku_id))]);
    const report = await verifyScenario(client, inputRows, manifest);
    const supersededSnapshots = await supersedeStaleStatisticsSnapshots(client, inputRows, manifest);
    await client.query("COMMIT");
    console.log(JSON.stringify({ applied: true, ...report, databaseTimeZone: timeZone,
      supersededStatisticsSnapshots: supersededSnapshots }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Demo workflow seed failed: ${error?.code || error?.message || String(error)}`);
  process.exitCode = 1;
});
