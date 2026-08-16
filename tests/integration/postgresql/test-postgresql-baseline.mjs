import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { POSTGRESQL_BASELINE_CONTRACT } from "../../../prisma/postgresql-baseline-contract.mjs";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const { Pool } = pg;
const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDirectory, "..", "..", "..");
const scope = createTemporaryDatabase("quickhack-postgresql-baseline-");
configureIntegrationTestEnvironment(scope.databaseUrl);
const pool = new Pool({ connectionString: scope.databaseUrl, max: 2 });
const schemaSource = readFileSync(
  path.join(projectRoot, "prisma", "schema.prisma"),
  "utf8"
);

const scalarTypes = new Set([
  "BigInt",
  "Boolean",
  "Bytes",
  "DateTime",
  "Decimal",
  "Float",
  "Int",
  "Json",
  "String",
]);

function parseSchemaFields(source) {
  const models = new Map();
  let modelName = null;

  for (const line of source.split(/\r?\n/)) {
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      modelName = modelMatch[1];
      models.set(modelName, []);
      continue;
    }
    if (modelName && /^}/.test(line)) {
      modelName = null;
      continue;
    }
    if (!modelName || /^\s*(?:\/\/|@@)/.test(line)) continue;

    const fieldMatch = line.match(/^\s+(\w+)\s+(\w+)(\?|\[\])?/);
    if (!fieldMatch || !scalarTypes.has(fieldMatch[2])) continue;
    models.get(modelName).push({
      model: modelName,
      name: fieldMatch[1],
      type: fieldMatch[2],
      optionality: fieldMatch[3] ?? "",
      source: line.trim(),
    });
  }

  return models;
}

function fieldKey(field) {
  return `${field.model}.${field.name}`;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

const schemaModels = parseSchemaFields(schemaSource);
const schemaFields = [...schemaModels.values()].flat();
const fieldsByKey = new Map(schemaFields.map((field) => [fieldKey(field), field]));

function assertExactFieldSet(actualFields, expectedFields, message) {
  assert.deepEqual(sorted(actualFields), sorted(expectedFields), message);
}

function assertSchemaContract() {
  assert.match(
    schemaSource,
    /provider\s*=\s*"postgresql"/,
    "Prisma datasource must stay PostgreSQL-only."
  );
  assert.equal(
    schemaSource.includes("dbgenerated(datetime("),
    false,
    "SQLite datetime defaults must not re-enter the Prisma schema."
  );

  const calendarDateFields = new Set(
    POSTGRESQL_BASELINE_CONTRACT.calendarDateFields
  );
  const actualCalendarDateFields = [];
  const timestampFields = [];
  const providerWireDateFields = [];
  const jsonbFields = [];
  const decimalFields = [];

  for (const field of schemaFields) {
    const key = fieldKey(field);
    if (field.type === "DateTime") {
      if (field.source.includes("@db.Date") && !field.source.includes("@db.Timestamptz")) {
        actualCalendarDateFields.push(key);
      } else {
        assert.match(
          field.source,
          /@db\.Timestamptz\(3\)/,
          `${key} must be stored as timestamptz(3).`
        );
        timestampFields.push(key);
      }
    }

    if (field.type === "String" && /(?:_at|_date)$/.test(field.name)) {
      providerWireDateFields.push(key);
    }
    if (field.type === "Json") {
      assert.match(field.source, /@db\.JsonB/, `${key} must use jsonb.`);
      jsonbFields.push(key);
    }
    if (field.type === "Decimal") decimalFields.push(key);
    assert.notEqual(field.type, "Float", `${key} must not use a floating storage type.`);

    if (
      /(?:quantity|count|amount|price|cost)/i.test(field.name) &&
      !["DateTime", "String"].includes(field.type)
    ) {
      assert.ok(
        field.type === "Int",
        `${key} must keep integer business-unit storage.`
      );
    }
    if (/^external_.*_id$/.test(field.name)) {
      assert.equal(field.type, "String", `${key} must preserve external IDs as text.`);
    }
  }

  assertExactFieldSet(
    actualCalendarDateFields,
    calendarDateFields,
    "The calendar-date field manifest must cover every @db.Date field."
  );
  assertExactFieldSet(
    providerWireDateFields,
    POSTGRESQL_BASELINE_CONTRACT.providerWireDateFields,
    "Only provider wire snapshots may keep *_at/*_date as strings."
  );
  assertExactFieldSet(
    jsonbFields,
    POSTGRESQL_BASELINE_CONTRACT.jsonbFields,
    "The JSONB field manifest must be exact."
  );
  assertExactFieldSet(
    decimalFields,
    Object.keys(POSTGRESQL_BASELINE_CONTRACT.decimalFields),
    "Only explicitly classified precision-bearing fields may use Decimal."
  );

  for (const [key, contract] of Object.entries(
    POSTGRESQL_BASELINE_CONTRACT.decimalFields
  )) {
    const field = fieldsByKey.get(key);
    assert.ok(field, `Missing decimal field ${key}.`);
    assert.match(
      field.source,
      new RegExp(`@db\\.Decimal\\(${contract.precision},\\s*${contract.scale}\\)`),
      `${key} must keep its declared decimal precision and scale.`
    );
  }

  return { timestampFields };
}

const schemaContract = assertSchemaContract();

function runTool(fileName) {
  const result = spawnSync(process.execPath, [path.join(projectRoot, "tools", fileName)], {
    cwd: projectRoot,
    env: { ...process.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(result.status, 0, [result.stdout, result.stderr].join("\n"));
}

try {
  runTool("deploy-postgresql-migrations.mjs");
  runTool("audit-postgresql-schema.mjs");

  const migrations = await pool.query(`
    SELECT migration_name
    FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `);
  assert.deepEqual(
    migrations.rows.map((row) => row.migration_name),
    [POSTGRESQL_BASELINE_CONTRACT.migrationName]
  );

  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
  `);
  const tableNames = new Set(tables.rows.map((row) => row.table_name));
  for (const tableName of schemaModels.keys()) {
    assert.ok(tableNames.has(tableName), `Missing Prisma table ${tableName}.`);
  }
  for (const tableName of POSTGRESQL_BASELINE_CONTRACT.foundationTables) {
    assert.ok(tableNames.has(tableName), `Missing foundation table ${tableName}.`);
  }

  const prohibited = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = ANY($1::text[])
  `, [POSTGRESQL_BASELINE_CONTRACT.prohibitedTables]);
  assert.equal(prohibited.rowCount, 0);

  const types = await pool.query(`
    SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = current_schema()
  `);
  const typesByKey = new Map(
    types.rows.map((row) => [`${row.table_name}.${row.column_name}`, row])
  );
  for (const key of POSTGRESQL_BASELINE_CONTRACT.calendarDateFields) {
    assert.equal(typesByKey.get(key)?.data_type, "date", `${key} must be date.`);
  }
  for (const key of schemaContract.timestampFields) {
    assert.equal(
      typesByKey.get(key)?.data_type,
      "timestamp with time zone",
      `${key} must be timestamptz.`
    );
  }
  for (const key of POSTGRESQL_BASELINE_CONTRACT.providerWireDateFields) {
    assert.equal(typesByKey.get(key)?.data_type, "text", `${key} must remain text.`);
  }
  for (const key of POSTGRESQL_BASELINE_CONTRACT.jsonbFields) {
    assert.equal(typesByKey.get(key)?.data_type, "jsonb", `${key} must be jsonb.`);
  }
  for (const [key, contract] of Object.entries(
    POSTGRESQL_BASELINE_CONTRACT.decimalFields
  )) {
    const row = typesByKey.get(key);
    assert.equal(row?.data_type, "numeric", `${key} must be numeric.`);
    assert.equal(row?.numeric_precision, contract.precision);
    assert.equal(row?.numeric_scale, contract.scale);
  }

  const constraints = await pool.query(`
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE connamespace = current_schema()::regnamespace
  `);
  const constraintNames = new Set(constraints.rows.map((row) => row.conname));
  for (const name of POSTGRESQL_BASELINE_CONTRACT.requiredConstraints) {
    assert.ok(constraintNames.has(name), `Missing PostgreSQL constraint ${name}.`);
  }

  const serverSecurityState = await pool.query(`
    SELECT singleton_key, instance_epoch, revision
    FROM server_instance_state
  `);
  assert.deepEqual(serverSecurityState.rows, [
    { singleton_key: "QUICKHACK", instance_epoch: 1, revision: 0 },
  ]);

  const indexes = await pool.query(`
    SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
  `);
  const indexNames = new Set(indexes.rows.map((row) => row.indexname));
  for (const name of POSTGRESQL_BASELINE_CONTRACT.requiredIndexes) {
    assert.ok(indexNames.has(name), `Missing PostgreSQL index ${name}.`);
  }

  const triggers = await pool.query(`
    SELECT tgname
    FROM pg_catalog.pg_trigger
    WHERE tgrelid IN (
      SELECT c.oid
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
    ) AND NOT tgisinternal
  `);
  const triggerNames = new Set(triggers.rows.map((row) => row.tgname));
  for (const name of POSTGRESQL_BASELINE_CONTRACT.requiredTriggers) {
    assert.ok(triggerNames.has(name), `Missing PostgreSQL trigger ${name}.`);
  }

  const invalid = await pool.query(`
    SELECT conname FROM pg_catalog.pg_constraint
    WHERE connamespace = current_schema()::regnamespace AND NOT convalidated
  `);
  assert.equal(invalid.rowCount, 0);
  console.log("PostgreSQL clean baseline and repeated deploy verified.");
} finally {
  await pool.end();
  scope.cleanup();
}
