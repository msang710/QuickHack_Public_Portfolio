import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-domain-audit-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    appendDomainAuditEvent,
    appendDomainAuditEvents,
    defineDomainAuditEvent,
    DomainAuditContractError,
  } = await import("@/quickhack_server/audit/domain-audit-service");

  const contract = defineDomainAuditEvent({
    eventType: "TEST_INVENTORY_CORRECTION",
    allowedFieldPaths: ["inventory.status", "inventory.quantity", "result.outcome"],
  });
  const occurredAt = new Date("2026-08-13T01:00:00.000Z");
  const stored = await prisma.$transaction((tx) =>
    appendDomainAuditEvent(tx, {
      contract,
      action: "CORRECT_INVENTORY",
      aggregateType: "INVENTORY_SKU",
      aggregateId: 42,
      operationKey: "audit-test-42",
      occurredAt,
      changes: [
        { fieldPath: "inventory.status", before: "HOLD", after: "SELLABLE" },
        { fieldPath: "inventory.quantity", before: 1, after: 2 },
      ],
    })
  );
  assert.equal(stored.event_type, "TEST_INVENTORY_CORRECTION");
  assert.deepEqual(
    stored.changes.map((change) => change.field_path),
    ["inventory.quantity", "inventory.status"]
  );
  assert.equal(stored.changes[0].before_value, "1");
  assert.equal(stored.changes[0].after_value, "2");

  await assert.rejects(
    () =>
      prisma.$transaction((tx) =>
        appendDomainAuditEvent(tx, {
          contract,
          action: "CORRECT_INVENTORY",
          aggregateType: "INVENTORY_SKU",
          aggregateId: 43,
          changes: [
            { fieldPath: "receiver.name", before: null, after: "PII" },
          ],
        })
      ),
    DomainAuditContractError
  );
  await assert.rejects(
    () =>
      prisma.$transaction((tx) =>
        appendDomainAuditEvent(tx, {
          contract,
          action: "CORRECT_INVENTORY",
          aggregateType: "INVENTORY_SKU",
          aggregateId: 44,
          changes: [
            { fieldPath: "inventory.status", before: "HOLD", after: ["SELLABLE"] },
          ],
        })
      ),
    DomainAuditContractError
  );
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await appendDomainAuditEvent(tx, {
          contract,
          action: "CORRECT_INVENTORY",
          aggregateType: "INVENTORY_SKU",
          aggregateId: 45,
          changes: [
            { fieldPath: "inventory.status", before: "HOLD", after: "SELLABLE" },
          ],
        });
        throw new Error("force business rollback");
      }),
    /force business rollback/
  );
  assert.equal(
    await prisma.domain_audit_events.count({ where: { aggregate_id: "45" } }),
    0
  );

  const batch = await prisma.$transaction((tx) =>
    appendDomainAuditEvents(tx, [
      {
        contract,
        action: "CORRECT_INVENTORY",
        aggregateType: "INVENTORY_SKU",
        aggregateId: 46,
        changes: [{ fieldPath: "result.outcome", before: null, after: "SUCCEEDED" }],
      },
      {
        contract,
        action: "CORRECT_INVENTORY",
        aggregateType: "INVENTORY_SKU",
        aggregateId: 47,
        changes: [{ fieldPath: "result.outcome", before: null, after: "REJECTED" }],
      },
    ])
  );
  assert.equal(batch.length, 2);
  assert.notEqual(batch[0].domain_audit_event_id, batch[1].domain_audit_event_id);

  await assert.rejects(() =>
    prisma.domain_audit_events.update({
      where: { domain_audit_event_id: stored.domain_audit_event_id },
      data: { action: "MUTATED" },
    })
  );
  await assert.rejects(() =>
    prisma.domain_audit_event_changes.delete({
      where: {
        domain_audit_event_change_id: stored.changes[0].domain_audit_event_change_id,
      },
    })
  );

  console.log(
    "Canonical domain audit allowlist, per-target events, rollback, and append-only database guards verified."
  );
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
