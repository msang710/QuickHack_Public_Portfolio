import pg from "pg";

const { Pool } = pg;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export async function openDedicatedPool(connectionString, purpose) {
  if (!connectionString || typeof connectionString !== "string") throw new TypeError(`${purpose} connection string is required.`);
  const pool = new Pool({ connectionString, max: 2, application_name: `quickhack-load-${purpose}`, connectionTimeoutMillis: 5_000 });
  try {
    const result = await pool.query("SELECT current_database() AS database_name, current_schema() AS schema_name");
    const { database_name: databaseName, schema_name: schemaName } = result.rows[0];
    const dedicated = /^qh_load_[a-z0-9_]+$/.test(databaseName) || /^qh_load_[a-z0-9_]+$/.test(schemaName);
    const testScope = process.env.NODE_ENV === "test" && /^qh_test_[a-z0-9_]+$/.test(schemaName);
    if (!dedicated && !testScope) throw new Error(`${purpose} must use a qh_load_* database/schema (or qh_test_* test schema).`);
    return { pool, identity: `${databaseName}/${schemaName}` };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function insertRows(client, table, columns, rows) {
  if (!rows.length) return;
  if (![table, ...columns].every((name) => IDENTIFIER.test(name))) throw new TypeError("Invalid fixture SQL identifier.");
  for (let start = 0; start < rows.length; start += 200) {
    const batch = rows.slice(start, start + 200);
    const values = [];
    const placeholders = batch.map((row) => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new TypeError("Fixture row width mismatch.");
      const slots = row.map((value) => { values.push(value); return `$${values.length}`; });
      return `(${slots.join(",")})`;
    });
    await client.query(`INSERT INTO "${table}" (${columns.map((name) => `"${name}"`).join(",")}) VALUES ${placeholders.join(",")}`, values);
  }
}

export async function assertEmptyTables(client, tables) {
  for (const table of tables) {
    if (!IDENTIFIER.test(table)) throw new TypeError("Invalid fixture table.");
    const result = await client.query(`SELECT count(*)::int AS count FROM "${table}"`);
    if (result.rows[0].count !== 0) throw new Error(`Dedicated fixture table ${table} is not empty.`);
  }
}
