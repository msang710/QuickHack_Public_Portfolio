import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-inventory-quantity-repair-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
process.env.COUPANG_WRITE_API_ENABLED = "true";

function databaseTimestamp(value) {
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

const timestampText = "2026-08-02 12:00:00";
const timestamp = databaseTimestamp(timestampText);
let prisma;

function writeResponse() {
  return {
    mode: "mock",
    source: "inventory-repair-test",
    requestPath: "/vendor-items/test/quantities/test",
    httpStatusCode: 200,
    responseHash: "inventory-repair-write",
    auth: {},
    payload: { code: "SUCCESS", message: "OK" },
  };
}

function inventoryResponse(vendorItemId, amountInStock) {
  return {
    mode: "mock",
    source: "inventory-repair-test",
    requestPath: `/vendor-items/${vendorItemId}/inventories`,
    httpStatusCode: 200,
    responseHash: `inventory-${vendorItemId}-${amountInStock}`,
    auth: {},
    payload: {
      vendorItemId,
      amountInStock,
      salePrice: null,
      onSale: true,
      checkedAt: timestampText,
    },
  };
}

async function createMismatchState(suffix, input = {}) {
  const mapping = await prisma.sales_channel_product_mappings.create({
    data: {
      channel: "COUPANG",
      external_product_id: `PRODUCT-${suffix}`,
      external_vendor_item_id: `9000000000${suffix}`,
      external_option_name: `옵션 ${suffix}`,
      mapping_status: "UNMAPPED",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const state =
    await prisma.sales_channel_inventory_verification_states.create({
      data: {
        mapping_id: mapping.mapping_id,
        channel: "COUPANG",
        external_vendor_item_id: mapping.external_vendor_item_id,
        verification_status: "MISMATCH",
        ledger_quantity: input.ledgerQuantity ?? 5,
        pending_order_quantity: input.pendingOrderQuantity ?? 2,
        channel_quantity: input.channelQuantity ?? 4,
        desired_version: input.desiredVersion ?? 2,
        mapping_updated_at_snapshot: mapping.updated_at,
        projection_basis_hash: `basis-${suffix}`,
        mismatch_since: databaseTimestamp(
          `2026-08-02 11:00:${String(suffix).padStart(2, "0")}`
        ),
        last_checked_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });

  return { mapping, state };
}

function repairInput(state, userId) {
  return {
    verificationStateId: state.verification_state_id,
    observedDesiredVersion: state.desired_version,
    observedMismatchSince: state.mismatch_since,
    observedExpectedChannelQuantity: Math.max(
      0,
      state.ledger_quantity - state.pending_order_quantity
    ),
    observedChannelQuantity: state.channel_quantity,
    requestedByUserId: userId,
  };
}

function refreshResult(state, outcome = "MISMATCH") {
  return {
    mappingId: state.mapping_id,
    verificationStateId: state.verification_state_id,
    outcome,
    desiredVersion: state.desired_version,
    apiCallLogId: null,
  };
}

function projected(state) {
  return {
    status: "PROJECTED",
    mappingId: state.mapping_id,
    channel: state.channel,
    externalVendorItemId: state.external_vendor_item_id,
    salesOfferId: state.sales_offer_id,
    salesOfferCode: "",
    warrantyGroup: "",
    eligibleSaleGrades: [],
    ledgerQuantity: state.ledger_quantity,
    pendingOrderQuantity: state.pending_order_quantity,
    expectedChannelQuantity: Math.max(
      0,
      state.ledger_quantity - state.pending_order_quantity
    ),
    mappingUpdatedAt: state.mapping_updated_at_snapshot,
    projectionBasisHash: state.projection_basis_hash,
  };
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { repairCoupangInventoryQuantity } = await import(
    "@/quickhack_server/sales-channel/coupang/inventory-quantity-repair-service"
  );
  const user = await prisma.users.create({
    data: {
      username: "inventory-repair-staff",
      password_hash: "test-only",
      role: "STAFF",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const credentialContext = {
    freshness: "FORCE_FRESH_WRITE",
    context: { mode: "mock" },
  };

  const successFixture = await createMismatchState(1);
  let openCount = 0;
  let preflightReadCount = 0;
  let writeCount = 0;
  let verificationReadCount = 0;
  const success = await repairCoupangInventoryQuantity(
    repairInput(successFixture.state, user.user_id),
    {
      openCredentialContext: async () => {
        openCount += 1;
        return credentialContext;
      },
      refreshVerification: async () => {
        preflightReadCount += 1;
        return refreshResult(successFixture.state);
      },
      prepareProjection: async () => {
        const state =
          await prisma.sales_channel_inventory_verification_states.findUnique({
            where: {
              verification_state_id:
                successFixture.state.verification_state_id,
            },
          });
        return { projection: projected(state), state };
      },
      writeExecutionDependencies: {
        executeWrite: async () => {
          writeCount += 1;
          return writeResponse();
        },
        verifyWrite: async ({ requestId }) => {
          verificationReadCount += 1;
          const target =
            await prisma.sales_channel_write_request_targets.findFirstOrThrow({
              where: { sales_channel_write_request_id: requestId },
            });
          return {
            outcome: "CONFIRMED",
            code: "INVENTORY_QUANTITY_CONFIRMED",
            message: "confirmed",
            endpointPath: "/vendor-items/test/inventories",
            targetCount: 1,
            confirmedCount: 1,
            targetGroups: [
              {
                groupKey: `INVENTORY:${target.inventory_verification_state_id}`,
                targetIds: [target.sales_channel_write_request_target_id],
                outcome: "CONFIRMED",
                code: "INVENTORY_QUANTITY_CONFIRMED",
              },
            ],
            observedStatuses: [],
          };
        },
      },
    }
  );

  assert.equal(success.outcome, "REPAIRED");
  assert.equal(openCount, 1);
  assert.equal(preflightReadCount, 1);
  assert.equal(writeCount, 1);
  assert.equal(verificationReadCount, 0);
  const completedRequest = await prisma.sales_channel_write_requests.findUnique({
    where: { sales_channel_write_request_id: success.writeRequestId },
    include: { targets: true, attempts: true },
  });
  assert.equal(completedRequest.request_status, "COMPLETED");
  assert.equal(completedRequest.targets.length, 1);
  assert.equal(
    completedRequest.targets[0].inventory_expected_channel_quantity_snapshot,
    3
  );
  assert.equal(
    completedRequest.targets[0].inventory_observed_channel_quantity_snapshot,
    4
  );
  assert.equal(completedRequest.attempts.length, 2);
  assert.equal(
    completedRequest.attempts
      .map((attempt) => attempt.attempt_type)
      .sort()
      .join(","),
    "LOCAL_FINALIZE,WRITE"
  );
  const completedState =
    await prisma.sales_channel_inventory_verification_states.findUnique({
      where: {
        verification_state_id: successFixture.state.verification_state_id,
      },
    });
  assert.equal(completedState.verification_status, "MATCHED");
  assert.equal(completedState.channel_quantity, 3);

  const changedDuringWriteFixture = await createMismatchState(7, {
    channelQuantity: 9,
  });
  const changedDuringWriteResult = await repairCoupangInventoryQuantity(
    repairInput(changedDuringWriteFixture.state, user.user_id),
    {
      openCredentialContext: async () => credentialContext,
      refreshVerification: async () =>
        refreshResult(changedDuringWriteFixture.state),
      prepareProjection: async () => {
        const state =
          await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow(
            {
              where: {
                verification_state_id:
                  changedDuringWriteFixture.state.verification_state_id,
              },
            }
          );
        return { projection: projected(state), state };
      },
      writeExecutionDependencies: {
        executeWrite: async () => {
          await prisma.sales_channel_inventory_verification_states.update({
            where: {
              verification_state_id:
                changedDuringWriteFixture.state.verification_state_id,
            },
            data: {
              verification_status: "PENDING",
              pending_order_quantity: 1,
              desired_version: { increment: 1 },
              projection_basis_hash: "basis-changed-during-write",
              state_revision: { increment: 1 },
            },
          });
          return writeResponse();
        },
        verifyWrite: async () =>
          assert.fail("an explicit success must not trigger an inventory GET"),
      },
    }
  );
  assert.equal(changedDuringWriteResult.outcome, "REPAIRED");
  assert.equal(
    changedDuringWriteResult.item.verificationStatus,
    "MISMATCH"
  );
  assert.equal(changedDuringWriteResult.item.channelQuantity, 3);
  assert.equal(changedDuringWriteResult.item.expectedChannelQuantity, 4);
  const changedDuringWriteRequest =
    await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id:
          changedDuringWriteResult.writeRequestId,
      },
    });
  assert.equal(changedDuringWriteRequest.request_status, "COMPLETED");
  assert.equal(changedDuringWriteRequest.failure_stage, null);

  await assert.rejects(
    repairCoupangInventoryQuantity(
      repairInput(successFixture.state, user.user_id),
      {
        openCredentialContext: async () => {
          openCount += 1;
          return credentialContext;
        },
      }
    ),
    (error) => error?.code === "INVENTORY_REPAIR_PRECONDITION_CHANGED"
  );
  assert.equal(writeCount, 1, "A resolved snapshot caused a duplicate PUT.");
  assert.equal(openCount, 1, "A stale UI snapshot opened credentials.");

  const preflightChangedFixture = await createMismatchState(2, {
    channelQuantity: 7,
  });
  let preflightChangedWriteCount = 0;
  await assert.rejects(
    repairCoupangInventoryQuantity(
      repairInput(preflightChangedFixture.state, user.user_id),
      {
        openCredentialContext: async () => credentialContext,
        refreshVerification: async () => {
          await prisma.sales_channel_inventory_verification_states.update({
            where: {
              verification_state_id:
                preflightChangedFixture.state.verification_state_id,
            },
            data: {
              channel_quantity: 8,
              state_revision: { increment: 1 },
            },
          });
          return refreshResult(preflightChangedFixture.state);
        },
        writeExecutionDependencies: {
          executeWrite: async () => {
            preflightChangedWriteCount += 1;
            return writeResponse();
          },
        },
      }
    ),
    (error) => error?.code === "INVENTORY_REPAIR_PRECONDITION_CHANGED"
  );
  assert.equal(preflightChangedWriteCount, 0);
  assert.equal(
    await prisma.sales_channel_write_requests.count({
      where: {
        source_entity_id: String(
          preflightChangedFixture.state.verification_state_id
        ),
      },
    }),
    0
  );

  const dispatchChangedFixture = await createMismatchState(3, {
    channelQuantity: 6,
  });
  let dispatchChangedWriteCount = 0;
  await assert.rejects(
    repairCoupangInventoryQuantity(
      repairInput(dispatchChangedFixture.state, user.user_id),
      {
        openCredentialContext: async () => credentialContext,
        refreshVerification: async () =>
          refreshResult(dispatchChangedFixture.state),
        prepareProjection: async () => ({
          projection: projected(dispatchChangedFixture.state),
          state: {
            ...dispatchChangedFixture.state,
            desired_version: dispatchChangedFixture.state.desired_version + 1,
          },
        }),
        writeExecutionDependencies: {
          executeWrite: async () => {
            dispatchChangedWriteCount += 1;
            return writeResponse();
          },
        },
      }
    ),
    (error) => error?.code === "INVENTORY_REPAIR_PRECONDITION_CHANGED"
  );
  assert.equal(dispatchChangedWriteCount, 0);
  const rejectedRequest = await prisma.sales_channel_write_requests.findFirst({
    where: {
      source_entity_id: String(
        dispatchChangedFixture.state.verification_state_id
      ),
    },
    include: { attempts: true },
  });
  assert.equal(rejectedRequest.request_status, "REJECTED");
  assert.equal(rejectedRequest.attempts.length, 1);
  assert.equal(rejectedRequest.attempts[0].attempt_type, "WRITE");
  assert.equal(rejectedRequest.attempts[0].attempt_status, "FAILED");
  assert.equal(rejectedRequest.attempts[0].request_dispatched, 0);

  const ambiguousFixture = await createMismatchState(4, {
    channelQuantity: 9,
  });
  let ambiguousWriteCount = 0;
  let ambiguousReadCount = 0;
  await assert.rejects(
    repairCoupangInventoryQuantity(
      repairInput(ambiguousFixture.state, user.user_id),
      {
        openCredentialContext: async () => credentialContext,
        refreshVerification: async () => refreshResult(ambiguousFixture.state),
        prepareProjection: async () => ({
          projection: projected(ambiguousFixture.state),
          state: await prisma.sales_channel_inventory_verification_states.findUnique({
            where: {
              verification_state_id:
                ambiguousFixture.state.verification_state_id,
            },
          }),
        }),
        writeExecutionDependencies: {
          executeWrite: async () => {
            ambiguousWriteCount += 1;
            throw new Error("network timeout after dispatch");
          },
          verifyWrite: async ({ requestId }) => {
            ambiguousReadCount += 1;
            const target =
              await prisma.sales_channel_write_request_targets.findFirstOrThrow({
                where: { sales_channel_write_request_id: requestId },
              });
            return {
              outcome: "UNKNOWN",
              code: "INVENTORY_QUANTITY_NOT_CONFIRMED",
              message: "not confirmed",
              endpointPath: "/vendor-items/test/inventories",
              targetCount: 1,
              confirmedCount: 0,
              targetGroups: [
                {
                  groupKey: `INVENTORY:${target.inventory_verification_state_id}`,
                  targetIds: [target.sales_channel_write_request_target_id],
                  outcome: "UNKNOWN",
                  code: "INVENTORY_QUANTITY_NOT_CONFIRMED",
                },
              ],
              observedStatuses: [],
            };
          },
        },
      }
    ),
    (error) =>
      error?.code === "INVENTORY_REPAIR_REVIEW_REQUIRED" &&
      Number.isSafeInteger(error?.details?.writeRequestId)
  );
  assert.equal(ambiguousWriteCount, 1);
  assert.equal(ambiguousReadCount, 1);
  const reviewRequest = await prisma.sales_channel_write_requests.findFirst({
    where: {
      source_entity_id: String(ambiguousFixture.state.verification_state_id),
    },
  });
  assert.equal(reviewRequest.request_status, "REVIEW_REQUIRED");

  const targetedFixture = await createMismatchState(5, {
    channelQuantity: 8,
  });
  const targetedExpected = 3;
  const targetedRequest = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "COUPANG_INVENTORY_QUANTITY_UPDATE",
      request_status: "VERIFYING",
      target_type: "INVENTORY_VERIFICATION",
      target_external_id: targetedFixture.state.external_vendor_item_id,
      idempotency_key: "TEST:INVENTORY:TARGETED:VERIFY",
      request_digest: "test-fixture",
      method: "PUT",
      endpoint_path: "/vendor-items/{vendorItemId}/quantities/{quantity}",
      source_menu_key: "admin-sales-channel-sync-check",
      source_entity_type: "INVENTORY_VERIFICATION",
      source_entity_id: String(targetedFixture.state.verification_state_id),
      requested_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      targets: {
        create: {
          target_type: "INVENTORY_VERIFICATION",
          target_external_id: targetedFixture.state.external_vendor_item_id,
          external_vendor_item_id:
            targetedFixture.state.external_vendor_item_id,
          inventory_verification_state_id:
            targetedFixture.state.verification_state_id,
          inventory_desired_version_snapshot:
            targetedFixture.state.desired_version,
          inventory_mismatch_since_snapshot:
            targetedFixture.state.mismatch_since,
          inventory_projection_basis_hash_snapshot:
            targetedFixture.state.projection_basis_hash,
          inventory_ledger_quantity_snapshot:
            targetedFixture.state.ledger_quantity,
          inventory_pending_order_quantity_snapshot:
            targetedFixture.state.pending_order_quantity,
          inventory_expected_channel_quantity_snapshot: targetedExpected,
          inventory_observed_channel_quantity_snapshot:
            targetedFixture.state.channel_quantity,
          created_at: timestamp,
        },
      },
    },
  });
  const { verifyAndRefreshCoupangWriteRequest } = await import(
    "@/quickhack_server/sales-channel/coupang/write-verification-service"
  );
  const { finalizePersistedCoupangInventoryQuantityRepair } = await import(
    "@/quickhack_server/sales-channel/coupang/inventory-quantity-repair-finalizer"
  );
  let targetedReadCount = 0;
  let observedQuantity = null;
  const targetedDependencies = {
    getInventory: async (vendorItemId) => {
      targetedReadCount += 1;
      return inventoryResponse(String(vendorItemId), targetedExpected);
    },
    recordInventoryObservation: async (input) => {
      observedQuantity = input.observedChannelQuantity;
      return { state: targetedFixture.state, snapshotCurrent: true };
    },
  };
  const targetedConfirmed = await verifyAndRefreshCoupangWriteRequest(
    {
      requestId: targetedRequest.sales_channel_write_request_id,
      triggerType: "IMMEDIATE_VERIFY",
    },
    targetedDependencies
  );
  assert.equal(targetedConfirmed.outcome, "CONFIRMED");
  assert.equal(targetedConfirmed.expectedInventoryQuantity, targetedExpected);
  assert.equal(targetedConfirmed.observedInventoryQuantity, targetedExpected);
  assert.equal(targetedReadCount, 1);
  assert.equal(observedQuantity, targetedExpected);

  targetedDependencies.getInventory = async (vendorItemId) => {
    targetedReadCount += 1;
    return inventoryResponse(String(vendorItemId), targetedExpected + 1);
  };
  const targetedUnknown = await verifyAndRefreshCoupangWriteRequest(
    {
      requestId: targetedRequest.sales_channel_write_request_id,
      triggerType: "MANUAL_RECHECK",
    },
    targetedDependencies
  );
  assert.equal(targetedUnknown.outcome, "UNKNOWN");
  assert.equal(targetedUnknown.observedInventoryQuantity, targetedExpected + 1);
  assert.equal(targetedReadCount, 2);

  await prisma.sales_channel_inventory_verification_states.update({
    where: {
      verification_state_id: targetedFixture.state.verification_state_id,
    },
    data: {
      verification_status: "PENDING",
      pending_order_quantity: 1,
      desired_version: { increment: 1 },
      projection_basis_hash: "basis-after-repair-write",
      state_revision: { increment: 1 },
    },
  });
  await prisma.$transaction((tx) =>
    finalizePersistedCoupangInventoryQuantityRepair({
      tx,
      requestId: targetedRequest.sales_channel_write_request_id,
      finalizedAt: databaseTimestamp("2026-08-02 12:10:00"),
    })
  );
  const staleFinalizationState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: {
        verification_state_id: targetedFixture.state.verification_state_id,
      },
    });
  assert.equal(staleFinalizationState.verification_status, "MISMATCH");
  assert.equal(staleFinalizationState.channel_quantity, targetedExpected);
  assert.equal(staleFinalizationState.pending_order_quantity, 1);
  assert.equal(staleFinalizationState.retry_count, 0);
  assert.equal(staleFinalizationState.last_error_code, null);
  assert.equal(staleFinalizationState.last_error_message, null);

  await prisma.sales_channel_inventory_verification_states.update({
    where: {
      verification_state_id: targetedFixture.state.verification_state_id,
    },
    data: {
      verification_status: "MISMATCH",
      channel_quantity: targetedExpected + 5,
      last_checked_at: databaseTimestamp("2026-08-02 12:11:00"),
      state_revision: { increment: 1 },
    },
  });
  await prisma.$transaction((tx) =>
    finalizePersistedCoupangInventoryQuantityRepair({
      tx,
      requestId: targetedRequest.sales_channel_write_request_id,
      finalizedAt: databaseTimestamp("2026-08-02 12:12:00"),
    })
  );
  const preservedNewerMismatch =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: {
        verification_state_id: targetedFixture.state.verification_state_id,
      },
    });
  assert.equal(preservedNewerMismatch.verification_status, "MISMATCH");
  assert.equal(preservedNewerMismatch.channel_quantity, targetedExpected + 5);
  assert.equal(
    preservedNewerMismatch.last_checked_at?.getTime(),
    databaseTimestamp("2026-08-02 12:11:00").getTime()
  );

  const checkingConflictFixture = await createMismatchState(6, {
    channelQuantity: 8,
  });
  let checkingConflictRequestId = null;
  await assert.rejects(
    repairCoupangInventoryQuantity(
      repairInput(checkingConflictFixture.state, user.user_id),
      {
        openCredentialContext: async () => credentialContext,
        refreshVerification: async () =>
          refreshResult(checkingConflictFixture.state),
        prepareProjection: async () => {
          const state =
            await prisma.sales_channel_inventory_verification_states.findUnique({
              where: {
                verification_state_id:
                  checkingConflictFixture.state.verification_state_id,
              },
            });
          return { projection: projected(state), state };
        },
        writeExecutionDependencies: {
          executeWrite: async () => {
            await prisma.sales_channel_inventory_verification_states.update({
              where: {
                verification_state_id:
                  checkingConflictFixture.state.verification_state_id,
              },
              data: {
                verification_status: "PENDING",
                processing_version: null,
                execution_token: "queued-verification-owner",
                state_revision: { increment: 1 },
              },
            });
            return writeResponse();
          },
        },
      }
    ),
    (error) => {
      checkingConflictRequestId = error?.details?.writeRequestId ?? null;
      return (
        error?.code === "INVENTORY_REPAIR_REVIEW_REQUIRED" &&
        Number.isSafeInteger(checkingConflictRequestId)
      );
    }
  );
  const checkingConflictRequest =
    await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id: checkingConflictRequestId,
      },
      include: { attempts: true },
    });
  assert.equal(checkingConflictRequest.request_status, "LOCAL_PENDING");
  assert.equal(checkingConflictRequest.failure_stage, "LOCAL_FINALIZATION");
  assert.equal(
    checkingConflictRequest.error_code,
    "InventoryQuantityRepairFinalizationConflictError"
  );
  assert.equal(checkingConflictRequest.completed_at, null);
  assert.equal(checkingConflictRequest.local_finalized_at, null);
  const checkingConflictFinalizeAttempt = checkingConflictRequest.attempts.find(
    (attempt) => attempt.attempt_type === "LOCAL_FINALIZE"
  );
  assert.equal(checkingConflictFinalizeAttempt?.attempt_status, "FAILED");
  assert.equal(
    checkingConflictFinalizeAttempt?.error_code,
    "InventoryQuantityRepairFinalizationConflictError"
  );
  const checkingConflictState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: {
        verification_state_id:
          checkingConflictFixture.state.verification_state_id,
      },
    });
  assert.equal(checkingConflictState.verification_status, "PENDING");
  assert.equal(checkingConflictState.processing_version, null);
  assert.equal(
    checkingConflictState.execution_token,
    "queued-verification-owner"
  );
  await prisma.sales_channel_inventory_verification_states.update({
    where: {
      verification_state_id:
        checkingConflictFixture.state.verification_state_id,
    },
    data: {
      verification_status: "MATCHED",
      processing_version: null,
      execution_token: null,
      channel_quantity: 3,
      mismatch_since: null,
      state_revision: { increment: 1 },
    },
  });
  await prisma.$transaction((tx) =>
    finalizePersistedCoupangInventoryQuantityRepair({
      tx,
      requestId: checkingConflictRequestId,
      finalizedAt: databaseTimestamp("2026-08-02 12:20:00"),
    })
  );
  const resolvedCheckingConflictState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: {
        verification_state_id:
          checkingConflictFixture.state.verification_state_id,
      },
    });
  assert.equal(
    resolvedCheckingConflictState.verification_status,
    "MATCHED",
    "a later successful check must not be downgraded during local finalization"
  );
  const unaffectedCompletedState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: {
        verification_state_id: successFixture.state.verification_state_id,
      },
    });
  assert.equal(
    unaffectedCompletedState.verification_status,
    "MATCHED",
    "a finalization conflict must not affect another option mapping"
  );

  console.log("Coupang inventory quantity repair workflow passed.");
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
