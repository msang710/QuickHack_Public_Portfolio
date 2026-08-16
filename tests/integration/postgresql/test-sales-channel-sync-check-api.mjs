import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server.js";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
  projectRoot,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-sales-channel-sync-check-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function at(value) {
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

function request(pathname, options = {}) {
  const headers = {};

  if (options.token) {
    headers.cookie = `quickhack_session=${options.token}`;
  }

  if (options.body !== undefined || options.rawBody !== undefined) {
    headers["content-type"] = "application/json";
  }

  return new NextRequest(`http://localhost${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body:
      options.rawBody ??
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

async function createOption(category, optionKey, label) {
  const existing = await prisma.product_criteria_options.findFirst({
    where: {
      category,
      option_key: optionKey,
      parent_key: "",
    },
  });

  if (existing) return existing;
  return prisma.product_criteria_options.create({
    data: {
      category,
      option_key: optionKey,
      label,
    },
  });
}

function projectedInventory(mapping, offer, input = {}) {
  return {
    status: "PROJECTED",
    mappingId: mapping.mapping_id,
    channel: mapping.channel,
    externalVendorItemId: mapping.external_vendor_item_id,
    salesOfferId: offer.sales_offer_id,
    salesOfferCode: offer.offer_code,
    warrantyGroup: "2Y",
    eligibleSaleGrades: ["A", "A-", "B+"],
    ledgerQuantity: input.ledgerQuantity ?? 5,
    pendingOrderQuantity: input.pendingOrderQuantity ?? 2,
    expectedChannelQuantity: input.expectedChannelQuantity ?? 3,
    mappingUpdatedAt: mapping.updated_at,
    projectionBasisHash: input.projectionBasisHash ?? "basis",
  };
}

function inventoryResponse(vendorItemId, amountInStock) {
  return {
    mode: "mock",
    source: "sync-check-test",
    requestPath: `/inventory/${vendorItemId}`,
    httpStatusCode: 200,
    responseHash: `response-${vendorItemId}-${amountInStock}`,
    auth: {},
    payload: {
      vendorItemId,
      amountInStock,
      salePrice: null,
      onSale: true,
      checkedAt: "2026-08-02 12:00:00",
    },
  };
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const authService = await import("@/quickhack_server/auth/auth-service");
  const syncService = await import(
    "@/quickhack_server/sales-channel/sales-channel-sync-check-service"
  );
  const syncApi = await import(
    "@/quickhack_server/api/admin/sales-channel-sync-checks"
  );
  const writeApi = await import(
    "@/quickhack_server/api/admin/sales-channel-write-requests"
  );
  const timestamp = at("2026-08-02 08:00:00");
  const [viewer, staff] = await Promise.all([
    prisma.users.create({
      data: {
        username: "sync-check-viewer",
        password_hash: "test-only",
        role: "VIEWER",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
    prisma.users.create({
      data: {
        username: "sync-check-staff",
        password_hash: "test-only",
        role: "STAFF",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
  ]);
  await prisma.employee_profiles.create({
    data: {
      user_id: staff.user_id,
      display_name: "동기화 담당자",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const [viewerToken, staffToken] = await Promise.all([
    authService.createUserSession(viewer.user_id),
    authService.createUserSession(staff.user_id),
  ]);
  const [model, storage, color, warranty] = await Promise.all([
    createOption("PRODUCT_MODEL", "SYNC-MODEL", "동기화 기종"),
    createOption("STORAGE", "256GB", "256GB"),
    createOption("DEVICE_COLOR", "BLACK", "블랙"),
    createOption("WARRANTY_GROUP", "2Y", "2년 보증"),
  ]);
  const offer = await prisma.sales_offers.create({
    data: {
      offer_code: "SYNC-OFFER",
      model_option_id: model.option_id,
      storage_match_mode: "EXACT",
      storage_option_id: storage.option_id,
      color_match_mode: "EXACT",
      color_option_id: color.option_id,
      warranty_group_option_id: warranty.option_id,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const [mismatchMapping, failedMapping, pendingMapping] = await Promise.all([
    prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_product_id: "PRODUCT-BLACK",
        external_vendor_item_id: "VENDOR-BLACK",
        external_option_name: "블랙 / 256GB",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
    prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_product_id: "PRODUCT-RECHECK",
        external_vendor_item_id: "VENDOR-RECHECK",
        external_option_name: "재점검 / 256GB",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
    prisma.sales_channel_product_mappings.create({
      data: {
        channel: "COUPANG",
        external_product_id: "PRODUCT-PENDING",
        external_vendor_item_id: "VENDOR-PENDING",
        external_option_name: "Pending / 256GB",
        sales_offer_id: offer.sales_offer_id,
        mapping_status: "MAPPED",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
  ]);
  const mismatchState =
    await prisma.sales_channel_inventory_verification_states.create({
      data: {
        mapping_id: mismatchMapping.mapping_id,
        channel: mismatchMapping.channel,
        external_vendor_item_id: mismatchMapping.external_vendor_item_id,
        sales_offer_id: offer.sales_offer_id,
        verification_status: "MISMATCH",
        ledger_quantity: 5,
        pending_order_quantity: 2,
        channel_quantity: 4,
        desired_version: 2,
        mapping_updated_at_snapshot: mismatchMapping.updated_at,
        projection_basis_hash: "basis-mismatch",
        mismatch_since: at("2026-08-02 11:00:00"),
        last_checked_at: at("2026-08-02 11:00:00"),
        created_at: timestamp,
        updated_at: at("2026-08-02 11:00:00"),
      },
    });
  const failedState =
    await prisma.sales_channel_inventory_verification_states.create({
      data: {
        mapping_id: failedMapping.mapping_id,
        channel: failedMapping.channel,
        external_vendor_item_id: failedMapping.external_vendor_item_id,
        sales_offer_id: offer.sales_offer_id,
        verification_status: "CHECK_FAILED",
        ledger_quantity: 5,
        pending_order_quantity: 2,
        channel_quantity: null,
        desired_version: 1,
        mapping_updated_at_snapshot: failedMapping.updated_at,
        projection_basis_hash: "basis-recheck",
        retry_count: 1,
        last_error_code: "TEST_TIMEOUT",
        last_error_message: "재고 조회 시간이 초과되었습니다.",
        created_at: timestamp,
        updated_at: at("2026-08-02 08:30:00"),
      },
    });
  const pendingState =
    await prisma.sales_channel_inventory_verification_states.create({
      data: {
        mapping_id: pendingMapping.mapping_id,
        channel: pendingMapping.channel,
        external_vendor_item_id: pendingMapping.external_vendor_item_id,
        sales_offer_id: offer.sales_offer_id,
        verification_status: "PENDING",
        ledger_quantity: 5,
        pending_order_quantity: 2,
        channel_quantity: null,
        desired_version: 1,
        mapping_updated_at_snapshot: pendingMapping.updated_at,
        projection_basis_hash: "basis-pending",
        created_at: timestamp,
        updated_at: at("2026-08-02 10:30:00"),
      },
    });
  const writeRequest = await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "ORDER_STATUS_INSTRUCT",
      request_status: "REVIEW_REQUIRED",
      failure_stage: "EXTERNAL_VERIFICATION",
      external_order_id: "ORDER-SYNC-1",
      target_type: "ORDER",
      target_external_id: "ORDER-SYNC-1",
      idempotency_key: "SYNC-CHECK-WRITE-1",
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: "/integration-test/write",
      expected_before_status: "ACCEPT",
      requested_after_status: "INSTRUCT",
      source_menu_key: "shipment-all-orders",
      source_entity_type: "COUPANG_ORDER",
      source_entity_id: "ORDER-SYNC-1",
      error_code: "VERIFY_UNKNOWN",
      error_message: "채널 반영을 확인할 수 없습니다.",
      requested_by_user_id: staff.user_id,
      requested_at: at("2026-08-02 09:00:00"),
      review_required_at: at("2026-08-02 09:30:00"),
      created_at: at("2026-08-02 09:00:00"),
      updated_at: at("2026-08-02 10:00:00"),
      targets: {
        create: {
          target_type: "ORDER_ITEM",
          target_external_id: "ORDER-SYNC-1-ITEM",
          external_order_id: "ORDER-SYNC-1",
          external_shipment_id: "SHIPMENT-SYNC-1",
          external_vendor_item_id: "VENDOR-BLACK",
          invoice_number_snapshot: "INVOICE-SYNC-1",
          quantity: 1,
          inspection_result: "UNKNOWN",
          external_result_status: "UNKNOWN",
          external_result_code: "VERIFY_UNKNOWN",
          result_received_at: at("2026-08-02 09:30:00"),
          created_at: at("2026-08-02 09:00:00"),
        },
      },
      attempts: {
        create: {
          attempt_no: 1,
          attempt_type: "VERIFY_READ",
          attempt_status: "AMBIGUOUS",
          trigger_type: "AUTOMATIC",
          http_status_code: 500,
          external_response_code: "UNKNOWN",
          external_response_message: "unknown",
          error_code: "VERIFY_UNKNOWN",
          error_message: "확인 실패",
          external_applied_unknown: 1,
          started_at: at("2026-08-02 09:20:00"),
          completed_at: at("2026-08-02 09:30:00"),
          created_at: at("2026-08-02 09:20:00"),
        },
      },
    },
    include: { targets: true, attempts: true },
  });
  const control = await prisma.sales_channel_write_controls.create({
    data: {
      channel: "COUPANG",
      endpoint_key: "ORDER_STATUS_INSTRUCT",
      request_type: "ORDER_STATUS_INSTRUCT",
      is_paused: 1,
      consecutive_failure_count: 3,
      pause_reason: "연속 실패",
      last_failure_message: "최근 실패",
      last_failure_at: at("2026-08-02 09:30:00"),
      paused_at: at("2026-08-02 09:31:00"),
      created_at: timestamp,
      updated_at: at("2026-08-02 09:31:00"),
    },
  });

  const defaultQuery = syncService.parseSalesChannelSyncCheckQuery({});
  assert.deepEqual(defaultQuery, {
    kind: "ALL",
    status: "UNRESOLVED",
    search: "",
    limit: 300,
    cursor: null,
  });
  const defaultList = await syncService.listSalesChannelSyncChecks(defaultQuery);
  assert.equal(defaultList.count, 3);
  assert.equal(defaultList.unresolvedCount, 3);
  assert.deepEqual(defaultList.unresolvedCounts, {
    writeRequest: 1,
    inventoryVerification: 2,
    claimIntegrity: 0,
  });
  assert.deepEqual(
    defaultList.items.map((item) => item.kind),
    [
      "INVENTORY_VERIFICATION",
      "WRITE_REQUEST",
      "INVENTORY_VERIFICATION",
    ]
  );
  const mismatchItem = defaultList.items.find(
    (item) =>
      item.kind === "INVENTORY_VERIFICATION" &&
      item.verificationStateId === mismatchState.verification_state_id
  );
  assert.ok(mismatchItem);
  assert.equal(mismatchItem.ledgerQuantity, 5);
  assert.equal(mismatchItem.pendingOrderQuantity, 2);
  assert.equal(mismatchItem.expectedChannelQuantity, 3);
  assert.equal(mismatchItem.channelQuantity, 4);
  assert.equal(mismatchItem.difference, 1);
  assert.equal(mismatchItem.model, "동기화 기종");
  assert.equal(mismatchItem.storage, "256GB");
  assert.equal(mismatchItem.color, "블랙");
  const failedItem = defaultList.items.find(
    (item) =>
      item.kind === "INVENTORY_VERIFICATION" &&
      item.verificationStateId === failedState.verification_state_id
  );
  assert.ok(failedItem);
  assert.equal(failedItem.channelQuantity, null);
  assert.equal(failedItem.difference, null);
  assert.equal(
    defaultList.items.some(
      (item) =>
        item.kind === "INVENTORY_VERIFICATION" &&
        item.verificationStateId === pendingState.verification_state_id
    ),
    false,
    "Transient PENDING states must not be counted as unresolved checks."
  );

  const pagedKeys = [];
  const seenCursors = new Set();
  let combinedCursor = null;
  do {
    const page = await syncService.listSalesChannelSyncChecks(
      syncService.parseSalesChannelSyncCheckQuery({
        kind: "ALL",
        status: "UNRESOLVED",
        limit: 1,
        cursor: combinedCursor,
      })
    );
    pagedKeys.push(...page.items.map((item) => `${item.kind}:${item.id}`));
    if (page.nextCursor) {
      assert.equal(
        seenCursors.has(page.nextCursor),
        false,
        "The combined keyset cursor repeated instead of advancing."
      );
      seenCursors.add(page.nextCursor);
    }
    combinedCursor = page.nextCursor;
    assert.equal(page.coverage, "COMPLETE");
  } while (combinedCursor);
  assert.deepEqual(
    pagedKeys,
    defaultList.items.map((item) => `${item.kind}:${item.id}`),
    "The combined write/inventory keyset cursor skipped or duplicated a row."
  );
  assert.equal(seenCursors.size, 2);
  const firstCursor = JSON.parse(
    Buffer.from([...seenCursors][0], "base64url").toString("utf8")
  );
  assert.equal(
    firstCursor.updatedAt,
    "2026-08-02T02:00:00.000Z",
    "The sync-check cursor did not preserve the database instant across host time zones."
  );

  const inventorySearch = await syncService.listSalesChannelSyncChecks(
    syncService.parseSalesChannelSyncCheckQuery({
      kind: "INVENTORY_VERIFICATION",
      status: "ALL",
      search: "블랙",
      limit: "1",
    })
  );
  assert.equal(inventorySearch.count, 1);
  assert.equal(inventorySearch.items[0]?.kind, "INVENTORY_VERIFICATION");
  assert.equal(inventorySearch.controls.length, 0);
  assert.equal(inventorySearch.unresolvedCount, 3);

  for (const invalid of [
    { kind: "UNKNOWN" },
    { status: "UNKNOWN" },
    { limit: "3x" },
    { limit: 0 },
    { limit: 1001 },
  ]) {
    assert.throws(
      () => syncService.parseSalesChannelSyncCheckQuery(invalid),
      (error) => error?.status === 400
    );
  }

  const unauthorized = await syncApi.GET(
    request("/api/admin/sales-channel-sync-checks")
  );
  assert.equal(unauthorized.status, 401);
  const forbidden = await syncApi.GET(
    request("/api/admin/sales-channel-sync-checks", { token: viewerToken })
  );
  assert.equal(forbidden.status, 403);
  const allowed = await syncApi.GET(
    request("/api/admin/sales-channel-sync-checks", { token: staffToken })
  );
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).unresolvedCount, 3);
  const invalidQuery = await syncApi.GET(
    request("/api/admin/sales-channel-sync-checks?limit=3x", {
      token: staffToken,
    })
  );
  assert.equal(invalidQuery.status, 400);
  assert.equal(
    (await invalidQuery.json()).code,
    "INVALID_SALES_CHANNEL_SYNC_CHECK_QUERY"
  );
  const invalidAction = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      token: staffToken,
      method: "PATCH",
      body: { action: "unknown" },
    })
  );
  assert.equal(invalidAction.status, 400);
  const unauthorizedPatch = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      method: "PATCH",
      body: {
        action: "recheckInventory",
        verificationStateId: failedState.verification_state_id,
      },
    })
  );
  assert.equal(unauthorizedPatch.status, 401);
  const forbiddenPatch = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      token: viewerToken,
      method: "PATCH",
      body: {
        action: "recheckInventory",
        verificationStateId: failedState.verification_state_id,
      },
    })
  );
  assert.equal(forbiddenPatch.status, 403);
  const invalidStateId = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      token: staffToken,
      method: "PATCH",
      body: { action: "recheckInventory", verificationStateId: "3x" },
    })
  );
  assert.equal(invalidStateId.status, 400);
  assert.equal(
    (await invalidStateId.json()).code,
    "INVALID_INVENTORY_VERIFICATION_STATE_ID"
  );
  const missingState = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      token: staffToken,
      method: "PATCH",
      body: { action: "recheckInventory", verificationStateId: 999999 },
    })
  );
  assert.equal(missingState.status, 404);
  const malformed = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      token: staffToken,
      method: "PATCH",
      rawBody: "{",
    })
  );
  assert.equal(malformed.status, 400);

  const unauthorizedRepair = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      method: "PATCH",
      body: {
        action: "repairInventory",
        verificationStateId: mismatchState.verification_state_id,
        observedDesiredVersion: 2,
        observedMismatchSince: "2026-08-02 11:00:00",
        observedExpectedChannelQuantity: 3,
        observedChannelQuantity: 4,
      },
    })
  );
  assert.equal(unauthorizedRepair.status, 401);
  const forbiddenRepair = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      token: viewerToken,
      method: "PATCH",
      body: {
        action: "repairInventory",
        verificationStateId: mismatchState.verification_state_id,
        observedDesiredVersion: 2,
        observedMismatchSince: "2026-08-02 11:00:00",
        observedExpectedChannelQuantity: 3,
        observedChannelQuantity: 4,
      },
    })
  );
  assert.equal(forbiddenRepair.status, 403);
  const invalidRepairSnapshot = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      token: staffToken,
      method: "PATCH",
      body: {
        action: "repairInventory",
        verificationStateId: mismatchState.verification_state_id,
        observedDesiredVersion: 0,
        observedMismatchSince: "2026-08-02 11:00:00",
        observedExpectedChannelQuantity: 3,
        observedChannelQuantity: 4,
      },
    })
  );
  assert.equal(invalidRepairSnapshot.status, 400);
  assert.equal(
    (await invalidRepairSnapshot.json()).code,
    "INVALID_INVENTORY_REPAIR_SNAPSHOT"
  );

  const oldResponse = await writeApi.GET(
    request("/api/admin/sales-channel-write-requests", { token: staffToken })
  );
  assert.equal(oldResponse.status, 200);
  assert.deepEqual(await oldResponse.json(), {
    ok: true,
    unresolvedCount: 1,
    controls: [
      {
        id: control.sales_channel_write_control_id,
        revision: 0,
        channel: "COUPANG",
        endpointKey: "ORDER_STATUS_INSTRUCT",
        requestType: "ORDER_STATUS_INSTRUCT",
        isPaused: true,
        consecutiveFailureCount: 3,
        pauseReason: "연속 실패",
        lastFailureMessage: "최근 실패",
        lastFailureAt: "2026-08-02 09:30:00",
        pausedAt: "2026-08-02 09:31:00",
      },
    ],
    items: [
      {
        id: writeRequest.sales_channel_write_request_id,
        channel: "COUPANG",
        requestType: "ORDER_STATUS_INSTRUCT",
        requestStatus: "REVIEW_REQUIRED",
        reviewOperationInProgress: false,
        activeReviewOperation: "",
        activeReviewStartedAt: "",
        failureStage: "EXTERNAL_VERIFICATION",
        externalOrderId: "ORDER-SYNC-1",
        targetType: "ORDER",
        targetExternalId: "ORDER-SYNC-1",
        sourceMenuKey: "shipment-all-orders",
        sourceEntityType: "COUPANG_ORDER",
        sourceEntityId: "ORDER-SYNC-1",
        expectedBeforeStatus: "ACCEPT",
        requestedAfterStatus: "INSTRUCT",
        errorCode: "VERIFY_UNKNOWN",
        errorMessage: "채널 반영을 확인할 수 없습니다.",
        requestedAt: "2026-08-02 09:00:00",
        completedAt: "",
        reviewRequiredAt: "2026-08-02 09:30:00",
        manualVerificationStatus: "",
        manualVerificationNote: "",
        requestedBy: "동기화 담당자",
        manualVerifiedBy: "",
        targets: [
          {
            id: writeRequest.targets[0].sales_channel_write_request_target_id,
            resolutionGroupKey: "SHIPMENT:SHIPMENT-SYNC-1",
            resolutionGroupRepresentativeTargetId:
              writeRequest.targets[0].sales_channel_write_request_target_id,
            resolutionGroupTargetCount: 1,
            targetPosition: 0,
            targetType: "ORDER_ITEM",
            targetExternalId: "ORDER-SYNC-1-ITEM",
            allocationId: null,
            pgNo: "",
            externalOrderId: "ORDER-SYNC-1",
            externalShipmentId: "SHIPMENT-SYNC-1",
            externalVendorItemId: "VENDOR-BLACK",
            quantity: 1,
            inventoryVerificationStateId: null,
            inventoryDesiredVersionSnapshot: null,
            inventoryMismatchSinceSnapshot: "",
            inventoryProjectionBasisHashSnapshot: "",
            inventoryLedgerQuantitySnapshot: null,
            inventoryPendingOrderQuantitySnapshot: null,
            inventoryExpectedChannelQuantitySnapshot: null,
            inventoryObservedChannelQuantitySnapshot: null,
            inspectionResult: "UNKNOWN",
            externalResultStatus: "UNKNOWN",
            externalResultCode: "VERIFY_UNKNOWN",
            externalResultMessage: "",
            retryRequired: null,
            resultReceivedAt: "2026-08-02 09:30:00",
            localFinalizationStatus: "PENDING",
            localFinalizedAt: "",
          },
        ],
        attempts: [
          {
            id: writeRequest.attempts[0].sales_channel_write_request_attempt_id,
            attemptNo: 1,
            attemptType: "VERIFY_READ",
            attemptStatus: "AMBIGUOUS",
            triggerType: "AUTOMATIC",
            httpStatusCode: 500,
            externalResponseCode: "UNKNOWN",
            errorCode: "VERIFY_UNKNOWN",
            errorMessage: "확인 실패",
            externalAppliedUnknown: true,
            startedAt: "2026-08-02 09:20:00",
            completedAt: "2026-08-02 09:30:00",
          },
        ],
      },
    ],
  });

  let claimedGetCalls = 0;
  const alreadyClaimed =
    await syncService.recheckSalesChannelInventoryVerification({
      verificationStateId: mismatchState.verification_state_id,
      dependencies: {
        calculateProjection: async () => {
          await prisma.sales_channel_inventory_verification_states.update({
            where: {
              verification_state_id: mismatchState.verification_state_id,
            },
            data: {
              verification_status: "CHECKING",
              processing_version: mismatchState.desired_version,
              execution_token: "sync-check-api-active-owner",
              state_revision: { increment: 1 },
            },
          });
          return projectedInventory(mismatchMapping, offer, {
            projectionBasisHash: "basis-mismatch",
          });
        },
        getInventory: async () => {
          claimedGetCalls += 1;
          return inventoryResponse("VENDOR-BLACK", 3);
        },
      },
    });
  assert.equal(alreadyClaimed.outcome, "ALREADY_CLAIMED");
  assert.equal(alreadyClaimed.item.verificationStatus, "CHECKING");
  assert.equal(claimedGetCalls, 0);

  let recheckGetCalls = 0;
  const rechecked = await syncService.recheckSalesChannelInventoryVerification({
    verificationStateId: failedState.verification_state_id,
    dependencies: {
      calculateProjection: async () =>
        projectedInventory(failedMapping, offer, {
          projectionBasisHash: "basis-recheck",
        }),
      getInventory: async (vendorItemId) => {
        recheckGetCalls += 1;
        return inventoryResponse(String(vendorItemId), 3);
      },
    },
  });
  assert.equal(rechecked.outcome, "MATCHED");
  assert.equal(rechecked.item.verificationStatus, "MATCHED");
  assert.equal(rechecked.item.expectedChannelQuantity, 3);
  assert.equal(rechecked.item.channelQuantity, 3);
  assert.equal(rechecked.item.difference, 0);
  assert.equal(recheckGetCalls, 1);
  let pendingRecheckGetCalls = 0;
  await assert.rejects(
    syncService.recheckSalesChannelInventoryVerification({
      verificationStateId: pendingState.verification_state_id,
      dependencies: {
        calculateProjection: async () =>
          projectedInventory(pendingMapping, offer, {
            projectionBasisHash: "basis-pending",
          }),
        getInventory: async (vendorItemId) => {
          pendingRecheckGetCalls += 1;
          return inventoryResponse(String(vendorItemId), 3);
        },
      },
    }),
    (error) => error?.code === "INVENTORY_VERIFICATION_NOT_RECHECKABLE"
  );
  assert.equal(pendingRecheckGetCalls, 0);
  const notRecheckable = await syncApi.PATCH(
    request("/api/admin/sales-channel-sync-checks", {
      token: staffToken,
      method: "PATCH",
      body: {
        action: "recheckInventory",
        verificationStateId: failedState.verification_state_id,
      },
    })
  );
  assert.equal(notRecheckable.status, 409);
  assert.equal(
    (await notRecheckable.json()).code,
    "INVENTORY_VERIFICATION_NOT_RECHECKABLE"
  );

  const { beginWorkerShutdown } = await import(
    "@/quickhack_server/workers/shutdown-runtime"
  );
  beginWorkerShutdown("sales-channel-receipt-fault-injection");
  const decisionDuringShutdown = await writeApi.PATCH(
    request("/api/admin/sales-channel-write-requests", {
      token: staffToken,
      method: "PATCH",
      body: {
        action: "decision",
        requestId: writeRequest.sales_channel_write_request_id,
        targetId:
          writeRequest.targets[0].sales_channel_write_request_target_id,
        decision: "CHANNEL_NOT_APPLIED",
        note: "채널에서 미반영을 직접 확인했습니다.",
      },
    })
  );
  assert.equal(decisionDuringShutdown.status, 200);
  const decisionDuringShutdownPayload =
    await decisionDuringShutdown.clone().json();
  assert.equal(decisionDuringShutdownPayload.ok, true);
  assert.equal(
    decisionDuringShutdownPayload.result.manualVerificationStatus,
    "CHANNEL_NOT_APPLIED"
  );
  assert.equal(decisionDuringShutdownPayload.receipt.refreshRequired, false);
  assert.deepEqual(decisionDuringShutdownPayload.receipt.warnings, [
    { code: "WORKER_WAKE_DEFERRED", retryable: true },
  ]);
  const persistedDecisionDuringShutdown =
    await prisma.sales_channel_write_requests.findUniqueOrThrow({
      where: {
        sales_channel_write_request_id:
          writeRequest.sales_channel_write_request_id,
      },
    });
  assert.equal(
    persistedDecisionDuringShutdown.manual_verification_status,
    "CHANNEL_NOT_APPLIED"
  );

  const routeSource = readFileSync(
    path.join(
      projectRoot,
      "quickhack_server",
      "api",
      "admin",
      "sales-channel-sync-checks.ts"
    ),
    "utf8"
  );
  assert.match(
    routeSource,
    /sales-channel-sync-checks\$\{request\.nextUrl\.search\}/
  );
  assert.match(routeSource, /const bodyText = await request\.text\(\);/);
  assert.match(routeSource, /body: bodyText/);

  console.log("Sales-channel sync-check admin API contract passed.");
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
