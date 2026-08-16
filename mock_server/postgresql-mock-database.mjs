import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { resolvePostgresqlConnectionStringSync } from "../quickhack_server/core/database/postgresql-credential.mjs";

const { Pool } = pg;

function postgresqlSql(source) {
  const quotedAliases = String(source).replace(
    /\bAS\s+((?=[A-Za-z0-9_]*[A-Z])[a-z_][A-Za-z0-9_]*)\b/g,
    'AS "$1"'
  );
  let parameterIndex = 0;
  return quotedAliases
    .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "BIGSERIAL PRIMARY KEY")
    .replace(/\?/g, () => `$${++parameterIndex}`);
}

class PostgresqlMockStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = postgresqlSql(sql);
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
    return {
      changes: result.rowCount ?? 0,
      rows: result.rows,
    };
  }
}

export class PostgresqlMockDatabase {
  constructor({ role, applicationName }) {
    const connectionString = resolvePostgresqlConnectionStringSync({
      role,
      applicationName,
    });
    this.pool = new Pool({
      connectionString,
      application_name: applicationName,
      max: 8,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
      allowExitOnIdle: false,
    });
    this.transactionClient = new AsyncLocalStorage();
  }

  prepare(sql) {
    return new PostgresqlMockStatement(this, sql);
  }

  async query(sql, parameters = []) {
    const executor = this.transactionClient.getStore() ?? this.pool;
    return executor.query(sql, parameters);
  }

  async exec(sql) {
    return this.query(postgresqlSql(sql));
  }

  transaction(callback) {
    return async (...args) => {
      const existing = this.transactionClient.getStore();
      if (existing) return callback(...args);

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.transactionClient.run(client, () =>
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
  }

  async close() {
    await this.pool.end();
  }
}

export function openPostgresqlMockDatabase(role, applicationName) {
  return new PostgresqlMockDatabase({ role, applicationName });
}
