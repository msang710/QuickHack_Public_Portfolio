import assert from "node:assert/strict";

export async function assertPostgresqlIndex(pool, indexName, options = {}) {
  const result = await pool.query(
    `SELECT indexdef FROM pg_catalog.pg_indexes
     WHERE schemaname = current_schema() AND indexname = $1`,
    [indexName]
  );
  assert.equal(result.rowCount, 1, `Missing PostgreSQL index: ${indexName}`);
  if (options.unique) assert.match(result.rows[0].indexdef, /CREATE UNIQUE INDEX/i);
  if (options.partial) assert.match(result.rows[0].indexdef, / WHERE /i);
}

export async function assertPostgresqlConstraint(pool, constraintName) {
  const result = await pool.query(
    `SELECT convalidated FROM pg_catalog.pg_constraint
     WHERE connamespace = current_schema()::regnamespace AND conname = $1`,
    [constraintName]
  );
  assert.deepEqual(result.rows, [{ convalidated: true }],
    `Missing or invalid PostgreSQL constraint: ${constraintName}`);
}
