// One-off additive seed for the installed demonstration database.
// Run under a systemd unit with the quickhack.postgresql.runtime credential.
import fs from "node:fs";
import pg from "/usr/lib/quickhack/demonstration-server/node_modules/pg/lib/index.js";
import { resolvePostgresqlConnectionStringSync } from "/usr/lib/quickhack/demonstration-server/quickhack_server/core/database/postgresql-credential.mjs";

const COLUMNS = [
  "pg_no", "model_option_key", "model_name", "storage_option_key",
  "color_option_key", "sale_grade_option_key", "inventory_status", "location", "stocked_at",
];
const STATUSES = new Set([
  "SELLABLE", "RESERVED", "PACKING", "PACKED", "DEPARTURE", "DELIVERING",
  "FINAL_DELIVERY", "NONE_TRACKING", "HOLD", "DEFECTIVE",
  "RETURN_REQUESTED", "EXCHANGE_REQUESTED", "RETURN_CHECK",
]);
const CATEGORIES = ["PRODUCT_MODEL", "STORAGE", "DEVICE_COLOR", "SALE_GRADE"];
const PREFIX = "HACKATHON_DEMO_INVENTORY_20261008";

function loadCsv(filename) {
  const lines = fs.readFileSync(filename, "utf8").replace(/^\uFEFF/u, "").trimEnd().split(/\r?\n/u);
  if (lines[0] !== COLUMNS.join(",")) throw new Error("CSV_HEADER_MISMATCH");
  const rows = lines.slice(1).map((line, index) => {
    if (line.includes('"')) throw new Error(`CSV_QUOTED_FIELD_UNSUPPORTED row=${index + 2}`);
    const values = line.split(",");
    if (values.length !== COLUMNS.length) throw new Error(`CSV_COLUMN_COUNT_INVALID row=${index + 2}`);
    const row = Object.fromEntries(COLUMNS.map((column, columnIndex) => [column, values[columnIndex].trim()]));
    if (!/^[A-Z]{2}\d{10}$/u.test(row.pg_no)) throw new Error(`CSV_PG_INVALID row=${index + 2}`);
    if (!STATUSES.has(row.inventory_status)) throw new Error(`CSV_STATUS_INVALID row=${index + 2}`);
    if (COLUMNS.some((column) => !row[column])) throw new Error(`CSV_EMPTY_FIELD row=${index + 2}`);
    const date = new Date(row.stocked_at);
    if (Number.isNaN(date.valueOf()) || date.toISOString() !== row.stocked_at) throw new Error(`CSV_DATE_INVALID row=${index + 2}`);
    row.stocked_at = date;
    return row;
  });
  if (rows.length !== 43 || new Set(rows.map((row) => row.pg_no)).size !== rows.length ||
      new Set(rows.map((row) => row.model_option_key)).size !== 30 ||
      new Set(rows.map((row) => row.inventory_status)).size !== STATUSES.size) {
    throw new Error("CSV_COVERAGE_MISMATCH");
  }
  return rows;
}

// Deterministic, fictional demonstration identifiers; the last digit is a Luhn check digit.
function demoImei(index) {
  const body = `99000000${String(index + 1).padStart(6, "0")}`;
  const sum = [...body].reduce((total, digit, position) => {
    let value = Number(digit) * (position % 2 === 1 ? 2 : 1);
    if (value > 9) value -= 9;
    return total + value;
  }, 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

async function allocateModelSeq(client, model) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`model-sequence:${model}`]);
  const { rows } = await client.query(`
    INSERT INTO model_sequences (model, last_seq, created_at, updated_at)
    SELECT $1, COALESCE(MAX(model_seq), 0) + 1, now(), now()
    FROM devices WHERE model = $1
    ON CONFLICT (model) DO UPDATE SET
      last_seq = GREATEST(model_sequences.last_seq, EXCLUDED.last_seq - 1) + 1,
      updated_at = EXCLUDED.updated_at
    RETURNING last_seq
  `, [model]);
  if (rows.length !== 1 || !Number.isInteger(rows[0].last_seq)) throw new Error(`MODEL_SEQ_UNAVAILABLE ${model}`);
  return rows[0].last_seq;
}

function uniqueOption(options, category, key) {
  const rows = options.filter((option) => option.category === category && option.option_key === key && option.is_active === 1);
  if (rows.length !== 1) throw new Error(`CRITERION_MISSING_OR_AMBIGUOUS ${category}:${key}`);
  return rows[0];
}

async function resolveRows(client, rows) {
  const { rows: options } = await client.query(
    "SELECT option_id, category, option_key, label, is_active FROM product_criteria_options WHERE category = ANY($1::text[])",
    [CATEGORIES],
  );
  const { rows: links } = await client.query(
    "SELECT relation_type, parent_option_id, child_option_id FROM product_criteria_option_links WHERE is_active = 1 AND relation_type = ANY($1::text[])",
    [["MODEL_STORAGE", "MODEL_COLOR"]],
  );
  return rows.map((row) => {
    const model = uniqueOption(options, "PRODUCT_MODEL", row.model_option_key);
    const storage = uniqueOption(options, "STORAGE", row.storage_option_key);
    const color = uniqueOption(options, "DEVICE_COLOR", row.color_option_key);
    const grade = uniqueOption(options, "SALE_GRADE", row.sale_grade_option_key);
    if (model.label !== row.model_name) throw new Error(`MODEL_LABEL_MISMATCH ${row.pg_no}`);
    for (const [relation, child] of [["MODEL_STORAGE", storage], ["MODEL_COLOR", color]]) {
      const configured = links.filter((link) => link.relation_type === relation && link.parent_option_id === model.option_id);
      if (configured.length > 0 && !configured.some((link) => link.child_option_id === child.option_id)) {
        throw new Error(`MODEL_OPTION_LINK_MISSING ${row.pg_no}:${relation}`);
      }
    }
    return {
      ...row,
      model,
      storage,
      color,
      grade,
      skuCode: `QH-SKU-M${model.option_id}-S${storage.option_id}-C${color.option_id}-G${grade.option_id}`,
    };
  });
}

async function assertNoPgConflicts(client, rows) {
  const { rows: existing } = await client.query(
    "SELECT pg_no FROM devices WHERE pg_no = ANY($1::text[]) ORDER BY pg_no",
    [rows.map((row) => row.pg_no)],
  );
  if (existing.length) throw new Error(`PG_ALREADY_EXISTS count=${existing.length} first=${existing[0].pg_no}`);
}

async function assertAffectedBalancesConsistent(client, rows) {
  const keys = new Set(rows.map((row) => `${row.skuCode}\u0000${row.inventory_status}`));
  for (const key of keys) {
    const [skuCode, status] = key.split("\u0000");
    const { rows: counts } = await client.query(`
      SELECT s.inventory_sku_id,
        (SELECT count(*)::int FROM devices d JOIN inventory i USING (pg_no)
         WHERE d.inventory_sku_id=s.inventory_sku_id AND i.inventory_status=$2) AS inventory_count,
        (SELECT quantity FROM inventory_quantity_balances b
         WHERE b.inventory_sku_id=s.inventory_sku_id AND b.inventory_status=$2) AS balance_quantity
      FROM inventory_skus s WHERE s.sku_code=$1
    `, [skuCode, status]);
    if (counts.length === 0) continue;
    if (counts.length !== 1 || counts[0].inventory_count !== (counts[0].balance_quantity ?? 0)) {
      throw new Error(`EXISTING_BALANCE_MISMATCH ${skuCode}:${status}`);
    }
  }
}

async function seedRow(client, row, imei) {
  await client.query(`
    INSERT INTO inventory_skus (sku_code, model_option_id, storage_option_id, color_option_id, sale_grade_option_id)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING
  `, [row.skuCode, row.model.option_id, row.storage.option_id, row.color.option_id, row.grade.option_id]);
  const { rows: skus } = await client.query(`
    SELECT inventory_sku_id, is_active FROM inventory_skus
    WHERE model_option_id=$1 AND storage_option_id=$2 AND color_option_id=$3 AND sale_grade_option_id=$4
  `, [row.model.option_id, row.storage.option_id, row.color.option_id, row.grade.option_id]);
  if (skus.length !== 1 || skus[0].is_active !== 1) throw new Error(`SKU_UNAVAILABLE ${row.pg_no}`);
  const skuId = skus[0].inventory_sku_id;

  const modelSeq = await allocateModelSeq(client, row.model.label);
  await client.query(`
    INSERT INTO devices (pg_no, imei, model, model_code, model_seq, storage, color, sale_grade, inventory_sku_id, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
  `, [row.pg_no, imei, row.model.label, row.model.option_key, modelSeq,
    row.storage.label, row.color.label, row.grade.option_key, skuId, row.stocked_at]);
  await client.query(`
    INSERT INTO inbounds (pg_no, supplier_name, received_at, inbound_status, note, created_at, updated_at)
    VALUES ($1,$2,$3,'PURCHASED',$4,$3,$3)
  `, [row.pg_no, "해커톤 시연", row.stocked_at, PREFIX]);
  await client.query(`
    INSERT INTO inventory (pg_no, inventory_status, location, stocked_at, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$4,$4)
  `, [row.pg_no, row.inventory_status, row.location, row.stocked_at]);

  await client.query(`
    INSERT INTO inventory_quantity_balances (inventory_sku_id, inventory_status, quantity, version, last_movement_at)
    VALUES ($1,$2,0,0,now()) ON CONFLICT (inventory_sku_id, inventory_status) DO NOTHING
  `, [skuId, row.inventory_status]);
  const { rows: balances } = await client.query(`
    SELECT inventory_quantity_balance_id, quantity FROM inventory_quantity_balances
    WHERE inventory_sku_id=$1 AND inventory_status=$2 FOR UPDATE
  `, [skuId, row.inventory_status]);
  if (balances.length !== 1) throw new Error(`BALANCE_UNAVAILABLE ${row.pg_no}`);
  const balance = balances[0];
  await client.query(`
    UPDATE inventory_quantity_balances SET quantity=quantity+1, version=version+1,
      last_movement_at=now(), updated_at=now() WHERE inventory_quantity_balance_id=$1
  `, [balance.inventory_quantity_balance_id]);
  const operationKey = `${PREFIX}:${row.pg_no}`;
  await client.query(`
    INSERT INTO inventory_quantity_movements
      (inventory_quantity_balance_id, operation_key, idempotency_key, movement_type, pg_no,
       quantity_delta, before_quantity, after_quantity, source_type, source_id, reason)
    VALUES ($1,$2,$3,'INVENTORY_CREATED',$4,1,$5,$6,'DEMO_INVENTORY_SEED',$4,$7)
  `, [balance.inventory_quantity_balance_id, operationKey, `${operationKey}:CREATE`, row.pg_no,
    balance.quantity, balance.quantity + 1, "해커톤 시연 재고"]);
}

async function main() {
  const csvIndex = process.argv.indexOf("--csv");
  const csvPath = csvIndex < 0 ? "" : process.argv[csvIndex + 1];
  if (!csvPath) throw new Error("CSV_PATH_REQUIRED");
  const rows = loadCsv(csvPath);
  const imeis = rows.map((_, index) => demoImei(index));
  if (process.argv.includes("--validate-csv")) {
    console.log(JSON.stringify({ csvValid: true, rows: rows.length, models: 30, statuses: STATUSES.size }));
    return;
  }
  const runtimeConfigPath = "/etc/quickhack/demonstration-server/server-runtime.json";
  const connectionString = resolvePostgresqlConnectionStringSync({
    role: "runtime", applicationName: "quickhack-hackathon-demo-inventory-seed", runtimeConfigPath,
  });
  const parsed = new URL(connectionString);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/quickhack" || parsed.username !== "quickhack_runtime") {
    throw new Error("INSTALLED_DEMONSTRATION_DATABASE_IDENTITY_MISMATCH");
  }
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_894_475_108]);
    const identity = await client.query("SELECT current_database() AS database, current_user AS role");
    if (identity.rows[0]?.database !== "quickhack" || identity.rows[0]?.role !== "quickhack_runtime") {
      throw new Error("DATABASE_IDENTITY_MISMATCH");
    }
    const resolved = await resolveRows(client, rows);
    await assertNoPgConflicts(client, resolved);
    const { rows: imeiConflicts } = await client.query(
      "SELECT pg_no FROM devices WHERE imei = ANY($1::text[]) LIMIT 1", [imeis],
    );
    if (imeiConflicts.length) throw new Error(`IMEI_ALREADY_EXISTS ${imeiConflicts[0].pg_no}`);
    await assertAffectedBalancesConsistent(client, resolved);
    if (!process.argv.includes("--apply")) {
      await client.query("ROLLBACK");
      console.log(JSON.stringify({ readyToApply: true, rows: resolved.length, models: 30, statuses: STATUSES.size }));
      return;
    }
    for (const [index, row] of resolved.entries()) await seedRow(client, row, imeis[index]);
    const { rows: verification } = await client.query(`
      SELECT count(*)::int AS inventory_count,
        count(DISTINCT d.model_code)::int AS model_count,
        count(DISTINCT i.inventory_status)::int AS status_count,
        count(DISTINCT d.imei)::int AS imei_count,
        count(d.model_seq)::int AS model_seq_count
      FROM devices d JOIN inventory i USING (pg_no) WHERE d.pg_no = ANY($1::text[])
    `, [rows.map((row) => row.pg_no)]);
    const { rows: movementCount } = await client.query(
      "SELECT count(*)::int AS count FROM inventory_quantity_movements WHERE source_type='DEMO_INVENTORY_SEED' AND pg_no = ANY($1::text[])",
      [rows.map((row) => row.pg_no)],
    );
    if (verification[0]?.inventory_count !== 43 || verification[0]?.model_count !== 30 ||
        verification[0]?.status_count !== STATUSES.size ||
        verification[0]?.imei_count !== 43 || verification[0]?.model_seq_count !== 43 ||
        movementCount[0]?.count !== 43) {
      throw new Error("POST_INSERT_VERIFICATION_FAILED");
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ applied: true, ...verification[0], movementCount: movementCount[0].count }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Demo inventory seed failed: ${error?.code || error?.message || String(error)}`);
  process.exitCode = 1;
});
