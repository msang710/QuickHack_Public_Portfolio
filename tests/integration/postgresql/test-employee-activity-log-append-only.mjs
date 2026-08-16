import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { openPostgresqlTestDatabase } from "../../support/postgresql-database.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-activity-log-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

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
  const requiredTriggers = [
    "trg_employee_activity_logs_append_only_update",
    "trg_employee_activity_logs_append_only_delete",
    "trg_employee_activity_log_changes_append_only_update",
    "trg_employee_activity_log_changes_append_only_delete",
  ];
  const triggerNames = new Set(
    (await database
      .prepare(`SELECT tgname AS name
                FROM pg_catalog.pg_trigger
                WHERE tgrelid IN (
                  'employee_activity_logs'::regclass,
                  'employee_activity_log_changes'::regclass
                ) AND NOT tgisinternal`)
      .all())
      .map((row) => String(row.name))
  );

  for (const triggerName of requiredTriggers) {
    assert(triggerNames.has(triggerName), `Missing trigger: ${triggerName}`);
  }

  const logResult = await database
    .prepare(`
      INSERT INTO employee_activity_logs (
        action_type,
        target_type,
        target_id,
        before_summary_text,
        after_summary_text,
        result
      ) VALUES (?, ?, ?, ?, ?, ?) RETURNING id
    `)
    .run("TEST_ACTION", "TEST_TARGET", "1", "before", "after", "SUCCESS");
  const activityLogId = Number(logResult.rows[0].id);
  const changeResult = await database
    .prepare(`
      INSERT INTO employee_activity_log_changes (
        activity_log_id,
        field_name,
        before_value,
        after_value
      ) VALUES (?, ?, ?, ?) RETURNING employee_activity_log_change_id
    `)
    .run(activityLogId, "status", "BEFORE", "AFTER");
  const changeId = Number(changeResult.rows[0].employee_activity_log_change_id);

  await expectBlocked(
    database,
    "activity log update",
    `UPDATE employee_activity_logs SET result = 'FAILED' WHERE id = ${activityLogId}`,
    "employee_activity_logs is append-only"
  );
  await expectBlocked(
    database,
    "activity log delete",
    `DELETE FROM employee_activity_logs WHERE id = ${activityLogId}`,
    "employee_activity_logs is append-only"
  );
  await expectBlocked(
    database,
    "activity log change update",
    `UPDATE employee_activity_log_changes SET after_value = 'CHANGED' WHERE employee_activity_log_change_id = ${changeId}`,
    "employee_activity_log_changes is append-only"
  );
  await expectBlocked(
    database,
    "activity log change delete",
    `DELETE FROM employee_activity_log_changes WHERE employee_activity_log_change_id = ${changeId}`,
    "employee_activity_log_changes is append-only"
  );

  assert(
    Number(
      (
        await database
          .prepare("SELECT count(*) AS count FROM employee_activity_logs")
          .get()
      ).count
    ) === 1,
    "The activity log row changed during the append-only test."
  );
  assert(
    Number(
      (
        await database
          .prepare("SELECT count(*) AS count FROM employee_activity_log_changes")
          .get()
      ).count
    ) === 1,
    "The activity log change row changed during the append-only test."
  );

  console.log(
    JSON.stringify({
      requiredTriggerCount: requiredTriggers.length,
      updateBlocked: true,
      deleteBlocked: true,
    })
  );
} finally {
  await database.close();
  temporaryDatabase.cleanup();
}
