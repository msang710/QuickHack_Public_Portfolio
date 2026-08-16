import assert from "node:assert/strict";
import { createTemporaryDatabase } from "../../support/postgresql-test-scope.mjs";
import { openPostgresqlTestDatabase } from "../../support/postgresql-database.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-carrier-schema-");
const db = openPostgresqlTestDatabase(temporaryDatabase.databaseUrl);

try {
  const tableNames = (await db
    .prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()")
    .all())
    .map((row) => row.table_name);
  for (const table of [
    "carrier_shipments",
    "carrier_tracking_events",
    "carrier_return_requests",
    "carrier_api_call_logs",
    "carrier_reconciliation_works",
    "carrier_invoice_issue_batches",
    "carrier_invoice_issue_items",
    "carrier_invoice_replacement_works",
    "carrier_shipment_registration_works",
    "carrier_integration_settings",
  ]) {
    assert.ok(tableNames.includes(table), `missing table: ${table}`);
  }
  const issueBatchColumns = new Set(
    (await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'carrier_invoice_issue_batches'").all())
      .map((column) => column.column_name)
  );
  const issueItemColumns = new Set(
    (await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'carrier_invoice_issue_items'").all())
      .map((column) => column.column_name)
  );
  const registrationColumns = new Set(
    (await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'carrier_shipment_registration_works'").all())
      .map((column) => column.column_name)
  );
  const replacementColumns = new Set(
    (await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'carrier_invoice_replacement_works'").all())
      .map((column) => column.column_name)
  );
  const settingsColumns = new Set(
    (await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'carrier_integration_settings'").all())
      .map((column) => column.column_name)
  );
  for (const column of [
    "carrier_code",
    "sender_name",
    "sender_tel",
    "sender_cell",
    "sender_zip_code",
    "sender_address_1",
    "sender_address_2",
    "default_box_type_code",
    "revision",
    "updated_by_user_id",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(settingsColumns.has(column), `missing carrier setting column: ${column}`);
  }
  for (const removedColumn of [
    "live_write_enabled",
    "live_preprint_registration_enabled",
  ]) {
    assert.equal(
      settingsColumns.has(removedColumn),
      false,
      `removed carrier setting column is still active: ${removedColumn}`
    );
  }
  for (const column of [
    "allocation_request_dispatched",
    "label_print_status",
    "label_active_request_key",
    "label_print_attempt_count",
  ]) {
    assert.ok(issueBatchColumns.has(column), `missing issue batch column: ${column}`);
  }
  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO carrier_invoice_issue_batches(
        shipment_list_print_batch_id, request_key, batch_status,
        requested_package_group_count, attempt_count,
        allocation_request_dispatched, started_at
      ) VALUES (999999, 'invalid-dispatch-marker', 'ALLOCATING', 1, 1, 2, '2026-08-07 10:00:00')
    `).run();
  }, /ck_carrier_invoice_issue_batches_dispatch_marker/);
  for (const column of [
    "label_print_status",
    "label_payload_hash",
    "label_print_attempt_no",
    "label_print_count",
  ]) {
    assert.ok(issueItemColumns.has(column), `missing issue item column: ${column}`);
  }
  for (const column of [
    "workflow_version",
    "execution_token",
    "execution_started_at",
  ]) {
    assert.ok(
      replacementColumns.has(column),
      `missing replacement ownership column: ${column}`
    );
  }
  for (const column of [
    "customer_code_snapshot",
    "sender_name_snapshot",
    "receiver_dong_name",
    "sales_office_name",
    "terminal_name",
  ]) {
    assert.ok(
      registrationColumns.has(column),
      `missing label registration snapshot column: ${column}`
    );
  }

  const shipment = await db
    .prepare(`
      INSERT INTO carrier_shipments(
        carrier_code, source_type, tracking_number, invoice_status, shipment_status
      ) VALUES ('LOGEN', 'SELF_PRINT', '10000000001', 'REGISTERED', 'REGISTERED')
      RETURNING carrier_shipment_id
    `)
    .get();
  assert.ok(shipment.carrier_shipment_id > 0);

  await db.prepare(`
    INSERT INTO carrier_tracking_events(
      carrier_shipment_id, event_fingerprint, scan_date, scan_time, status_name
    ) VALUES (?, 'event-1', '20260719', '120000', '배송완료')
  `).run(shipment.carrier_shipment_id);

  await db.prepare(`
    INSERT INTO carrier_return_requests(
      carrier_code, take_no, carrier_shipment_id, original_tracking_number,
      return_tracking_number, reservation_status
    ) VALUES ('LOGEN', '240504000001', ?, '10000000001', '10000000002', '10')
  `).run(shipment.carrier_shipment_id);

  const apiCall = await db
    .prepare(`
      INSERT INTO carrier_api_call_logs(
        carrier_code, carrier_shipment_id, api_name, endpoint_path, method,
        operation_type, processed_status
      ) VALUES ('LOGEN', ?, 'slipPrintM', '/lrm02b-edi/edi/slipPrintM', 'POST', 'WRITE', 'SUCCEEDED')
      RETURNING carrier_api_call_log_id
    `)
    .get(shipment.carrier_shipment_id);

  await db.prepare(`
    INSERT INTO carrier_reconciliation_works(
      carrier_code, operation_type, lookup_key_type, lookup_key_value,
      reconciliation_status, api_call_log_id
    ) VALUES ('LOGEN', 'slipPrintM', 'TRACKING_NUMBER', '10000000001', 'PENDING', ?)
  `).run(apiCall.carrier_api_call_log_id);

  await assert.rejects(async () => {
    await db.prepare(`
      INSERT INTO carrier_shipments(
        carrier_code, source_type, tracking_number, invoice_status, shipment_status
      ) VALUES ('LOGEN', 'SELF_PRINT', '10000000003', 'INVALID', 'REGISTERED')
    `).run();
  }, /ck_carrier_shipments_invoice_status/);

  await db.prepare("DELETE FROM carrier_shipments WHERE carrier_shipment_id = ?")
    .run(shipment.carrier_shipment_id);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS count FROM carrier_tracking_events").get()).count),
    0
  );
  assert.equal(
    (await db.prepare("SELECT carrier_shipment_id FROM carrier_return_requests").get())
      .carrier_shipment_id,
    null
  );

  console.log("Carrier integration schema tests passed.");
} finally {
  await db.close();
  temporaryDatabase.cleanup();
}
