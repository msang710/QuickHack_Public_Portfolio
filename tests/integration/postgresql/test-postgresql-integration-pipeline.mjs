import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-postgresql-integration-pipeline-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
let secondClient;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { createPostgresqlPrismaClient } = await import(
    "@/quickhack_server/core/database/postgresql-client"
  );
  const {
    claimIntegrationCommand,
    executeClaimedIntegrationCommand,
    failIntegrationCommandBeforeDispatch,
    finalizeIntegrationCommand,
    IntegrationCommandConflictError,
    isIntegrationCommandOwnershipLost,
    markIntegrationDispatchStarted,
    recoverExpiredIntegrationCommands,
    registerIntegrationCommand,
  } = await import("@/quickhack_server/integration/command-service");
  const {
    IntegrationInboxValidationFailedError,
    recordValidatedIntegrationInboxEvidence,
  } = await import("@/quickhack_server/integration/inbox-service");
  const {
    claimIntegrationProjectionJob,
    isIntegrationProjectionOwnershipLost,
    runClaimedIntegrationProjection,
  } = await import("@/quickhack_server/integration/projection-service");
  const {
    expectIntegrationArray,
    expectIntegrationDecimalId,
    expectIntegrationObject,
    schemaError,
    validateIntegrationJson,
  } = await import("@/quickhack_server/integration/schema-validation");

  ({ client: secondClient } = createPostgresqlPrismaClient({
    connectionString: temporaryDatabase.databaseUrl,
    applicationName: "quickhack-integration-pipeline-test-second-connection",
  }));

  const register = (owner, input) =>
    owner.$transaction((tx) =>
      registerIntegrationCommand(tx, {
        provider: "TEST_PROVIDER",
        targetSnapshot: { targetId: input.operationKey },
        requestPayload: input.requestPayload ?? { value: 1 },
        ...input,
      })
    );

  const concurrentRegistration = await Promise.all([
    register(prisma, {
      operationType: "REGISTER_RACE",
      operationKey: "integration-register-race",
    }),
    register(secondClient, {
      operationType: "REGISTER_RACE",
      operationKey: "integration-register-race",
    }),
  ]);
  assert.equal(
    concurrentRegistration.filter((result) => result.created).length,
    1
  );
  assert.equal(
    concurrentRegistration[0].row.integration_command_id,
    concurrentRegistration[1].row.integration_command_id
  );
  await assert.rejects(
    register(prisma, {
      operationType: "REGISTER_RACE",
      operationKey: "integration-register-race",
      requestPayload: { value: 2 },
    }),
    IntegrationCommandConflictError
  );

  await Promise.all([
    register(prisma, {
      operationType: "CLAIM_RACE",
      operationKey: "integration-claim-race-a",
    }),
    register(prisma, {
      operationType: "CLAIM_RACE",
      operationKey: "integration-claim-race-b",
    }),
  ]);
  const concurrentClaims = await Promise.all([
    claimIntegrationCommand({
      owner: prisma,
      operationTypes: ["CLAIM_RACE"],
      lockSeconds: 30,
    }),
    claimIntegrationCommand({
      owner: secondClient,
      operationTypes: ["CLAIM_RACE"],
      lockSeconds: 30,
    }),
  ]);
  assert.equal(concurrentClaims.every(Boolean), true);
  assert.notEqual(
    concurrentClaims[0].command.integration_command_id,
    concurrentClaims[1].command.integration_command_id
  );
  await Promise.all(
    concurrentClaims.map((claim, index) =>
      failIntegrationCommandBeforeDispatch(
        claim,
        Object.assign(new Error("not persisted"), {
          code: `TEST_CLAIM_CLOSE_${index}`,
        }),
        index === 0 ? prisma : secondClient
      )
    )
  );

  await register(prisma, {
    operationType: "SUCCESS_WRITE",
    operationKey: "integration-success-write",
  });
  const successClaim = await claimIntegrationCommand({
    operationTypes: ["SUCCESS_WRITE"],
    lockSeconds: 30,
  });
  assert(successClaim);
  let prepareCount = 0;
  let dispatchCount = 0;
  await executeClaimedIntegrationCommand({
    claim: successClaim,
    adapter: {
      async prepare() {
        prepareCount += 1;
        return { request: "prepared" };
      },
      async dispatch() {
        dispatchCount += 1;
        return {
          httpStatusCode: 200,
          rawPayloadText: '{"code":"SUCCESS","externalId":123456789012345678}',
          providerCode: "SUCCESS",
        };
      },
      classifyResponse(response) {
        const validated = validateIntegrationJson({
          provider: "TEST_PROVIDER",
          endpoint: "success-write",
          rawText: response.rawPayloadText,
          validate(payload, context) {
            const root = expectIntegrationObject(payload, context);
            return {
              externalId: expectIntegrationDecimalId(
                root.externalId,
                context,
                "$.externalId"
              ),
            };
          },
        });
        return {
          outcome: "SUCCEEDED",
          normalizedResult: validated.normalizedResult,
          projectionHandlerKeys: ["TEST_SUCCESS_PROJECTION_V1"],
        };
      },
    },
  });
  assert.equal(prepareCount, 1);
  assert.equal(dispatchCount, 1);
  const successCommand = await prisma.integration_commands.findUniqueOrThrow({
    where: { operation_key: "integration-success-write" },
  });
  assert.equal(successCommand.command_status, "SUCCEEDED");
  assert.equal(await prisma.integration_evidences.count({
    where: { integration_command_id: successCommand.integration_command_id },
  }), 1);
  assert.equal(await prisma.integration_projection_jobs.count({
    where: { handler_key: "TEST_SUCCESS_PROJECTION_V1" },
  }), 1);

  const firstProjectionClaim = await claimIntegrationProjectionJob({
    handlerKeys: ["TEST_SUCCESS_PROJECTION_V1"],
    lockSeconds: 30,
  });
  assert(firstProjectionClaim);
  const auditEventId = randomUUID();
  let projectionRuns = 0;
  await assert.rejects(
    runClaimedIntegrationProjection({
      claim: firstProjectionClaim,
      async handler(tx, _evidence, operationKey) {
        projectionRuns += 1;
        await tx.domain_audit_events.create({
          data: {
            domain_audit_event_id: auditEventId,
            action: "INTEGRATION_TEST",
            aggregate_type: "INTEGRATION_TEST",
            aggregate_id: "success-write",
            operation_key: operationKey,
            event_type: "PROJECTION_TEST",
          },
        });
        throw Object.assign(new Error("projection failure"), {
          code: "EXPECTED_PROJECTION_FAILURE",
        });
      },
    }),
    /projection failure/
  );
  assert.equal(await prisma.domain_audit_events.count({
    where: { domain_audit_event_id: auditEventId },
  }), 0, "A failed projection must roll back its domain writes.");
  const secondProjectionClaim = await claimIntegrationProjectionJob({
    handlerKeys: ["TEST_SUCCESS_PROJECTION_V1"],
    lockSeconds: 30,
  });
  assert(secondProjectionClaim);
  await assert.rejects(
    runClaimedIntegrationProjection({
      claim: firstProjectionClaim,
      async handler() {
        throw new Error("stale handler must not run");
      },
    }),
    (error) => isIntegrationProjectionOwnershipLost(error)
  );
  await runClaimedIntegrationProjection({
    claim: secondProjectionClaim,
    async handler(tx, _evidence, operationKey) {
      projectionRuns += 1;
      await tx.domain_audit_events.create({
        data: {
          domain_audit_event_id: auditEventId,
          action: "INTEGRATION_TEST",
          aggregate_type: "INTEGRATION_TEST",
          aggregate_id: "success-write",
          operation_key: operationKey,
          event_type: "PROJECTION_TEST",
        },
      });
    },
  });
  assert.equal(projectionRuns, 2);
  assert.equal(dispatchCount, 1, "Projection retry must not repeat external HTTP.");
  assert.equal(await prisma.domain_audit_events.count({
    where: { domain_audit_event_id: auditEventId },
  }), 1);
  assert.equal(await prisma.domain_operation_keys.count({
    where: { scope: "INTEGRATION_PROJECTION" },
  }), 1);

  await register(prisma, {
    operationType: "REJECTED_WRITE",
    operationKey: "integration-rejected-write",
  });
  const rejectedClaim = await claimIntegrationCommand({
    operationTypes: ["REJECTED_WRITE"],
    lockSeconds: 30,
  });
  assert(rejectedClaim);
  await executeClaimedIntegrationCommand({
    claim: rejectedClaim,
    adapter: {
      async prepare() {
        return {};
      },
      async dispatch() {
        return {
          httpStatusCode: 400,
          rawPayloadText: '{"code":"INVALID_REQUEST"}',
          providerCode: "INVALID_REQUEST",
        };
      },
      classifyResponse() {
        return { outcome: "NOT_APPLIED", errorCode: "INVALID_REQUEST" };
      },
    },
  });
  assert.equal((await prisma.integration_commands.findUniqueOrThrow({
    where: { operation_key: "integration-rejected-write" },
  })).command_status, "NOT_APPLIED");

  await register(prisma, {
    operationType: "TIMEOUT_WRITE",
    operationKey: "integration-timeout-write",
  });
  const timeoutClaim = await claimIntegrationCommand({
    operationTypes: ["TIMEOUT_WRITE"],
    lockSeconds: 30,
  });
  assert(timeoutClaim);
  let timeoutDispatches = 0;
  await executeClaimedIntegrationCommand({
    claim: timeoutClaim,
    adapter: {
      async prepare() {
        return {};
      },
      async dispatch() {
        timeoutDispatches += 1;
        throw Object.assign(new Error("secret transport detail"), {
          code: "TIMEOUT_ERROR",
        });
      },
      classifyResponse() {
        throw new Error("unreachable");
      },
    },
  });
  assert.equal(timeoutDispatches, 1);
  const timeoutCommand = await prisma.integration_commands.findUniqueOrThrow({
    where: { operation_key: "integration-timeout-write" },
  });
  assert.equal(timeoutCommand.command_status, "AMBIGUOUS");
  assert.equal(await claimIntegrationCommand({
    operationTypes: ["TIMEOUT_WRITE"],
    lockSeconds: 30,
  }), null, "AMBIGUOUS commands must not be automatically redispatched.");
  const timeoutAttempt = await prisma.integration_command_attempts.findFirstOrThrow({
    where: { integration_command_id: timeoutCommand.integration_command_id },
  });
  assert.equal(timeoutAttempt.error_message, null);

  await register(prisma, {
    operationType: "MALFORMED_RESPONSE",
    operationKey: "integration-malformed-response",
  });
  const malformedClaim = await claimIntegrationCommand({
    operationTypes: ["MALFORMED_RESPONSE"],
    lockSeconds: 30,
  });
  assert(malformedClaim);
  await executeClaimedIntegrationCommand({
    claim: malformedClaim,
    adapter: {
      async prepare() {
        return {};
      },
      async dispatch() {
        return { httpStatusCode: 200, rawPayloadText: '{"broken":' };
      },
      classifyResponse(response) {
        validateIntegrationJson({
          provider: "TEST_PROVIDER",
          endpoint: "malformed-response",
          rawText: response.rawPayloadText,
          validate: () => ({}),
        });
        return { outcome: "SUCCEEDED" };
      },
    },
  });
  assert.equal((await prisma.integration_commands.findUniqueOrThrow({
    where: { operation_key: "integration-malformed-response" },
  })).command_status, "AMBIGUOUS");

  await register(prisma, {
    operationType: "EXPIRE_BEFORE_DISPATCH",
    operationKey: "integration-expire-before-dispatch",
  });
  const preDispatchClaim = await claimIntegrationCommand({
    operationTypes: ["EXPIRE_BEFORE_DISPATCH"],
    lockSeconds: 30,
  });
  assert(preDispatchClaim);
  await prisma.integration_commands.update({
    where: {
      integration_command_id: preDispatchClaim.command.integration_command_id,
    },
    data: { locked_until: new Date(0) },
  });
  const recoveredBefore = await recoverExpiredIntegrationCommands();
  assert.equal(recoveredBefore.requeued, 1);
  const replacementClaim = await claimIntegrationCommand({
    operationTypes: ["EXPIRE_BEFORE_DISPATCH"],
    lockSeconds: 30,
  });
  assert(replacementClaim);
  await assert.rejects(
    failIntegrationCommandBeforeDispatch(preDispatchClaim, new Error("stale")),
    (error) => isIntegrationCommandOwnershipLost(error)
  );
  await failIntegrationCommandBeforeDispatch(
    replacementClaim,
    Object.assign(new Error("configuration missing"), {
      code: "EXPECTED_LOCAL_FAILURE",
    })
  );

  await register(prisma, {
    operationType: "EXPIRE_AFTER_DISPATCH",
    operationKey: "integration-expire-after-dispatch",
  });
  const postDispatchClaim = await claimIntegrationCommand({
    operationTypes: ["EXPIRE_AFTER_DISPATCH"],
    lockSeconds: 30,
  });
  assert(postDispatchClaim);
  await markIntegrationDispatchStarted(postDispatchClaim);
  await prisma.integration_commands.update({
    where: {
      integration_command_id: postDispatchClaim.command.integration_command_id,
    },
    data: { locked_until: new Date(0) },
  });
  const recoveredAfter = await recoverExpiredIntegrationCommands();
  assert.equal(recoveredAfter.ambiguous, 1);
  await assert.rejects(
    finalizeIntegrationCommand({
      claim: postDispatchClaim,
      outcome: "SUCCEEDED",
      responseReceived: true,
      rawPayloadText: '{"code":"LATE_SUCCESS"}',
    }),
    (error) => isIntegrationCommandOwnershipLost(error)
  );
  assert.equal((await prisma.integration_commands.findUniqueOrThrow({
    where: { operation_key: "integration-expire-after-dispatch" },
  })).command_status, "AMBIGUOUS");

  const inboundRaw =
    '{"data":[{"shipmentBoxId":123456789012345678},{"shipmentBoxId":123456789012345679}]}';
  const inboxResult = await recordValidatedIntegrationInboxEvidence({
    provider: "TEST_PROVIDER",
    endpoint: "inbound-orders",
    evidenceType: "INBOUND_ORDERS",
    rawPayloadText: inboundRaw,
    projectionHandlerKeys: ["TEST_INBOX_PROJECTION_V1"],
    validate(payload, context) {
      const root = expectIntegrationObject(payload, context);
      const rows = expectIntegrationArray(root.data, context, "$.data");
      return rows.map((value, index) => {
        const row = expectIntegrationObject(value, context, `$.data[${index}]`);
        return {
          shipmentBoxId: expectIntegrationDecimalId(
            row.shipmentBoxId,
            context,
            `$.data[${index}].shipmentBoxId`
          ),
        };
      });
    },
  });
  assert.equal(inboxResult.projectionJobs.length, 1);
  assert.deepEqual(inboxResult.evidence.normalized_result, [
    { shipmentBoxId: "123456789012345678" },
    { shipmentBoxId: "123456789012345679" },
  ]);

  let invalidInboxError;
  try {
    await recordValidatedIntegrationInboxEvidence({
      provider: "TEST_PROVIDER",
      endpoint: "inbound-orders",
      evidenceType: "INBOUND_ORDERS",
      rawPayloadText: '{"applicationError":true}',
      projectionHandlerKeys: ["MUST_NOT_BE_CREATED"],
      validate(payload, context) {
        const root = expectIntegrationObject(payload, context);
        if (root.applicationError === true) {
          return schemaError({
            ...context,
            path: "$.applicationError",
            reason: "APPLICATION_ERROR",
          });
        }
        return {};
      },
    });
  } catch (error) {
    invalidInboxError = error;
  }
  assert(invalidInboxError instanceof IntegrationInboxValidationFailedError);
  assert.equal(invalidInboxError.validationCode, "INTEGRATION_SCHEMA_INVALID");
  const invalidEvidence = await prisma.integration_evidences.findUniqueOrThrow({
    where: { integration_evidence_id: invalidInboxError.evidenceId },
  });
  assert.equal(invalidEvidence.outcome, "FAILED_LOCAL");
  assert.deepEqual(invalidEvidence.normalized_result, {
    validationCode: "INTEGRATION_SCHEMA_INVALID",
    path: "$.applicationError",
    reason: "APPLICATION_ERROR",
  });
  assert.equal(await prisma.integration_projection_jobs.count({
    where: { handler_key: "MUST_NOT_BE_CREATED" },
  }), 0);

  assert.equal(
    await prisma.integration_projection_jobs.count({
      where: {
        integration_evidence_id: inboxResult.evidence.integration_evidence_id,
        handler_key: "TEST_INBOX_PROJECTION_V1",
      },
    }),
    1
  );
  assert.equal(
    await prisma.integration_evidences.count({
      where: {
        raw_payload_text: { contains: "secret transport detail" },
      },
    }),
    0,
    "Thrown transport messages must not be copied into durable evidence."
  );

  console.log(
    "PostgreSQL integration command, evidence, ambiguity, projection retry, and stale-lease invariants verified."
  );
} finally {
  await secondClient?.$disconnect();
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
