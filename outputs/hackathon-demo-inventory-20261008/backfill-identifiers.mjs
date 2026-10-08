// Fill the missing identifiers on the 43 already seeded demonstration devices.
// Run under a systemd unit with the quickhack.postgresql.runtime credential.
import fs from "node:fs";
import pg from "/usr/lib/quickhack/demonstration-server/node_modules/pg/lib/index.js";
import { resolvePostgresqlConnectionStringSync } from "/usr/lib/quickhack/demonstration-server/quickhack_server/core/database/postgresql-credential.mjs";

const PREFIX = "HACKATHON_DEMO_INVENTORY_20261008";
const HEADER = "pg_no,model_option_key,model_name,storage_option_key,color_option_key,sale_grade_option_key,inventory_status,location,stocked_at";

function demoImei(index) {
  const body = `99000000${String(index + 1).padStart(6, "0")}`;
  const sum = [...body].reduce((total, digit, position) => {
    let value = Number(digit) * (position % 2 === 1 ? 2 : 1);
    if (value > 9) value -= 9;
    return total + value;
  }, 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

function loadRows(path) {
  const lines = fs.readFileSync(path, "utf8").replace(/^\uFEFF/u, "").trimEnd().split(/\r?\n/u);
  if (lines.shift() !== HEADER) throw new Error("CSV_HEADER_MISMATCH");
  const rows = lines.map((line, index) => {
    const fields = line.split(",");
    if (fields.length !== 9 || !/^[A-Z]{2}\d{10}$/u.test(fields[0]) || !fields[1] || !fields[2]) {
      throw new Error(`CSV_ROW_INVALID row=${index + 2}`);
    }
    return { pgNo: fields[0], modelCode: fields[1], model: fields[2], imei: demoImei(index) };
  });
  if (rows.length !== 43 || new Set(rows.map((row) => row.pgNo)).size !== 43 ||
      new Set(rows.map((row) => row.model)).size !== 30 ||
      new Set(rows.map((row) => row.imei)).size !== 43) {
    throw new Error("CSV_COVERAGE_MISMATCH");
  }
  return rows;
}

async function allocateModelSeq(client, model) {
  // Matches quickhack_server/inbound/model-sequence-service.ts after its aggregate lock.
  const { rows } = await client.query(`
    INSERT INTO model_sequences (model, last_seq, created_at, updated_at)
    SELECT $1, COALESCE(MAX(model_seq), 0) + 1, now(), now()
    FROM devices WHERE model = $1
    ON CONFLICT (model) DO UPDATE SET
      last_seq = GREATEST(model_sequences.last_seq, EXCLUDED.last_seq - 1) + 1,
      updated_at = EXCLUDED.updated_at
    RETURNING last_seq
  `, [model]);
  if (rows.length !== 1 || !Number.isInteger(rows[0].last_seq) || rows[0].last_seq <= 0) {
    throw new Error(`MODEL_SEQ_UNAVAILABLE ${model}`);
  }
  return rows[0].last_seq;
}

async function inspectTargets(client, inputRows) {
  const pgNos = inputRows.map((row) => row.pgNo);
  const { rows } = await client.query(`
    SELECT d.pg_no, d.model, d.model_code, d.model_seq, d.imei,
      EXISTS (SELECT 1 FROM inbounds ib WHERE ib.pg_no = d.pg_no AND ib.note = $2) AS seed_inbound,
      EXISTS (SELECT 1 FROM inventory_quantity_movements m
              WHERE m.pg_no = d.pg_no AND m.source_type = 'DEMO_INVENTORY_SEED'
                AND m.operation_key = $2 || ':' || d.pg_no) AS seed_movement
    FROM devices d WHERE d.pg_no = ANY($1::text[]) ORDER BY d.pg_no FOR UPDATE OF d
  `, [pgNos, PREFIX]);
  if (rows.length !== 43) throw new Error(`SEED_DEVICES_MISSING count=${rows.length}`);
  const byPg = new Map(rows.map((row) => [row.pg_no, row]));
  for (const row of inputRows) {
    const actual = byPg.get(row.pgNo);
    if (!actual || actual.model !== row.model || actual.model_code !== row.modelCode ||
        !actual.seed_inbound || !actual.seed_movement) {
      throw new Error(`SEED_IDENTITY_MISMATCH ${row.pgNo}`);
    }
  }
  const filled = inputRows.filter((row) => byPg.get(row.pgNo).model_seq !== null || byPg.get(row.pgNo).imei !== null);
  const complete = inputRows.every((row) => {
    const actual = byPg.get(row.pgNo);
    return Number.isInteger(actual.model_seq) && actual.model_seq > 0 && actual.imei === row.imei;
  });
  if (filled.length > 0 && !complete) throw new Error(`IDENTIFIERS_PARTIALLY_PRESENT count=${filled.length}`);
  return { complete };
}

async function main() {
  const csvIndex = process.argv.indexOf("--csv");
  const csvPath = csvIndex < 0 ? "" : process.argv[csvIndex + 1];
  if (!csvPath) throw new Error("CSV_PATH_REQUIRED");
  const inputRows = loadRows(csvPath);
  if (process.argv.includes("--validate-csv")) {
    console.log(JSON.stringify({ csvValid: true, rows: inputRows.length, imeis: 43, models: 30 }));
    return;
  }

  const connectionString = resolvePostgresqlConnectionStringSync({
    role: "runtime", applicationName: "quickhack-demo-inventory-identifiers",
    runtimeConfigPath: "/etc/quickhack/demonstration-server/server-runtime.json",
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
    const { rows: identity } = await client.query("SELECT current_database() AS database, current_user AS role");
    if (identity[0]?.database !== "quickhack" || identity[0]?.role !== "quickhack_runtime") {
      throw new Error("DATABASE_IDENTITY_MISMATCH");
    }
    if (process.argv.includes("--apply")) {
      // Use the same model-level lock as the normal sequence allocator.
      for (const model of [...new Set(inputRows.map((row) => row.model))].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`model-sequence:${model}`]);
      }
    }
    const { complete } = await inspectTargets(client, inputRows);
    const { rows: conflicts } = await client.query(
      "SELECT pg_no FROM devices WHERE imei = ANY($1::text[]) AND NOT (pg_no = ANY($2::text[])) LIMIT 1",
      [inputRows.map((row) => row.imei), inputRows.map((row) => row.pgNo)],
    );
    if (conflicts.length) throw new Error(`IMEI_ALREADY_EXISTS ${conflicts[0].pg_no}`);

    if (process.argv.includes("--verify")) {
      if (!complete) throw new Error("IDENTIFIERS_NOT_APPLIED");
      await client.query("ROLLBACK");
      console.log(JSON.stringify({ verified: true, devices: 43, modelSeqs: 43, imeis: 43 }));
      return;
    }
    if (!process.argv.includes("--apply") || complete) {
      await client.query("ROLLBACK");
      console.log(JSON.stringify({ readyToApply: !complete, alreadyApplied: complete, devices: 43 }));
      return;
    }

    for (const row of inputRows) {
      const modelSeq = await allocateModelSeq(client, row.model);
      const result = await client.query(`
        UPDATE devices SET model_seq=$1, imei=$2, revision=revision+1, updated_at=now()
        WHERE pg_no=$3 AND model_seq IS NULL AND imei IS NULL
      `, [modelSeq, row.imei, row.pgNo]);
      if (result.rowCount !== 1) throw new Error(`IDENTIFIER_UPDATE_CONFLICT ${row.pgNo}`);
    }
    const verified = await inspectTargets(client, inputRows);
    if (!verified.complete) throw new Error("POST_UPDATE_VERIFICATION_FAILED");
    await client.query("COMMIT");
    console.log(JSON.stringify({ applied: true, devices: 43, modelSeqs: 43, imeis: 43 }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Demo inventory identifier backfill failed: ${error?.code || error?.message || String(error)}`);
  process.exitCode = 1;
});
