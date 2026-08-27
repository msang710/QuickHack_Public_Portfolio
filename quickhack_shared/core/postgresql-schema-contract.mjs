import { createHash } from "node:crypto";

export const QUICKHACK_POSTGRESQL_MIGRATIONS = Object.freeze([
  Object.freeze({
    name: "20260811010000_postgresql_baseline",
    checksum: "255c2dbe4086cd7b688e630957af7de8108c8c6d80b7e652879bcca4a1feb70f",
  }),
  Object.freeze({
    name: "20260826143000_active_allocation_pg_unique",
    checksum: "5899d512e509a1a7dc76471cdeee7526ba69a1bb4824a0894784fd4674cf6601",
  }),
  Object.freeze({
    name: "20260826150000_manual_order_match_receipts_recovery",
    checksum: "9195ca0bb83151890c6f902f3fca7f26e1f7b478ea5c9e1418bba2ed0c88a5d5",
  }),
  Object.freeze({
    name: "20260826163000_manual_order_match_intent_lease",
    checksum: "9898df4e0f2493adf1bee35d678ab1b79f3db5a25976383704e4fb90dd3bb648",
  }),
]);

const fingerprintPayload = QUICKHACK_POSTGRESQL_MIGRATIONS
  .map((migration) => `${migration.name}:${migration.checksum}`)
  .join("\n");

export const QUICKHACK_POSTGRESQL_SCHEMA_VERSION = `qhpg1-${createHash("sha256")
  .update(fingerprintPayload, "utf8")
  .digest("hex")}`;

export const ACTIVE_ALLOCATION_INDEX_CONTRACT = Object.freeze({
  name: "uq_match_worker_allocation_active_pg",
  table: "match_worker_allocation",
  statuses: Object.freeze(["ALLOCATED", "API_ACKED", "SHIPMENT_LIST_PRINTED"]),
});

function normalizedMigration(row) {
  return {
    name: String(row?.migration_name ?? ""),
    checksum: String(row?.checksum ?? "").toLowerCase(),
    applied: Boolean(row?.finished_at) && !row?.rolled_back_at,
  };
}

export function assertAppliedPostgresqlMigrations(rows) {
  const applied = rows.map(normalizedMigration).filter((row) => row.applied);
  if (applied.length !== QUICKHACK_POSTGRESQL_MIGRATIONS.length) {
    throw new Error("PostgreSQL migration history does not match this QuickHack release.");
  }
  for (let index = 0; index < QUICKHACK_POSTGRESQL_MIGRATIONS.length; index += 1) {
    const expected = QUICKHACK_POSTGRESQL_MIGRATIONS[index];
    const actual = applied[index];
    if (actual.name !== expected.name || actual.checksum !== expected.checksum) {
      throw new Error("PostgreSQL migration history does not match this QuickHack release.");
    }
  }
  return QUICKHACK_POSTGRESQL_SCHEMA_VERSION;
}

export function normalizedIndexPredicate(value) {
  return String(value ?? "")
    .toUpperCase()
    .replaceAll('"', "")
    .replace(/::[A-Z_ ]+(\[\])?/gu, "")
    .replace(/[(){}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function assertActiveAllocationIndex(row) {
  if (
    !row ||
    row.index_name !== ACTIVE_ALLOCATION_INDEX_CONTRACT.name ||
    row.table_name !== ACTIVE_ALLOCATION_INDEX_CONTRACT.table ||
    row.is_unique !== true ||
    row.is_valid !== true ||
    row.is_ready !== true
  ) {
    throw new Error("The active allocation unique index is missing or not ready.");
  }
  const predicate = normalizedIndexPredicate(row.predicate);
  const predicateStatuses = [...predicate.matchAll(/'([A-Z_]+)'/gu)]
    .map((match) => match[1])
    .sort();
  const expectedStatuses = [...ACTIVE_ALLOCATION_INDEX_CONTRACT.statuses].sort();
  if (
    !predicate.includes("ALLOCATION_STATUS") ||
    predicateStatuses.length !== expectedStatuses.length ||
    predicateStatuses.some((status, index) => status !== expectedStatuses[index])
  ) {
    throw new Error("The active allocation unique index predicate does not match the runtime contract.");
  }
  return true;
}
