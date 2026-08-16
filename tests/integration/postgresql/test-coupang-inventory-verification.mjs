import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-coupang-inventory-verification-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function databaseTimestamp(value) {
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

function successfulInventoryResponse(vendorItemId, quantity) {
  return {
    mode: "mock",
    source: "mock:inventory-test",
    requestPath: `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/inventories`,
    httpStatusCode: 200,
    responseHash: `hash-${vendorItemId}-${quantity}`,
    auth: {
      providerType: "USB_QHKEY",
      keyAlias: "test",
      keyFingerprint: "test-fingerprint",
      authStatus: "SUCCEEDED",
      warningMessage: null,
    },
    payload: {
      vendorItemId,
      amountInStock: quantity,
      salePrice: null,
      onSale: true,
      checkedAt: "2026-08-02 10:00:00",
    },
  };
}

function inventoryDependency(quantity, onCall) {
  return async (vendorItemId) => {
    await onCall?.(vendorItemId);
    return successfulInventoryResponse(String(vendorItemId), quantity);
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    CoupangApiResponseError,
    CoupangInventoryPayloadError,
  } = await import("@/quickhack_server/sales-channel/coupang/api-client");
  const {
    failQueuedCoupangInventoryVerificationBatch,
    processCoupangInventoryVerificationBatch,
    queueCoupangInventoryVerificationBatch,
    recordCoupangInventoryRepairVerificationObservation,
    recoverStaleInventoryVerificationClaims,
    refreshCoupangInventoryVerification,
  } = await import(
    "@/quickhack_server/sales-channel/coupang/inventory-verification-service"
  );
  const { WorkerShutdownRequestedError } = await import(
    "@/quickhack_server/workers/shutdown-runtime"
  );
  const { calculateMappedOfferSellableQuantity } = await import(
    "@/quickhack_server/sales-channel/inventory-quantity-projection-service"
  );

  async function createOption(category, optionKey) {
    const existing = await prisma.product_criteria_options.findFirst({
      where: { category, option_key: optionKey, parent_key: "" },
    });

    if (existing) return existing;
    return prisma.product_criteria_options.create({
      data: { category, option_key: optionKey, label: optionKey },
    });
  }

  const [model, storage, color, gradeA, , , warranty] =
    await Promise.all([
      createOption("PRODUCT_MODEL", "VERIFY-MODEL"),
      createOption("STORAGE", "128GB"),
      createOption("DEVICE_COLOR", "BLACK"),
      createOption("SALE_GRADE", "A"),
      createOption("SALE_GRADE", "A-"),
      createOption("SALE_GRADE", "B+"),
      createOption("WARRANTY_GROUP", "2Y"),
    ]);
  const offer = await prisma.sales_offers.create({
    data: {
      offer_code: "VERIFY-OFFER",
      model_option_id: model.option_id,
      storage_match_mode: "EXACT",
      storage_option_id: storage.option_id,
      color_match_mode: "EXACT",
      color_option_id: color.option_id,
      warranty_group_option_id: warranty.option_id,
    },
  });
  const mapping = await prisma.sales_channel_product_mappings.create({
    data: {
      channel: "COUPANG",
      external_vendor_item_id: "VENDOR-VERIFY",
      external_option_name: "Verification fixture",
      sales_offer_id: offer.sales_offer_id,
      mapping_status: "MAPPED",
    },
  });
  const sku = await prisma.inventory_skus.create({
    data: {
      sku_code: "VERIFY-SKU",
      model_option_id: model.option_id,
      storage_option_id: storage.option_id,
      color_option_id: color.option_id,
      sale_grade_option_id: gradeA.option_id,
    },
  });
  const balance = await prisma.inventory_quantity_balances.create({
    data: {
      inventory_sku_id: sku.inventory_sku_id,
      inventory_status: "SELLABLE",
      quantity: 5,
    },
  });

  const projectionFailureMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-PROJECTION-FAILURE",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  const initialProjectionFailure = await refreshCoupangInventoryVerification({
    mappingId: projectionFailureMapping.mapping_id,
    now: new Date("2026-08-02T00:59:00.000Z"),
    dependencies: {
      calculateProjection: async () => {
        throw new Error("projection unavailable");
      },
    },
  });
  assert.equal(initialProjectionFailure.outcome, "CHECK_FAILED");
  const initialProjectionFailureState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: projectionFailureMapping.mapping_id },
    });
  assert.equal(initialProjectionFailureState.verification_status, "CHECK_FAILED");
  assert.equal(initialProjectionFailureState.state_revision, 1);
  assert.equal(
    initialProjectionFailureState.last_error_code,
    "INVENTORY_LEDGER_PROJECTION_FAILED"
  );

  const projectionRaceMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-PROJECTION-RACE",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  await refreshCoupangInventoryVerification({
    mappingId: projectionRaceMapping.mapping_id,
    now: new Date("2026-08-02T00:59:10.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  const projectionRaceBaseline =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: projectionRaceMapping.mapping_id },
    });
  assert.equal(
    projectionRaceBaseline.state_revision,
    3,
    "create, claim, and finalization must each own one state revision"
  );

  const staleProjectionStarted = deferred();
  const releaseStaleProjection = deferred();
  const staleProjectionWhileChecking = refreshCoupangInventoryVerification({
    mappingId: projectionRaceMapping.mapping_id,
    now: new Date("2026-08-02T00:59:11.000Z"),
    dependencies: {
      calculateProjection: async () => {
        staleProjectionStarted.resolve();
        await releaseStaleProjection.promise;
        throw new Error("stale projection failed while a newer check owns state");
      },
    },
  });
  await staleProjectionStarted.promise;

  const newerCheckStarted = deferred();
  const releaseNewerCheck = deferred();
  const newerCheck = refreshCoupangInventoryVerification({
    mappingId: projectionRaceMapping.mapping_id,
    now: new Date("2026-08-02T00:59:12.000Z"),
    dependencies: {
      getInventory: inventoryDependency(5, async () => {
        newerCheckStarted.resolve();
        await releaseNewerCheck.promise;
      }),
    },
  });
  await newerCheckStarted.promise;
  releaseStaleProjection.resolve();
  assert.equal((await staleProjectionWhileChecking).outcome, "ALREADY_CLAIMED");
  const activelyCheckedState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: projectionRaceMapping.mapping_id },
    });
  assert.equal(activelyCheckedState.verification_status, "CHECKING");
  assert.equal(
    activelyCheckedState.state_revision,
    projectionRaceBaseline.state_revision + 2,
    "a stale projection failure must not consume a state revision"
  );
  releaseNewerCheck.resolve();
  assert.equal((await newerCheck).outcome, "MATCHED");

  const completedRaceBaseline =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: projectionRaceMapping.mapping_id },
    });
  const completedRaceStarted = deferred();
  const releaseCompletedRace = deferred();
  const staleProjectionAfterCompletion = refreshCoupangInventoryVerification({
    mappingId: projectionRaceMapping.mapping_id,
    now: new Date("2026-08-02T00:59:13.000Z"),
    dependencies: {
      calculateProjection: async () => {
        completedRaceStarted.resolve();
        await releaseCompletedRace.promise;
        throw new Error("stale projection failed after a newer check completed");
      },
    },
  });
  await completedRaceStarted.promise;
  const completedNewerCheck = await refreshCoupangInventoryVerification({
    mappingId: projectionRaceMapping.mapping_id,
    now: new Date("2026-08-02T00:59:14.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(completedNewerCheck.outcome, "MATCHED");
  const completedNewerState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: projectionRaceMapping.mapping_id },
    });
  assert.equal(
    completedNewerState.state_revision,
    completedRaceBaseline.state_revision + 3
  );
  releaseCompletedRace.resolve();
  assert.equal((await staleProjectionAfterCompletion).outcome, "CLAIM_LOST");
  const preservedCompletedState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: projectionRaceMapping.mapping_id },
    });
  assert.equal(preservedCompletedState.verification_status, "MATCHED");
  assert.equal(
    preservedCompletedState.state_revision,
    completedNewerState.state_revision
  );

  const absentStateRaceMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-ABSENT-STATE-RACE",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  const absentStateRaceStarted = deferred();
  const releaseAbsentStateRace = deferred();
  const staleAbsentStateProjection = refreshCoupangInventoryVerification({
    mappingId: absentStateRaceMapping.mapping_id,
    now: new Date("2026-08-02T00:59:15.000Z"),
    dependencies: {
      calculateProjection: async () => {
        absentStateRaceStarted.resolve();
        await releaseAbsentStateRace.promise;
        throw new Error("stale projection failed after state creation");
      },
    },
  });
  await absentStateRaceStarted.promise;
  const createdByNewerCheck = await refreshCoupangInventoryVerification({
    mappingId: absentStateRaceMapping.mapping_id,
    now: new Date("2026-08-02T00:59:16.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(createdByNewerCheck.outcome, "MATCHED");
  releaseAbsentStateRace.resolve();
  assert.equal((await staleAbsentStateProjection).outcome, "CLAIM_LOST");
  const absentStateRaceResult =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: absentStateRaceMapping.mapping_id },
    });
  assert.equal(absentStateRaceResult.verification_status, "MATCHED");

  const changedMappingRace =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-CHANGED-MAPPING-RACE",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
        updated_at: databaseTimestamp("2026-08-02 09:59:16"),
      },
    });
  const changedMappingRaceStarted = deferred();
  const releaseChangedMappingRace = deferred();
  const staleChangedMappingProjection = refreshCoupangInventoryVerification({
    mappingId: changedMappingRace.mapping_id,
    now: new Date("2026-08-02T00:59:16.000Z"),
    dependencies: {
      calculateProjection: async () => {
        changedMappingRaceStarted.resolve();
        await releaseChangedMappingRace.promise;
        throw new Error("projection failed after its mapping changed");
      },
    },
  });
  await changedMappingRaceStarted.promise;
  await prisma.sales_channel_product_mappings.update({
    where: { mapping_id: changedMappingRace.mapping_id },
    data: { updated_at: databaseTimestamp("2026-08-02 09:59:17") },
  });
  releaseChangedMappingRace.resolve();
  assert.equal((await staleChangedMappingProjection).outcome, "CLAIM_LOST");
  assert.equal(
    await prisma.sales_channel_inventory_verification_states.count({
      where: { mapping_id: changedMappingRace.mapping_id },
    }),
    0,
    "a projection failure must not create state for a newer mapping snapshot"
  );

  const batchProjectionStarted = deferred();
  const releaseBatchProjection = deferred();
  const staleProjectionBatch = queueCoupangInventoryVerificationBatch({
    mappingIds: [projectionRaceMapping.mapping_id],
    executionToken: "stale-projection-batch-owner",
    now: new Date("2026-08-02T00:59:17.000Z"),
    dependencies: {
      calculateProjection: async () => {
        batchProjectionStarted.resolve();
        await releaseBatchProjection.promise;
        throw new Error("stale batch projection failure");
      },
    },
  });
  await batchProjectionStarted.promise;
  const batchRaceNewerCheck = await refreshCoupangInventoryVerification({
    mappingId: projectionRaceMapping.mapping_id,
    now: new Date("2026-08-02T00:59:18.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(batchRaceNewerCheck.outcome, "MATCHED");
  releaseBatchProjection.resolve();
  const staleBatchResult = await staleProjectionBatch;
  assert.equal(staleBatchResult.failedCount, 0);
  assert.equal(staleBatchResult.alreadyClaimedCount, 1);
  assert.deepEqual(staleBatchResult.failedMappingIds, []);

  const firstBasis = await calculateMappedOfferSellableQuantity(
    mapping.mapping_id
  );
  assert.equal(firstBasis.status, "PROJECTED");
  assert.equal(firstBasis.projectionBasisHash.length, 64);
  await prisma.sales_offers.update({
    where: { sales_offer_id: offer.sales_offer_id },
    data: { updated_at: databaseTimestamp("2026-08-02 09:00:01") },
  });
  const changedBasis = await calculateMappedOfferSellableQuantity(
    mapping.mapping_id
  );
  assert.equal(changedBasis.status, "PROJECTED");
  assert.notEqual(
    changedBasis.projectionBasisHash,
    firstBasis.projectionBasisHash,
    "offer-only changes must alter the projection basis"
  );

  const matched = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:00:00.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(matched.outcome, "MATCHED");
  const stateId = matched.verificationStateId;
  let state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.verification_status, "MATCHED");
  assert.equal(state.ledger_quantity, 5);
  assert.equal(state.pending_order_quantity, 0);
  assert.equal(state.channel_quantity, 5);
  assert.equal(state.projection_basis_hash, changedBasis.projectionBasisHash);

  const firstMismatch = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:01:00.000Z"),
    dependencies: { getInventory: inventoryDependency(3) },
  });
  assert.equal(firstMismatch.outcome, "MISMATCH");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  const mismatchSince = state.mismatch_since;
  assert(mismatchSince);

  const repeatedMismatch = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:02:00.000Z"),
    dependencies: { getInventory: inventoryDependency(3) },
  });
  assert.equal(repeatedMismatch.outcome, "MISMATCH");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.mismatch_since?.getTime(), mismatchSince?.getTime());

  const resolved = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:03:00.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(resolved.outcome, "MATCHED");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.mismatch_since, null);
  assert.equal(
    state.resolved_at?.getTime(),
    databaseTimestamp("2026-08-02 10:03:00").getTime()
  );

  const rateLimitError = new CoupangApiResponseError({
    httpStatusCode: 429,
    externalResponseCode: "RATE_LIMITED",
    transient: true,
    retryAfterSeconds: 300,
  });
  const failed = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:04:00.000Z"),
    dependencies: {
      getInventory: async () => {
        throw rateLimitError;
      },
    },
  });
  assert.equal(failed.outcome, "CHECK_FAILED");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.verification_status, "CHECK_FAILED");
  assert.equal(state.channel_quantity, 5, "last valid channel quantity is retained");
  assert.equal(state.next_retry_at, null, "failed checks are not auto-retried");
  const failedLog = await prisma.coupang_api_call_log.findUniqueOrThrow({
    where: { coupang_api_call_log_id: failed.apiCallLogId },
  });
  assert.equal(failedLog.processed_status, "FAILED");
  assert.equal(failedLog.http_status_code, 429);
  assert.equal(failedLog.external_response_code, "RATE_LIMITED");
  assert.equal(failedLog.external_response_message, null);
  assert.equal(failedLog.error_message, "Coupang API response error (429).");

  const payloadError = new CoupangInventoryPayloadError(
    "COUPANG_INVENTORY_AMOUNT_INVALID",
    "amountInStock is missing"
  );
  payloadError.responseMetadata = {
    requestPath: `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${mapping.external_vendor_item_id}/inventories`,
    httpStatusCode: 200,
    responseHash: "invalid-payload-hash",
    externalResponseCode: "SUCCESS",
  };
  const invalidPayload = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:05:00.000Z"),
    dependencies: {
      getInventory: async () => {
        throw payloadError;
      },
    },
  });
  assert.equal(invalidPayload.outcome, "CHECK_FAILED");
  const invalidPayloadLog = await prisma.coupang_api_call_log.findUniqueOrThrow({
    where: { coupang_api_call_log_id: invalidPayload.apiCallLogId },
  });
  assert.equal(invalidPayloadLog.http_status_code, 200);
  assert.equal(invalidPayloadLog.processed_status, "FAILED");
  assert.equal(invalidPayloadLog.error_code, "COUPANG_INVENTORY_AMOUNT_INVALID");

  const invalidOptionError = new CoupangApiResponseError({
    httpStatusCode: 400,
    externalResponseCode: "INVALID_VENDOR_ITEM_ID",
    transient: false,
  });
  const invalidOption = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:05:30.000Z"),
    dependencies: {
      getInventory: async () => {
        throw invalidOptionError;
      },
    },
  });
  assert.equal(invalidOption.outcome, "CHECK_FAILED");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.next_retry_at, null, "invalid options are not auto-retried");

  const shutdownFailure = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:05:40.000Z"),
    dependencies: {
      getInventory: async () => {
        throw new WorkerShutdownRequestedError("inventory-test");
      },
    },
  });
  assert.equal(shutdownFailure.outcome, "CHECK_FAILED");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.verification_status, "CHECK_FAILED");
  assert.equal(state.last_error_code, "WORKER_SHUTDOWN_REQUESTED");

  await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:06:00.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });

  let releaseConcurrent;
  let concurrentStarted;
  const concurrentStartedPromise = new Promise((resolve) => {
    concurrentStarted = resolve;
  });
  const concurrentReleasePromise = new Promise((resolve) => {
    releaseConcurrent = resolve;
  });
  const concurrentFirst = refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:07:00.000Z"),
    dependencies: {
      getInventory: inventoryDependency(5, async () => {
        concurrentStarted();
        await concurrentReleasePromise;
      }),
    },
  });
  await concurrentStartedPromise;
  const concurrentSecond = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:07:01.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(concurrentSecond.outcome, "ALREADY_CLAIMED");
  releaseConcurrent();
  const concurrentFirstResult = await concurrentFirst;
  const concurrentFirstState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: mapping.mapping_id },
    });
  assert.equal(
    concurrentFirstResult.outcome,
    "MATCHED",
    concurrentFirstState.last_error_message ?? "concurrent verification failed"
  );

  const staleFailureMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-STALE-FAILURE",
        external_option_name: "Stale failure fixture",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
        created_at: databaseTimestamp("2026-08-02 10:07:20"),
        updated_at: databaseTimestamp("2026-08-02 10:07:20"),
      },
    });
  let releaseStaleFailure;
  let staleFailureStarted;
  const staleFailureStartedPromise = new Promise((resolve) => {
    staleFailureStarted = resolve;
  });
  const staleFailureReleasePromise = new Promise((resolve) => {
    releaseStaleFailure = resolve;
  });
  const staleApiFailure = new CoupangApiResponseError({
    httpStatusCode: 503,
    externalResponseCode: "TEMPORARILY_UNAVAILABLE",
    transient: true,
  });
  const staleFailureFirst = refreshCoupangInventoryVerification({
    mappingId: staleFailureMapping.mapping_id,
    now: new Date("2026-08-02T01:07:20.000Z"),
    dependencies: {
      getInventory: async () => {
        staleFailureStarted();
        await staleFailureReleasePromise;
        throw staleApiFailure;
      },
    },
  });
  await staleFailureStartedPromise;
  await prisma.sales_channel_product_mappings.update({
    where: { mapping_id: staleFailureMapping.mapping_id },
    data: { updated_at: databaseTimestamp("2026-08-02 10:07:21") },
  });
  const staleFailureObserver = await refreshCoupangInventoryVerification({
    mappingId: staleFailureMapping.mapping_id,
    now: new Date("2026-08-02T01:07:21.000Z"),
    dependencies: {
      getInventory: async () => {
        assert.fail("a second GET must not run after the mapping changes");
      },
    },
  });
  assert.equal(staleFailureObserver.outcome, "ALREADY_CLAIMED");
  releaseStaleFailure();
  assert.equal((await staleFailureFirst).outcome, "CHECK_FAILED");
  const staleFailureState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: staleFailureMapping.mapping_id },
    });
  assert.equal(staleFailureState.verification_status, "CHECK_FAILED");
  assert.equal(staleFailureState.processing_version, null);
  assert.equal(staleFailureState.desired_version, 2);
  assert.equal(
    staleFailureState.last_error_code,
    "INVENTORY_PROJECTION_CHANGED_DURING_CHECK"
  );
  const unaffectedState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(
    unaffectedState.verification_status,
    "MATCHED",
    "a stale failure must not affect another option mapping"
  );

  let releaseStale;
  let staleStarted;
  const staleStartedPromise = new Promise((resolve) => {
    staleStarted = resolve;
  });
  const staleReleasePromise = new Promise((resolve) => {
    releaseStale = resolve;
  });
  const staleFirst = refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:08:00.000Z"),
    dependencies: {
      getInventory: inventoryDependency(5, async () => {
        staleStarted();
        await staleReleasePromise;
      }),
    },
  });
  await staleStartedPromise;
  await prisma.inventory_quantity_balances.update({
    where: {
      inventory_sku_id_inventory_status: {
        inventory_sku_id: balance.inventory_sku_id,
        inventory_status: "SELLABLE",
      },
    },
    data: { quantity: 6, version: { increment: 1 } },
  });
  const staleObserver = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:08:01.000Z"),
    dependencies: {
      getInventory: async () => {
        assert.fail("a second GET must not run while the old version is claimed");
      },
    },
  });
  assert.equal(staleObserver.outcome, "ALREADY_CLAIMED");
  releaseStale();
  assert.equal((await staleFirst).outcome, "CHECK_FAILED");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.verification_status, "CHECK_FAILED");
  assert.equal(
    state.last_error_code,
    "INVENTORY_PROJECTION_CHANGED_DURING_CHECK"
  );
  assert.equal(state.ledger_quantity, 6);
  assert.equal(state.channel_quantity, 5);

  const latestMatch = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:09:00.000Z"),
    dependencies: { getInventory: inventoryDependency(6) },
  });
  assert.equal(latestMatch.outcome, "MATCHED");

  let releasePendingStale;
  let pendingStaleStarted;
  const pendingStaleStartedPromise = new Promise((resolve) => {
    pendingStaleStarted = resolve;
  });
  const pendingStaleReleasePromise = new Promise((resolve) => {
    releasePendingStale = resolve;
  });
  const pendingStaleFirst = refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:09:10.000Z"),
    dependencies: {
      getInventory: inventoryDependency(6, async () => {
        pendingStaleStarted();
        await pendingStaleReleasePromise;
      }),
    },
  });
  await pendingStaleStartedPromise;
  const pendingWorkItem = await prisma.order_matching_work_queue.create({
    data: {
      channel: "COUPANG",
      external_order_id: "ORDER-PENDING-STALE-1",
      external_shipment_id: "SHIP-PENDING-STALE-1",
      external_vendor_item_id: mapping.external_vendor_item_id,
      ordered_quantity: 1,
      matchable_quantity: 1,
      mapping_status: "MAPPED",
      sales_offer_id: offer.sales_offer_id,
      work_status: "UNMATCHED",
    },
  });
  const pendingStaleObserver = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:09:11.000Z"),
    dependencies: {
      getInventory: async () => {
        assert.fail("a second GET must not run after pending quantity changes");
      },
    },
  });
  assert.equal(pendingStaleObserver.outcome, "ALREADY_CLAIMED");
  releasePendingStale();
  assert.equal((await pendingStaleFirst).outcome, "CHECK_FAILED");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.verification_status, "CHECK_FAILED");
  assert.equal(
    state.last_error_code,
    "INVENTORY_PROJECTION_CHANGED_DURING_CHECK"
  );
  assert.equal(state.ledger_quantity, 6);
  assert.equal(state.pending_order_quantity, 1);

  const latestPendingMatch = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:09:20.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(latestPendingMatch.outcome, "MATCHED");
  const pendingMismatch = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:09:21.000Z"),
    dependencies: { getInventory: inventoryDependency(6) },
  });
  assert.equal(
    pendingMismatch.outcome,
    "MISMATCH",
    "the channel quantity must be compared with raw minus pending"
  );
  const pendingResolved = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:09:22.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(pendingResolved.outcome, "MATCHED");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  const pendingVersion = state.desired_version;

  await prisma.order_matching_work_queue.delete({
    where: { work_item_id: pendingWorkItem.work_item_id },
  });
  const replacementPendingWorkItem =
    await prisma.order_matching_work_queue.create({
      data: {
        channel: "COUPANG",
        external_order_id: "ORDER-PENDING-STALE-2",
        external_shipment_id: "SHIP-PENDING-STALE-2",
        external_vendor_item_id: mapping.external_vendor_item_id,
        ordered_quantity: 1,
        matchable_quantity: 1,
        mapping_status: "MAPPED",
        sales_offer_id: offer.sales_offer_id,
        work_status: "FAILED",
      },
    });
  const samePendingTotal = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:09:30.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(samePendingTotal.outcome, "MATCHED");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(
    state.desired_version,
    pendingVersion,
    "work-item identity changes must not increment the version when the pending total is unchanged"
  );

  await prisma.inventory_quantity_balances.update({
    where: {
      inventory_sku_id_inventory_status: {
        inventory_sku_id: balance.inventory_sku_id,
        inventory_status: "SELLABLE",
      },
    },
    data: { quantity: 5, version: { increment: 1 } },
  });
  await prisma.order_matching_work_queue.delete({
    where: { work_item_id: replacementPendingWorkItem.work_item_id },
  });
  const sameExpectedDifferentBasis = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:09:40.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(sameExpectedDifferentBasis.outcome, "MATCHED");
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.ledger_quantity, 5);
  assert.equal(state.pending_order_quantity, 0);
  assert.equal(state.desired_version, pendingVersion + 1);

  const batch = await processCoupangInventoryVerificationBatch({
    mappingIds: [mapping.mapping_id, mapping.mapping_id, -1],
    credentialContext: { test: true },
    dependencies: { getInventory: inventoryDependency(5) },
  });
  assert.equal(batch.requestedCount, 1);
  assert.equal(batch.results[0].outcome, "MATCHED");

  const abaSuccessMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-ABA-SUCCESS",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  const abaSuccessStarted = deferred();
  const releaseAbaSuccess = deferred();
  const staleSuccessExecution = refreshCoupangInventoryVerification({
    mappingId: abaSuccessMapping.mapping_id,
    now: new Date("2026-08-02T01:09:45.000Z"),
    dependencies: {
      getInventory: inventoryDependency(5, async () => {
        abaSuccessStarted.resolve();
        await releaseAbaSuccess.promise;
      }),
    },
  });
  await abaSuccessStarted.promise;
  const claimedAbaSuccessState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: abaSuccessMapping.mapping_id },
    });
  assert.equal(claimedAbaSuccessState.verification_status, "CHECKING");
  assert.ok(claimedAbaSuccessState.execution_token);
  await prisma.sales_channel_inventory_verification_states.update({
    where: {
      verification_state_id: claimedAbaSuccessState.verification_state_id,
    },
    data: {
      verification_status: "CHECK_FAILED",
      processing_version: null,
      execution_token: null,
      retry_count: { increment: 1 },
      last_error_code: "INVENTORY_VERIFICATION_CLAIM_EXPIRED",
      state_revision: { increment: 1 },
      updated_at: databaseTimestamp("2026-08-02 10:09:46"),
    },
  });
  const replacementSuccessExecution =
    await refreshCoupangInventoryVerification({
      mappingId: abaSuccessMapping.mapping_id,
      now: new Date("2026-08-02T01:09:47.000Z"),
      dependencies: { getInventory: inventoryDependency(5) },
    });
  assert.equal(replacementSuccessExecution.outcome, "MATCHED");
  const replacementSuccessState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: abaSuccessMapping.mapping_id },
    });
  releaseAbaSuccess.resolve();
  assert.equal((await staleSuccessExecution).outcome, "CLAIM_LOST");
  const preservedReplacementSuccess =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: abaSuccessMapping.mapping_id },
    });
  assert.equal(preservedReplacementSuccess.verification_status, "MATCHED");
  assert.equal(
    preservedReplacementSuccess.state_revision,
    replacementSuccessState.state_revision,
    "a stale successful GET must not mutate the replacement execution"
  );

  const abaFailureMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-ABA-FAILURE",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  const abaFailureStarted = deferred();
  const releaseAbaFailure = deferred();
  const staleFailureExecution = refreshCoupangInventoryVerification({
    mappingId: abaFailureMapping.mapping_id,
    now: new Date("2026-08-02T01:09:48.000Z"),
    dependencies: {
      getInventory: async () => {
        abaFailureStarted.resolve();
        await releaseAbaFailure.promise;
        throw new Error("stale owner failed after replacement");
      },
    },
  });
  await abaFailureStarted.promise;
  const claimedAbaFailureState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: abaFailureMapping.mapping_id },
    });
  await prisma.sales_channel_inventory_verification_states.update({
    where: {
      verification_state_id: claimedAbaFailureState.verification_state_id,
    },
    data: {
      verification_status: "CHECK_FAILED",
      processing_version: null,
      execution_token: null,
      retry_count: { increment: 1 },
      last_error_code: "INVENTORY_VERIFICATION_CLAIM_EXPIRED",
      state_revision: { increment: 1 },
      updated_at: databaseTimestamp("2026-08-02 10:09:49"),
    },
  });
  const replacementFailureExecution =
    await refreshCoupangInventoryVerification({
      mappingId: abaFailureMapping.mapping_id,
      now: new Date("2026-08-02T01:09:50.000Z"),
      dependencies: { getInventory: inventoryDependency(4) },
    });
  assert.equal(replacementFailureExecution.outcome, "MISMATCH");
  const replacementFailureState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: abaFailureMapping.mapping_id },
    });
  releaseAbaFailure.resolve();
  assert.equal((await staleFailureExecution).outcome, "CLAIM_LOST");
  const preservedReplacementFailure =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: abaFailureMapping.mapping_id },
    });
  assert.equal(preservedReplacementFailure.verification_status, "MISMATCH");
  assert.equal(
    preservedReplacementFailure.state_revision,
    replacementFailureState.state_revision,
    "a stale failed GET must not mutate the replacement execution"
  );

  const batchOwnershipMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-BATCH-OWNERSHIP",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  const batchOwnershipWorker = await prisma.server_worker_jobs.create({
    data: {
      worker_key: "inventory-verification-batch-owner-test",
      worker_name: "Inventory verification batch owner test",
      worker_type: "SALES_CHANNEL",
      status: "RUNNING",
      started_at: databaseTimestamp("2026-08-02 10:09:00"),
      locked_by: "batch-owner-b",
      lease_token: "00000000-0000-4000-8000-000000000302",
      claim_generation: 1,
      locked_until: databaseTimestamp("2026-08-02 12:00:00"),
    },
  });
  await queueCoupangInventoryVerificationBatch({
    mappingIds: [batchOwnershipMapping.mapping_id],
    workerJobId: batchOwnershipWorker.worker_job_id,
    executionToken: "00000000-0000-4000-8000-000000000301",
    now: new Date("2026-08-02T01:09:51.000Z"),
  });
  await queueCoupangInventoryVerificationBatch({
    mappingIds: [batchOwnershipMapping.mapping_id],
    workerJobId: batchOwnershipWorker.worker_job_id,
    executionToken: "00000000-0000-4000-8000-000000000302",
    now: new Date("2026-08-02T01:09:52.000Z"),
  });
  const replacementQueueState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: batchOwnershipMapping.mapping_id },
    });
  const staleBatchProcess = await processCoupangInventoryVerificationBatch({
    mappingIds: [batchOwnershipMapping.mapping_id],
    credentialContext: { test: true },
    workerJobId: batchOwnershipWorker.worker_job_id,
    executionToken: "00000000-0000-4000-8000-000000000301",
    dependencies: {
      getInventory: async () => {
        assert.fail("a replaced batch owner must not make a GET");
      },
    },
  });
  assert.equal(staleBatchProcess.results[0].outcome, "ALREADY_CLAIMED");
  const preservedReplacementQueue =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: batchOwnershipMapping.mapping_id },
    });
  assert.equal(
    preservedReplacementQueue.state_revision,
    replacementQueueState.state_revision,
    "a replaced batch owner must not mutate the new queue during preparation"
  );
  const staleBatchFailure =
    await failQueuedCoupangInventoryVerificationBatch({
      mappingIds: [batchOwnershipMapping.mapping_id],
      workerJobId: batchOwnershipWorker.worker_job_id,
      executionToken: "00000000-0000-4000-8000-000000000301",
      error: new WorkerShutdownRequestedError("stale-batch-owner"),
      now: new Date("2026-08-02T01:09:53.000Z"),
    });
  assert.equal(staleBatchFailure.failedCount, 0);
  const currentBatchState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: batchOwnershipMapping.mapping_id },
    });
  assert.equal(currentBatchState.verification_status, "PENDING");
  assert.equal(
    currentBatchState.execution_token,
    "00000000-0000-4000-8000-000000000302"
  );
  const currentBatch = await processCoupangInventoryVerificationBatch({
    mappingIds: [batchOwnershipMapping.mapping_id],
    credentialContext: { test: true },
    workerJobId: batchOwnershipWorker.worker_job_id,
    executionToken: "00000000-0000-4000-8000-000000000302",
    dependencies: { getInventory: inventoryDependency(5) },
  });
  const currentBatchProcessedState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: batchOwnershipMapping.mapping_id },
    });
  assert.equal(
    currentBatch.results[0].outcome,
    "MATCHED",
    JSON.stringify({
      result: currentBatch.results[0],
      state: currentBatchProcessedState,
    })
  );
  await queueCoupangInventoryVerificationBatch({
    mappingIds: [batchOwnershipMapping.mapping_id],
    workerJobId: batchOwnershipWorker.worker_job_id,
    executionToken: "00000000-0000-4000-8000-000000000302",
    now: new Date("2026-08-02T01:09:53.000Z"),
  });
  const currentBatchFailure =
    await failQueuedCoupangInventoryVerificationBatch({
      mappingIds: [batchOwnershipMapping.mapping_id],
      workerJobId: batchOwnershipWorker.worker_job_id,
      executionToken: "00000000-0000-4000-8000-000000000302",
      error: new WorkerShutdownRequestedError("current-batch-owner"),
      now: new Date("2026-08-02T01:09:54.000Z"),
    });
  assert.equal(currentBatchFailure.failedCount, 1);
  const failedCurrentBatchState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: batchOwnershipMapping.mapping_id },
    });
  assert.equal(failedCurrentBatchState.verification_status, "CHECK_FAILED");
  assert.equal(failedCurrentBatchState.execution_token, null);

  const skippedOwnershipMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-SKIPPED-OWNERSHIP",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  const skippedOwnershipStarted = deferred();
  const releaseSkippedOwnership = deferred();
  const staleSkippedExecution = refreshCoupangInventoryVerification({
    mappingId: skippedOwnershipMapping.mapping_id,
    now: new Date("2026-08-02T01:09:54.000Z"),
    dependencies: {
      getInventory: inventoryDependency(5, async () => {
        skippedOwnershipStarted.resolve();
        await releaseSkippedOwnership.promise;
      }),
    },
  });
  await skippedOwnershipStarted.promise;
  await prisma.sales_channel_product_mappings.update({
    where: { mapping_id: skippedOwnershipMapping.mapping_id },
    data: {
      mapping_status: "UNMAPPED",
      updated_at: databaseTimestamp("2026-08-02 10:09:55"),
    },
  });
  const skippedReplacement = await refreshCoupangInventoryVerification({
    mappingId: skippedOwnershipMapping.mapping_id,
    now: new Date("2026-08-02T01:09:55.000Z"),
    dependencies: {
      getInventory: async () => {
        assert.fail("a skipped mapping must not make a replacement GET");
      },
    },
  });
  assert.equal(skippedReplacement.outcome, "SKIPPED");
  releaseSkippedOwnership.resolve();
  assert.equal((await staleSkippedExecution).outcome, "CLAIM_LOST");
  const preservedSkippedOwnership =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { mapping_id: skippedOwnershipMapping.mapping_id },
    });
  assert.equal(preservedSkippedOwnership.verification_status, "SKIPPED");
  assert.equal(preservedSkippedOwnership.processing_version, null);
  assert.equal(preservedSkippedOwnership.execution_token, null);

  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  const latestExpectedQuantity = Math.max(
    0,
    state.ledger_quantity - state.pending_order_quantity
  );
  const staleRepairObservation =
    await recordCoupangInventoryRepairVerificationObservation({
      mappingId: mapping.mapping_id,
      desiredVersionSnapshot: state.desired_version - 1,
      mismatchSinceSnapshot: "stale-mismatch-snapshot",
      projectionBasisHashSnapshot: state.projection_basis_hash,
      expectedChannelQuantitySnapshot: state.ledger_quantity,
      observedChannelQuantity: latestExpectedQuantity,
      now: new Date("2026-08-02T01:09:50.000Z"),
    });
  assert.equal(staleRepairObservation.snapshotCurrent, false);
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.verification_status, "MATCHED");
  assert.equal(state.channel_quantity, latestExpectedQuantity);
  assert.equal(state.retry_count, 0);
  assert.equal(state.last_error_code, null);
  assert.equal(state.last_error_message, null);
  assert.equal(state.mismatch_since, null);

  const staleMismatchingObservation =
    await recordCoupangInventoryRepairVerificationObservation({
      mappingId: mapping.mapping_id,
      desiredVersionSnapshot: state.desired_version - 1,
      mismatchSinceSnapshot: "another-stale-mismatch-snapshot",
      projectionBasisHashSnapshot: state.projection_basis_hash,
      expectedChannelQuantitySnapshot: latestExpectedQuantity,
      observedChannelQuantity: latestExpectedQuantity + 1,
      now: new Date("2026-08-02T01:09:51.000Z"),
    });
  assert.equal(staleMismatchingObservation.snapshotCurrent, false);
  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(state.verification_status, "MISMATCH");
  assert.equal(state.channel_quantity, latestExpectedQuantity + 1);
  assert.equal(state.retry_count, 0);
  assert.equal(state.last_error_code, null);
  assert.equal(state.last_error_message, null);
  assert.ok(state.mismatch_since);

  await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:09:55.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });

  await prisma.sales_channel_product_mappings.update({
    where: { mapping_id: mapping.mapping_id },
    data: {
      mapping_status: "UNMAPPED",
      updated_at: databaseTimestamp("2026-08-02 10:10:00"),
    },
  });
  const skipped = await refreshCoupangInventoryVerification({
    mappingId: mapping.mapping_id,
    now: new Date("2026-08-02T01:10:00.000Z"),
    dependencies: {
      getInventory: async () => assert.fail("SKIPPED mapping must not call GET"),
    },
  });
  assert.equal(skipped.outcome, "SKIPPED");

  state =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  await prisma.sales_channel_inventory_verification_states.update({
    where: { verification_state_id: stateId },
    data: {
      verification_status: "CHECKING",
      processing_version: state.desired_version,
      execution_token: "expired-manual-owner",
      state_revision: { increment: 1 },
      updated_at: databaseTimestamp("2026-08-02 09:00:00"),
    },
  });

  const pendingRecoveryMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-PENDING-RECOVERY",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  const pendingRecoveryResult = await refreshCoupangInventoryVerification({
    mappingId: pendingRecoveryMapping.mapping_id,
    now: new Date("2026-08-02T01:00:00.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  await prisma.sales_channel_inventory_verification_states.update({
    where: {
      verification_state_id: pendingRecoveryResult.verificationStateId,
    },
    data: {
      verification_status: "PENDING",
      processing_version: null,
      state_revision: { increment: 1 },
      updated_at: databaseTimestamp("2026-08-02 09:00:00"),
    },
  });

  const activeMapping = await prisma.sales_channel_product_mappings.create({
    data: {
      channel: "COUPANG",
      external_vendor_item_id: "VENDOR-ACTIVE-WORKER",
      sales_offer_id: offer.sales_offer_id,
      mapping_status: "MAPPED",
    },
  });
  const activeStateResult = await refreshCoupangInventoryVerification({
    mappingId: activeMapping.mapping_id,
    now: new Date("2026-08-02T01:00:00.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  const worker = await prisma.server_worker_jobs.create({
    data: {
      worker_key: "inventory-verification-test-worker",
      worker_name: "Inventory verification test worker",
      worker_type: "SALES_CHANNEL",
      status: "RUNNING",
      started_at: databaseTimestamp("2026-08-02 09:30:00"),
      locked_by: "test-process",
      lease_token: "00000000-0000-4000-8000-000000000401",
      claim_generation: 1,
      locked_until: databaseTimestamp("2026-08-02 12:00:00"),
    },
  });
  const activeState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: activeStateResult.verificationStateId },
    });
  await prisma.sales_channel_inventory_verification_states.update({
    where: { verification_state_id: activeState.verification_state_id },
    data: {
      verification_status: "CHECKING",
      processing_version: activeState.desired_version,
      execution_token: "00000000-0000-4000-8000-000000000401",
      last_worker_job_id: worker.worker_job_id,
      state_revision: { increment: 1 },
      updated_at: databaseTimestamp("2026-08-02 09:40:00"),
    },
  });

  const replacedLeaseMapping =
    await prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_vendor_item_id: "VENDOR-REPLACED-WORKER-LEASE",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
      },
    });
  const replacedLeaseResult = await refreshCoupangInventoryVerification({
    mappingId: replacedLeaseMapping.mapping_id,
    now: new Date("2026-08-02T01:00:00.000Z"),
    dependencies: { getInventory: inventoryDependency(5) },
  });
  const replacedLeaseState =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: {
        verification_state_id: replacedLeaseResult.verificationStateId,
      },
    });
  await prisma.sales_channel_inventory_verification_states.update({
    where: { verification_state_id: replacedLeaseState.verification_state_id },
    data: {
      verification_status: "CHECKING",
      processing_version: replacedLeaseState.desired_version,
      execution_token: "00000000-0000-4000-8000-000000000402",
      last_worker_job_id: worker.worker_job_id,
      state_revision: { increment: 1 },
      updated_at: databaseTimestamp("2026-08-02 09:40:00"),
    },
  });

  const recovery = await recoverStaleInventoryVerificationClaims({
    now: new Date("2026-08-02T02:00:00.000Z"),
    staleAfterMinutes: 15,
  });
  assert.equal(recovery.recoveredCount, 3);
  assert.equal(recovery.activeOwnerCount, 1);
  assert(recovery.recoveredIds.includes(stateId));
  assert(recovery.recoveredIds.includes(replacedLeaseState.verification_state_id));
  const recovered =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: stateId },
    });
  assert.equal(recovered.verification_status, "CHECK_FAILED");
  assert.equal(
    recovered.last_error_code,
    "INVENTORY_VERIFICATION_CLAIM_EXPIRED"
  );
  const stillClaimed =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: activeState.verification_state_id },
    });
  assert.equal(stillClaimed.verification_status, "CHECKING");
  const recoveredPending =
    await prisma.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: {
        verification_state_id: pendingRecoveryResult.verificationStateId,
      },
    });
  assert.equal(recoveredPending.verification_status, "CHECK_FAILED");
  assert.equal(
    recoveredPending.last_error_code,
    "INVENTORY_VERIFICATION_CYCLE_INCOMPLETE"
  );

  const stateCount =
    await prisma.sales_channel_inventory_verification_states.count({
      where: { mapping_id: mapping.mapping_id },
    });
  assert.equal(stateCount, 1);
  const putLogCount = await prisma.coupang_api_call_log.count({
    where: { method: "PUT" },
  });
  assert.equal(putLogCount, 0);
  console.log("Coupang inventory verification state machine passed.");
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
