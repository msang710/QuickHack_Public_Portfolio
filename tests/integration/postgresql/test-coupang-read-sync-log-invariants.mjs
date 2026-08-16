import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { openPostgresqlTestDatabase } from "../../support/postgresql-database.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-read-sync-log-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
const timestamp = "2026-07-19 12:00:00";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectBlocked(database, label, sql, expectedMessage) {
  try {
    await database.exec(sql);
    throw new Error(`${label} was not blocked.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.endsWith("was not blocked.")) throw error;
    assert(
      message.includes(expectedMessage),
      `${label} failed for an unexpected reason: ${message}`
    );
  }
}

const database = openPostgresqlTestDatabase(temporaryDatabase.databaseUrl);

try {
  const insert = database.prepare(`
    INSERT INTO coupang_api_call_log (
      channel,
      api_name,
      method,
      status_filter,
      response_row_count,
      processed_row_count,
      skipped_row_count,
      processed_status,
      request_started_at,
      created_at,
      updated_at
    ) VALUES ('COUPANG', ?, 'GET', 'ACCEPT', 0, 0, 0, 'PENDING', ?, ?, ?)
    RETURNING coupang_api_call_log_id
  `);
  const logId = Number(
    (await insert.run("ordersheets.accept", timestamp, timestamp, timestamp))
      .rows[0].coupang_api_call_log_id
  );

  await database
    .prepare(`
      UPDATE coupang_api_call_log
      SET processed_status = 'RECEIVED',
          http_status_code = 200,
          response_hash = 'hash',
          received_at = ?,
          updated_at = ?
      WHERE coupang_api_call_log_id = ?
    `)
    .run(timestamp, timestamp, logId);
  await database
    .prepare(`
      UPDATE coupang_api_call_log
      SET processed_status = 'PROCESSING',
          response_row_count = 5,
          processing_started_at = ?,
          updated_at = ?
      WHERE coupang_api_call_log_id = ?
    `)
    .run(timestamp, timestamp, logId);
  await database
    .prepare(`
      UPDATE coupang_api_call_log
      SET processed_status = 'SUCCESS',
          processed_row_count = 4,
          skipped_row_count = 1,
          processed_at = ?,
          updated_at = ?
      WHERE coupang_api_call_log_id = ?
    `)
    .run(timestamp, timestamp, logId);

  await expectBlocked(
    database,
    "terminal status overwrite",
    `UPDATE coupang_api_call_log SET processed_status = 'FAILED' WHERE coupang_api_call_log_id = ${logId}`,
    "invalid coupang_api_call_log status transition"
  );

  const invalidLogId = Number(
    (await insert.run("ordersheets.invalid", timestamp, timestamp, timestamp))
      .rows[0].coupang_api_call_log_id
  );
  await expectBlocked(
    database,
    "success without lifecycle",
    `UPDATE coupang_api_call_log
     SET processed_status = 'SUCCESS',
         http_status_code = 200,
         received_at = '${timestamp}',
         processing_started_at = '${timestamp}',
         processed_at = '${timestamp}'
     WHERE coupang_api_call_log_id = ${invalidLogId}`,
    "invalid coupang_api_call_log status transition"
  );

  const row = await database
    .prepare(`
      SELECT processed_status, response_row_count, processed_row_count, skipped_row_count
      FROM coupang_api_call_log
      WHERE coupang_api_call_log_id = ?
    `)
    .get(logId);

  assert(row.processed_status === "SUCCESS", "The completed log status changed.");
  assert(Number(row.response_row_count) === 5, "Unexpected response row count.");
  assert(Number(row.processed_row_count) === 4, "Unexpected processed row count.");
  assert(Number(row.skipped_row_count) === 1, "Unexpected skipped row count.");

  console.log("Coupang read sync log lifecycle invariants passed.");
} finally {
  await database.close();
  temporaryDatabase.cleanup();
}
