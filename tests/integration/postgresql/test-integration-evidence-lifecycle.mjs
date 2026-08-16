import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-integration-evidence-lifecycle-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { recordValidatedIntegrationInboxEvidence } = await import(
    "@/quickhack_server/integration/inbox-service"
  );
  const {
    minimizeCoupangOrdersheetEvidenceForStorage,
    scrubCoupangOrdersheetIntegrationEvidence,
  } = await import(
    "@/quickhack_server/integration/integration-evidence-lifecycle"
  );
  const { digestRawIntegrationPayload } = await import(
    "@/quickhack_server/integration/schema-validation"
  );

  const piiMarker = "QH-R09-RECIPIENT-010-1234-5678";
  const rawPayloadText = JSON.stringify({
    orders: [
      {
        orderId: "ORDER-R09-NEW",
        receiverName: piiMarker,
        address: "PRIVATE-ADDRESS-R09",
      },
    ],
    nextToken: "PRIVATE-NEXT-TOKEN-R09",
  });
  const recorded = await recordValidatedIntegrationInboxEvidence({
    provider: "COUPANG",
    endpoint: "/v2/providers/openapi/apis/api/v4/vendors/ordersheets",
    evidenceType: "COUPANG_ORDERSHEET_PAGE",
    rawPayloadText,
    validate: (payload) => payload,
    storagePolicy: {
      retainRawPayload: false,
      minimizeNormalizedResult:
        minimizeCoupangOrdersheetEvidenceForStorage,
    },
  });
  assert.equal(recorded.normalizedResult.orders[0].receiverName, piiMarker);
  const stored = await prisma.integration_evidences.findUniqueOrThrow({
    where: {
      integration_evidence_id:
        recorded.evidence.integration_evidence_id,
    },
  });
  assert.equal(stored.raw_payload_text, null);
  assert.equal(
    stored.raw_payload_digest,
    digestRawIntegrationPayload(rawPayloadText)
  );
  assert.deepEqual(stored.normalized_result, {
    storagePolicyVersion: 1,
    evidenceType: "COUPANG_ORDERSHEET_PAGE",
    outcome: "SUCCEEDED",
    rowCount: 1,
    hasNextPage: true,
  });
  assert.equal(JSON.stringify(stored.normalized_result).includes(piiMarker), false);

  async function createLegacy(index, hold = false) {
    const raw = JSON.stringify({
      orders: [{ receiverName: `${piiMarker}-${index}` }],
      nextToken: `LEGACY-TOKEN-${index}`,
    });
    const evidence = await prisma.integration_evidences.create({
      data: {
        integration_evidence_id: randomUUID(),
        provider: "COUPANG",
        evidence_type: "COUPANG_ORDERSHEET_PAGE",
        outcome: "SUCCEEDED",
        raw_payload_text: raw,
        raw_payload_digest: digestRawIntegrationPayload(raw),
        normalized_result: JSON.parse(raw),
        received_at: new Date(`2026-01-0${index}T00:00:00.000Z`),
        created_at: new Date(`2026-01-0${index}T00:00:00.000Z`),
      },
    });
    if (hold) {
      await prisma.integration_projection_jobs.create({
        data: {
          integration_projection_job_id: randomUUID(),
          integration_evidence_id: evidence.integration_evidence_id,
          handler_key: `R09-HOLD-${index}`,
          projection_status: "PENDING",
        },
      });
    }
    return evidence;
  }

  const firstLegacy = await createLegacy(1);
  const secondLegacy = await createLegacy(2);
  const heldLegacy = await createLegacy(3, true);
  const firstDigest = firstLegacy.raw_payload_digest;

  const dryRun = await scrubCoupangOrdersheetIntegrationEvidence({
    dryRun: true,
    maxBatchSize: 1,
    now: new Date("2026-08-17T00:00:00.000Z"),
  });
  assert.equal(dryRun.attemptedCount, 1);
  assert.equal(dryRun.changedCount, 0);
  assert.equal(dryRun.backlogCount, 2);
  assert.notEqual(
    (
      await prisma.integration_evidences.findUniqueOrThrow({
        where: {
          integration_evidence_id: firstLegacy.integration_evidence_id,
        },
      })
    ).raw_payload_text,
    null
  );

  const firstRun = await scrubCoupangOrdersheetIntegrationEvidence({
    maxBatchSize: 1,
    now: new Date("2026-08-17T00:00:00.000Z"),
  });
  assert.equal(firstRun.changedCount, 1);
  assert.equal(firstRun.backlogCount, 1);
  const scrubbedFirst =
    await prisma.integration_evidences.findUniqueOrThrow({
      where: {
        integration_evidence_id: firstLegacy.integration_evidence_id,
      },
    });
  assert.equal(scrubbedFirst.raw_payload_text, null);
  assert.equal(scrubbedFirst.raw_payload_digest, firstDigest);
  assert.equal(
    JSON.stringify(scrubbedFirst.normalized_result).includes(piiMarker),
    false
  );

  const secondRun = await scrubCoupangOrdersheetIntegrationEvidence({
    maxBatchSize: 1,
    now: new Date("2026-08-17T00:00:00.000Z"),
  });
  assert.equal(secondRun.changedCount, 1);
  assert.equal(secondRun.backlogCount, 0);
  assert.equal(
    (
      await prisma.integration_evidences.findUniqueOrThrow({
        where: {
          integration_evidence_id: secondLegacy.integration_evidence_id,
        },
      })
    ).raw_payload_text,
    null
  );
  assert.notEqual(
    (
      await prisma.integration_evidences.findUniqueOrThrow({
        where: {
          integration_evidence_id: heldLegacy.integration_evidence_id,
        },
      })
    ).raw_payload_text,
    null,
    "An evidence row with unfinished projection work was scrubbed."
  );

  console.log("Integration ordersheet evidence minimization lifecycle verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
