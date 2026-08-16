import nodeAssert from "node:assert/strict";
import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { openPostgresqlTestDatabase } from "../../support/postgresql-database.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-carrier-invoice-replacement-ownership-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function at(value) {
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

try {
  const db = openPostgresqlTestDatabase(temporaryDatabase.databaseUrl);
  try {
    const packageGroup = await db.prepare(`
      INSERT INTO shipment_package_groups(
        grouping_key, receiver_name_snapshot, receiver_address_snapshot
      ) VALUES ('replacement-ownership-group', 'receiver', 'address')
      RETURNING package_group_id
    `).get();
    const shipment = await db.prepare(`
      INSERT INTO carrier_shipments(
        carrier_code, source_type, package_group_id, tracking_number,
        invoice_status, shipment_status
      ) VALUES ('LOGEN', 'SELF_PRINT', ?, '99900000001', 'REGISTERED', 'REGISTERED')
      RETURNING carrier_shipment_id
    `).get(packageGroup.package_group_id);
    await db.prepare(`
      INSERT INTO carrier_invoice_replacement_works(
        source_type, request_key, work_status, current_stage,
        old_invoice_handling_status, package_group_id,
        old_carrier_shipment_id, reason_code, updated_at
      ) VALUES (
        'MANUAL', 'replacement-ownership-test', 'PROCESSING', 'ALLOCATION',
        'NOT_REQUIRED', ?, ?, 'TEST', '2026-08-08 10:00:00'
      )
    `).run(packageGroup.package_group_id, shipment.carrier_shipment_id);
  } finally {
    await db.close();
  }

  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const ownership = await import(
    "@/quickhack_server/shipment/carrier-integration/carrier-invoice-replacement-execution-ownership"
  );

  const first = await ownership.claimReplacementExecution({ workId: 1 });
  assert(first.workflowVersion === 1, "The first claim did not advance the workflow version.");
  await nodeAssert.rejects(
    ownership.claimReplacementExecution({ workId: 1 }),
    (error) => error?.code === "REPLACEMENT_EXECUTION_IN_PROGRESS"
  );

  const releasedVersion = await ownership.releaseReplacementExecution({
    workId: 1,
    executionToken: first.executionToken,
    workflowVersion: first.workflowVersion,
    data: {
      work_status: "REVIEW_REQUIRED",
      last_error_code: "TEST_REVIEW",
      review_required_at: at("2026-08-08 10:01:00"),
      updated_at: at("2026-08-08 10:01:00"),
    },
  });
  assert(releasedVersion === 2, "Release did not advance the workflow version.");

  const staleOwner = await ownership.claimReplacementExecution({ workId: 1 });
  await prisma.carrier_invoice_replacement_works.update({
    where: { carrier_invoice_replacement_work_id: 1 },
    data: { execution_started_at: at("2000-01-01 00:00:00") },
  });
  const takeover = await ownership.claimReplacementExecution({ workId: 1 });
  assert(
    takeover.executionToken !== staleOwner.executionToken,
    "A stale execution token was not replaced."
  );
  await nodeAssert.rejects(
    ownership.updateOwnedReplacement({
      workId: 1,
      executionToken: staleOwner.executionToken,
      workflowVersion: staleOwner.workflowVersion,
      data: { work_status: "PROCESSING" },
    }),
    (error) => error?.code === "REPLACEMENT_EXECUTION_OWNERSHIP_LOST"
  );

  await ownership.releaseReplacementExecution({
    workId: 1,
    executionToken: takeover.executionToken,
    workflowVersion: takeover.workflowVersion,
    data: {
      work_status: "CANCELED",
      canceled_at: at("2026-08-08 10:02:00"),
      updated_at: at("2026-08-08 10:02:00"),
    },
  });
  await nodeAssert.rejects(
    ownership.claimReplacementExecution({ workId: 1 }),
    (error) => error?.code === "REPLACEMENT_WORK_TERMINAL"
  );
  const stored = await prisma.carrier_invoice_replacement_works.findUniqueOrThrow({
    where: { carrier_invoice_replacement_work_id: 1 },
  });
  assert(stored.work_status === "CANCELED", "A terminal replacement status was not preserved.");
  assert(stored.execution_token === null, "A terminal replacement retained an execution token.");

  console.log("Carrier invoice replacement execution ownership tests passed.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
