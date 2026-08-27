import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  ACTIVE_ALLOCATION_INDEX_CONTRACT,
  QUICKHACK_POSTGRESQL_MIGRATIONS,
  QUICKHACK_POSTGRESQL_SCHEMA_VERSION,
  assertActiveAllocationIndex,
  assertAppliedPostgresqlMigrations,
} from "../../quickhack_shared/core/postgresql-schema-contract.mjs";

const appliedRows = QUICKHACK_POSTGRESQL_MIGRATIONS.map((migration) => ({
  migration_name: migration.name,
  checksum: migration.checksum,
  finished_at: new Date("2026-08-26T00:00:00.000Z"),
  rolled_back_at: null,
}));

const migrationRoot = path.join(process.cwd(), "prisma", "migrations");
const migrationDirectories = readdirSync(migrationRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(
  migrationDirectories,
  QUICKHACK_POSTGRESQL_MIGRATIONS.map((migration) => migration.name)
);
for (const migration of QUICKHACK_POSTGRESQL_MIGRATIONS) {
  const sql = readFileSync(
    path.join(migrationRoot, migration.name, "migration.sql")
  );
  assert.equal(createHash("sha256").update(sql).digest("hex"), migration.checksum);
}

assert.equal(
  assertAppliedPostgresqlMigrations(appliedRows),
  QUICKHACK_POSTGRESQL_SCHEMA_VERSION
);
assert.match(QUICKHACK_POSTGRESQL_SCHEMA_VERSION, /^qhpg1-[a-f0-9]{64}$/u);
for (const mutation of [
  appliedRows.slice(0, -1),
  appliedRows.map((row, index) => index === 1 ? { ...row, checksum: "0".repeat(64) } : row),
  [appliedRows[1], appliedRows[0], ...appliedRows.slice(2)],
]) {
  assert.throws(() => assertAppliedPostgresqlMigrations(mutation));
}

const validIndex = {
  index_name: ACTIVE_ALLOCATION_INDEX_CONTRACT.name,
  table_name: ACTIVE_ALLOCATION_INDEX_CONTRACT.table,
  is_unique: true,
  is_valid: true,
  is_ready: true,
  predicate:
    "allocation_status = ANY (ARRAY['ALLOCATED'::text, 'API_ACKED'::text, 'SHIPMENT_LIST_PRINTED'::text])",
};
assert.equal(assertActiveAllocationIndex(validIndex), true);
for (const mutation of [
  null,
  { ...validIndex, is_valid: false },
  { ...validIndex, is_ready: false },
  { ...validIndex, is_unique: false },
  { ...validIndex, predicate: "allocation_status = 'ALLOCATED'::text" },
  { ...validIndex, predicate: `${validIndex.predicate} OR allocation_status = 'CANCELED'` },
]) {
  assert.throws(() => assertActiveAllocationIndex(mutation));
}

console.log("PostgreSQL ordered migration fingerprint and index catalog contract verified.");
