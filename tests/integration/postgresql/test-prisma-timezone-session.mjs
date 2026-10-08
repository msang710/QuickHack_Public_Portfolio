import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresqlPrismaClient } from "../../../quickhack_server/core/database/postgresql-client.ts";
import { createPrismaClient } from "../../../tools/prisma-client.mjs";
import { createTemporaryDatabase } from "../../support/postgresql-test-scope.mjs";

const { Pool } = pg;
const scope = createTemporaryDatabase("quickhack-prisma-timezone-");
const url = new URL(scope.databaseUrl);
url.searchParams.set(
  "options",
  `${url.searchParams.get("options")} -c TimeZone=Asia/Seoul`
);
const direct = new Pool({ connectionString: url.toString(), max: 1 });
const { pool, client } = createPostgresqlPrismaClient({
  connectionString: url.toString(),
  applicationName: "quickhack-prisma-timezone-test",
});
process.env.NODE_ENV = "test";
process.env.QUICKHACK_TEST_DATABASE_URL = url.toString();
const toolClient = createPrismaClient();
const instant = new Date("2026-10-08T20:55:24.922Z");

try {
  const baseline = await direct.query(
    "SELECT current_setting('TimeZone') AS zone, current_setting('search_path') AS path"
  );
  assert.equal(baseline.rows[0].zone, "Asia/Seoul");
  assert.equal(baseline.rows[0].path, scope.schema);

  const session = await pool.query(
    "SELECT current_setting('TimeZone') AS zone, current_setting('search_path') AS path"
  );
  assert.equal(session.rows[0].zone, "UTC");
  assert.equal(session.rows[0].path, scope.schema);

  const [read] = await client.$queryRaw`SELECT '2026-10-08T20:55:24.922Z'::timestamptz AS instant`;
  assert.equal(read.instant.toISOString(), instant.toISOString());

  const [bound] = await client.$queryRaw`SELECT ${instant}::timestamptz = '2026-10-08T20:55:24.922Z'::timestamptz AS same_instant`;
  assert.equal(bound.same_instant, true);

  const [due] = await client.$queryRaw`SELECT ${instant}::timestamptz <= '2026-10-08T20:55:25.000Z'::timestamptz AS due`;
  assert.equal(due.due, true);

  const [toolSession] = await toolClient.$queryRaw`SELECT current_setting('TimeZone') AS zone, current_setting('search_path') AS path`;
  assert.equal(toolSession.zone, "UTC");
  assert.equal(toolSession.path, scope.schema);
  const [toolRead] = await toolClient.$queryRaw`SELECT '2026-10-08T20:55:24.922Z'::timestamptz AS instant`;
  assert.equal(toolRead.instant.toISOString(), instant.toISOString());

  console.log("PrismaPg UTC session preserves search_path and timestamptz instants on a KST connection.");
} finally {
  await client.$disconnect();
  await toolClient.$disconnect();
  await direct.end();
  scope.cleanup();
}
