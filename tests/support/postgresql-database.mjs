import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

const { Pool } = pg;

function sqlForPostgresql(source) {
  let parameterIndex = 0;
  return String(source)
    .replace(
      /\bAS\s+((?=[A-Za-z0-9_]*[A-Z])[a-z_][A-Za-z0-9_]*)\b/g,
      'AS "$1"'
    )
    .replace(/\?/g, () => `$${++parameterIndex}`);
}

class TestStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sqlForPostgresql(sql);
  }

  async get(...parameters) {
    const result = await this.database.query(this.sql, parameters);
    return result.rows[0];
  }

  async all(...parameters) {
    const result = await this.database.query(this.sql, parameters);
    return result.rows;
  }

  async run(...parameters) {
    const result = await this.database.query(this.sql, parameters);
    return { changes: result.rowCount ?? 0, rows: result.rows };
  }
}

export function openPostgresqlTestDatabase(connectionString) {
  const pool = new Pool({
    connectionString,
    application_name: "quickhack-test-direct-sql",
    max: 4,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  const transactionClient = new AsyncLocalStorage();
  const database = {
    prepare(sql) {
      return new TestStatement(database, sql);
    },
    query(sql, parameters = []) {
      return (transactionClient.getStore() ?? pool).query(sql, parameters);
    },
    exec(sql) {
      return database.query(sqlForPostgresql(sql));
    },
    transaction(callback) {
      return async (...args) => {
        if (transactionClient.getStore()) return callback(...args);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await transactionClient.run(client, () =>
            callback(...args)
          );
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };
    },
    close() {
      return pool.end();
    },
  };
  return database;
}
