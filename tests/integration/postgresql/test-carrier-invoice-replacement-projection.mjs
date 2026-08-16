import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { openPostgresqlTestDatabase } from "../../support/postgresql-database.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-carrier-invoice-replacement-projection-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function at(value) {
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

try {
  const db = openPostgresqlTestDatabase(temporaryDatabase.databaseUrl);
  try {
    await db.exec(`
      INSERT INTO shipment_package_groups(
        package_group_id, grouping_key, receiver_name_snapshot,
        receiver_address_snapshot, group_status
      ) VALUES (8801, 'projection-group', 'receiver', 'address', 'ON_HOLD');

      INSERT INTO carrier_shipments(
        carrier_shipment_id, carrier_code, source_type, package_group_id,
        tracking_number, revision_no, invoice_status, shipment_status
      ) VALUES
        (8801, 'LOGEN', 'SELF_PRINT', 8801, '88000000001', 1, 'REPLACED', 'REGISTERED'),
        (8802, 'LOGEN', 'SELF_PRINT', 8801, '88000000002', 2, 'REGISTERED', 'REGISTERED');

      UPDATE shipment_package_groups
      SET current_carrier_shipment_id = 8802
      WHERE package_group_id = 8801;

      INSERT INTO sales_channel_shipment_list_print_batches(
        shipment_list_print_batch_id, tab_key, tab_label, print_date,
        batch_no, batch_label, batch_status
      ) VALUES (8801, 'projection-tab', 'projection-tab', '2026-08-08', 1, 'projection-batch', 'CONFIRMED');

      INSERT INTO carrier_invoice_issue_batches(
        carrier_invoice_issue_batch_id, shipment_list_print_batch_id,
        request_key, batch_status, requested_package_group_count,
        allocated_package_group_count, response_item_count,
        label_print_status
      ) VALUES (8801, 8801, 'projection-batch', 'ALLOCATED', 1, 1, 1, 'NOT_PRINTED');

      INSERT INTO carrier_invoice_issue_items(
        carrier_invoice_issue_item_id, carrier_invoice_issue_batch_id,
        package_group_id, issue_sequence, item_status,
        carrier_shipment_id, tracking_number_snapshot
      ) VALUES (8801, 8801, 8801, 1, 'ALLOCATED', 8802, '88000000002');

      INSERT INTO carrier_shipment_registration_works(
        carrier_shipment_registration_work_id, carrier_shipment_id,
        carrier_invoice_issue_item_id, package_group_id, work_status,
        fix_take_no, take_date, registered_at
      ) VALUES (8801, 8802, 8801, 8801, 'REGISTERED', 'QH-PROJECTION', '20260808', '2026-08-08 10:00:00');

      INSERT INTO carrier_invoice_replacement_works(
        carrier_invoice_replacement_work_id, source_type, request_key,
        work_status, current_stage, old_invoice_handling_status,
        package_group_id, old_carrier_shipment_id,
        candidate_carrier_shipment_id, carrier_invoice_issue_batch_id,
        reason_code, channel_updated_at
      ) VALUES (
        8801, 'MANUAL', 'projection-replacement', 'PROCESSING',
        'CARRIER_REGISTRATION', 'NOT_REQUIRED', 8801, 8801, 8802, 8801,
        'TEST', '2026-08-08 09:59:00'
      );
    `);
  } finally {
    await db.close();
  }

  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { projectReplacementFromIssueBatch } = await import(
    "@/quickhack_server/shipment/carrier-integration/carrier-invoice-replacement-projection-service"
  );
  const {
    getCarrierInvoiceReplacement,
    listCarrierInvoiceReplacements,
  } = await import(
    "@/quickhack_server/shipment/carrier-integration/coupang-invoice-replacement-service"
  );

  const beforeRead = await getCarrierInvoiceReplacement({
    replacementWorkId: 8801,
  });
  assert(beforeRead.status === "PROCESSING", "The read returned an unexpected parent status.");
  const listed = await listCarrierInvoiceReplacements();
  assert(listed.items.length === 1, "The replacement list omitted the test work.");
  const afterPureRead =
    await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
      where: { carrier_invoice_replacement_work_id: 8801 },
    });
  assert(afterPureRead.workflow_version === 0, "GET or list mutated replacement progress.");

  await prisma.carrier_invoice_replacement_works.update({
    where: { carrier_invoice_replacement_work_id: 8801 },
    data: {
      execution_token: "active-parent-owner",
      execution_started_at: at("2026-08-08 10:00:30"),
    },
  });
  await projectReplacementFromIssueBatch({ issueBatchId: 8801 });
  const ownedWork =
    await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
      where: { carrier_invoice_replacement_work_id: 8801 },
    });
  assert(ownedWork.work_status === "PROCESSING", "Child projection overwrote an owned parent execution.");
  await prisma.carrier_invoice_replacement_works.update({
    where: { carrier_invoice_replacement_work_id: 8801 },
    data: { execution_token: null, execution_started_at: null },
  });

  await projectReplacementFromIssueBatch({
    issueBatchId: 8801,
    projectedAt: at("2026-08-08 10:01:00"),
  });
  let work = await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
    where: { carrier_invoice_replacement_work_id: 8801 },
  });
  assert(work.work_status === "WAITING_LABEL", "Registration was not projected to WAITING_LABEL.");
  assert(work.current_stage === "LABEL_PRINT", "Registration did not advance the parent stage.");
  const projectedVersion = work.workflow_version;

  await projectReplacementFromIssueBatch({ issueBatchId: 8801 });
  work = await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
    where: { carrier_invoice_replacement_work_id: 8801 },
  });
  assert(work.workflow_version === projectedVersion, "Idempotent projection changed the workflow version.");

  await prisma.carrier_shipment_registration_works.update({
    where: { carrier_shipment_registration_work_id: 8801 },
    data: { work_status: "BLOCKED", last_error_code: "LATE_BLOCKED" },
  });
  await projectReplacementFromIssueBatch({ issueBatchId: 8801 });
  work = await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
    where: { carrier_invoice_replacement_work_id: 8801 },
  });
  assert(work.current_stage === "LABEL_PRINT", "A late registration result regressed the parent stage.");
  assert(work.workflow_version === projectedVersion, "A regressive child result changed the parent version.");
  await prisma.carrier_shipment_registration_works.update({
    where: { carrier_shipment_registration_work_id: 8801 },
    data: { work_status: "REGISTERED", last_error_code: null },
  });

  await prisma.carrier_invoice_issue_batches.update({
    where: { carrier_invoice_issue_batch_id: 8801 },
    data: {
      label_print_status: "UNKNOWN",
      label_last_error_code: "PRINT_RESULT_UNKNOWN",
    },
  });
  await projectReplacementFromIssueBatch({
    issueBatchId: 8801,
    projectedAt: at("2026-08-08 10:02:00"),
  });
  work = await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
    where: { carrier_invoice_replacement_work_id: 8801 },
  });
  assert(work.work_status === "REVIEW_REQUIRED", "Unknown print was not projected to review.");

  await prisma.carrier_invoice_issue_batches.update({
    where: { carrier_invoice_issue_batch_id: 8801 },
    data: {
      label_print_status: "CONFIRMED",
      label_confirmed_at: at("2026-08-08 10:03:00"),
      label_last_error_code: null,
    },
  });
  await projectReplacementFromIssueBatch({
    issueBatchId: 8801,
    projectedAt: at("2026-08-08 10:03:00"),
  });
  work = await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
    where: { carrier_invoice_replacement_work_id: 8801 },
  });
  const group = await prisma.shipment_package_groups.findUniqueOrThrow({
    where: { package_group_id: 8801 },
  });
  assert(work.work_status === "COMPLETED", "Confirmed label did not complete the replacement.");
  assert(work.execution_token === null, "Completed replacement retained execution ownership.");
  assert(group.group_status === "READY", "Completed replacement did not release the package group.");

  await prisma.carrier_invoice_issue_batches.update({
    where: { carrier_invoice_issue_batch_id: 8801 },
    data: { label_print_status: "FAILED" },
  });
  await projectReplacementFromIssueBatch({ issueBatchId: 8801 });
  work = await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
    where: { carrier_invoice_replacement_work_id: 8801 },
  });
  assert(work.work_status === "COMPLETED", "A late child result regressed a terminal replacement.");

  console.log("Carrier invoice replacement projection tests passed.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
