import { prisma } from "@/quickhack_server/core/prisma";
import {
  dateTimeEpoch,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import {
  PublicError,
  publicConflict,
  publicNotFound,
  publicUnavailable,
} from "@/quickhack_server/core/public-error";
import { setOperationTraceField } from "@/quickhack_server/observability/operation-trace";
import { openCoupangApiCredentialContext } from "@/quickhack_server/sales-channel/coupang/api-client";
import { finalizePersistedCoupangInventoryQuantityRepair } from "@/quickhack_server/sales-channel/coupang/inventory-quantity-repair-finalizer";
import {
  prepareLatestCoupangInventoryVerificationProjection,
  refreshCoupangInventoryVerification,
  type InventoryVerificationDependencies,
} from "@/quickhack_server/sales-channel/coupang/inventory-verification-service";
import { expectedCoupangInventoryQuantity } from "@/quickhack_server/sales-channel/coupang/inventory-verification-projection-service";
import { getSalesChannelInventoryVerificationItem } from "@/quickhack_server/sales-channel/sales-channel-sync-check-service";
import {
  requestSalesChannelWrite,
  SalesChannelWriteReviewRequiredError,
  type SalesChannelWriteExecutionDependencies,
} from "@/quickhack_server/sales-channel/write/sales-channel-write-service";
import {
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
  type SalesChannelWriteCommand,
} from "@/quickhack_shared/sales-channel/write-requests";
import { SALES_CHANNEL_INVENTORY_REPAIR_OUTCOME } from "@/quickhack_shared/sales-channel/sync-checks";

export type RepairCoupangInventoryQuantityInput = {
  verificationStateId: number;
  observedDesiredVersion: number;
  observedMismatchSince: string;
  observedExpectedChannelQuantity: number;
  observedChannelQuantity: number;
  requestedByUserId: number;
};

export type RepairCoupangInventoryQuantityDependencies = {
  openCredentialContext?: typeof openCoupangApiCredentialContext;
  refreshVerification?: typeof refreshCoupangInventoryVerification;
  prepareProjection?: typeof prepareLatestCoupangInventoryVerificationProjection;
  inventoryVerificationDependencies?: InventoryVerificationDependencies;
  requestWrite?: typeof requestSalesChannelWrite;
  writeExecutionDependencies?: SalesChannelWriteExecutionDependencies;
};

function snapshotMatches(
  state: {
    verification_status: string;
    desired_version: number;
    mismatch_since: DateTimeInput;
    ledger_quantity: number;
    pending_order_quantity: number;
    channel_quantity: number | null;
  },
  input: RepairCoupangInventoryQuantityInput
) {
  return (
    state.verification_status === "MISMATCH" &&
    state.desired_version === input.observedDesiredVersion &&
    dateTimeEpoch(state.mismatch_since) ===
      dateTimeEpoch(input.observedMismatchSince) &&
    expectedCoupangInventoryQuantity(
      state.ledger_quantity,
      state.pending_order_quantity
    ) === input.observedExpectedChannelQuantity &&
    state.channel_quantity === input.observedChannelQuantity
  );
}

async function loadRepairState(verificationStateId: number) {
  return prisma.sales_channel_inventory_verification_states.findUnique({
    where: { verification_state_id: verificationStateId },
  });
}

async function changedPrecondition(
  verificationStateId: number,
  message = "화면을 조회한 뒤 재고 동기화 상태가 변경되었습니다. 최신 상태를 확인하세요."
) {
  let latestItem;

  try {
    latestItem = await getSalesChannelInventoryVerificationItem(
      verificationStateId
    );
  } catch {
    latestItem = undefined;
  }

  return publicConflict(
    "INVENTORY_REPAIR_PRECONDITION_CHANGED",
    message,
    latestItem ? { latestItem } : undefined
  );
}

function recordRepairTrace(state: {
  verification_state_id: number;
  mapping_id: number;
  external_vendor_item_id: string;
  ledger_quantity: number;
  pending_order_quantity: number;
  channel_quantity: number | null;
  desired_version: number;
}) {
  setOperationTraceField(
    "inventory.verification_state_id",
    state.verification_state_id
  );
  setOperationTraceField("inventory.mapping_id", state.mapping_id);
  setOperationTraceField(
    "inventory.vendor_item_id",
    state.external_vendor_item_id
  );
  setOperationTraceField("inventory.ledger_quantity", state.ledger_quantity);
  setOperationTraceField(
    "inventory.pending_order_quantity",
    state.pending_order_quantity
  );
  setOperationTraceField(
    "inventory.expected_channel_quantity",
    expectedCoupangInventoryQuantity(
      state.ledger_quantity,
      state.pending_order_quantity
    )
  );
  setOperationTraceField(
    "inventory.observed_channel_quantity",
    state.channel_quantity
  );
  setOperationTraceField("inventory.desired_version", state.desired_version);
}

export async function repairCoupangInventoryQuantity(
  input: RepairCoupangInventoryQuantityInput,
  dependencies: RepairCoupangInventoryQuantityDependencies = {}
) {
  const initial = await loadRepairState(input.verificationStateId);

  if (!initial) {
    throw publicNotFound(
      "INVENTORY_VERIFICATION_NOT_FOUND",
      "INVENTORY_VERIFICATION_NOT_FOUND"
    );
  }

  recordRepairTrace(initial);

  if (!snapshotMatches(initial, input)) {
    throw await changedPrecondition(input.verificationStateId);
  }

  const openCredentialContext =
    dependencies.openCredentialContext ?? openCoupangApiCredentialContext;
  const credentialContext = await openCredentialContext("FORCE_FRESH_WRITE");
  const refreshVerification =
    dependencies.refreshVerification ?? refreshCoupangInventoryVerification;
  const refreshResult = await refreshVerification({
    mappingId: initial.mapping_id,
    credentialContext,
    dependencies: dependencies.inventoryVerificationDependencies,
  });
  const refreshed = await loadRepairState(input.verificationStateId);

  if (!refreshed) {
    throw publicNotFound(
      "INVENTORY_VERIFICATION_NOT_FOUND",
      "INVENTORY_VERIFICATION_NOT_FOUND"
    );
  }

  const latestItem = await getSalesChannelInventoryVerificationItem(
    input.verificationStateId
  );

  if (refreshResult.outcome === "MATCHED") {
    throw publicConflict(
      "INVENTORY_REPAIR_ALREADY_MATCHED",
      "INVENTORY_REPAIR_ALREADY_MATCHED",
      { latestItem }
    );
  }

  if (refreshResult.outcome !== "MISMATCH") {
    throw publicConflict(
      `INVENTORY_REPAIR_${refreshResult.outcome}`,
      `INVENTORY_REPAIR_${refreshResult.outcome}`,
      { latestItem }
    );
  }

  if (!snapshotMatches(refreshed, input)) {
    throw await changedPrecondition(input.verificationStateId);
  }

  const mismatchSince = refreshed.mismatch_since;
  const projectionBasisHash = refreshed.projection_basis_hash;
  const observedChannelQuantity = refreshed.channel_quantity;

  if (!mismatchSince || !projectionBasisHash || observedChannelQuantity === null) {
    throw await changedPrecondition(
      input.verificationStateId,
      "INVENTORY_REPAIR_SNAPSHOT_INCOMPLETE"
    );
  }

  const expectedChannelQuantity = expectedCoupangInventoryQuantity(
    refreshed.ledger_quantity,
    refreshed.pending_order_quantity
  );
  const mismatchSinceText = requiredApiDateTime(mismatchSince);
  const idempotencyKey = [
    SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInventoryQuantityUpdate,
    refreshed.verification_state_id,
    mismatchSinceText,
    refreshed.desired_version,
    expectedChannelQuantity,
  ].join(":");
  const command: SalesChannelWriteCommand = {
    channel: "COUPANG",
    requestType:
      SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInventoryQuantityUpdate,
    idempotencyKey,
    targetType: "INVENTORY_VERIFICATION",
    targetExternalId: refreshed.external_vendor_item_id,
    sourceMenuKey: "admin-sales-channel-sync-check",
    sourceEntityType: "INVENTORY_VERIFICATION",
    sourceEntityId: String(refreshed.verification_state_id),
    requestedByUserId: input.requestedByUserId,
    verificationStateId: refreshed.verification_state_id,
    vendorItemId: refreshed.external_vendor_item_id,
    desiredVersion: refreshed.desired_version,
    mismatchSince: mismatchSinceText,
    projectionBasisHash,
    ledgerQuantity: refreshed.ledger_quantity,
    pendingOrderQuantity: refreshed.pending_order_quantity,
    expectedChannelQuantity,
    observedChannelQuantity,
    targets: [
      {
        targetType: "INVENTORY_VERIFICATION",
        targetExternalId: refreshed.external_vendor_item_id,
        externalVendorItemId: refreshed.external_vendor_item_id,
        inventoryVerificationStateId: refreshed.verification_state_id,
        inventoryDesiredVersionSnapshot: refreshed.desired_version,
        inventoryMismatchSinceSnapshot: mismatchSinceText,
        inventoryProjectionBasisHashSnapshot: projectionBasisHash,
        inventoryLedgerQuantitySnapshot: refreshed.ledger_quantity,
        inventoryPendingOrderQuantitySnapshot:
          refreshed.pending_order_quantity,
        inventoryExpectedChannelQuantitySnapshot: expectedChannelQuantity,
        inventoryObservedChannelQuantitySnapshot: observedChannelQuantity,
      },
    ],
  };
  const requestWrite = dependencies.requestWrite ?? requestSalesChannelWrite;
  const prepareProjection =
    dependencies.prepareProjection ??
    prepareLatestCoupangInventoryVerificationProjection;

  try {
    const result = await requestWrite(
      command,
      {
        beforeDispatch: async () => {
          const prepared = await prepareProjection({
            mappingId: refreshed.mapping_id,
          });
          const current = prepared.state;
          const projectionCurrent =
            prepared.projection.status === "PROJECTED" &&
            current?.verification_state_id === refreshed.verification_state_id &&
            current.verification_status === "MISMATCH" &&
            current.desired_version === refreshed.desired_version &&
            dateTimeEpoch(current.mismatch_since) ===
              dateTimeEpoch(mismatchSince) &&
            current.projection_basis_hash === projectionBasisHash &&
            current.external_vendor_item_id === refreshed.external_vendor_item_id &&
            current.ledger_quantity === refreshed.ledger_quantity &&
            current.pending_order_quantity === refreshed.pending_order_quantity &&
            current.channel_quantity === observedChannelQuantity &&
            expectedCoupangInventoryQuantity(
              current.ledger_quantity,
              current.pending_order_quantity
            ) === expectedChannelQuantity;

          if (!projectionCurrent) {
            throw await changedPrecondition(refreshed.verification_state_id);
          }
        },
        finalize: async ({ tx, requestId, finalizedAt }) => {
          await finalizePersistedCoupangInventoryQuantityRepair({
            tx,
            requestId,
            finalizedAt,
          });
        },
      },
      {
        ...dependencies.writeExecutionDependencies,
        openCredentialContext: async () => credentialContext,
      }
    );
    const item = await getSalesChannelInventoryVerificationItem(
      input.verificationStateId
    );

    setOperationTraceField("inventory.repair_outcome", "REPAIRED");
    setOperationTraceField("write.request_id", result.requestId);

    return {
      outcome: SALES_CHANNEL_INVENTORY_REPAIR_OUTCOME.repaired,
      writeRequestId: result.requestId,
      item,
    };
  } catch (error) {
    if (error instanceof PublicError) {
      throw error;
    }

    if (error instanceof SalesChannelWriteReviewRequiredError) {
      const item = await getSalesChannelInventoryVerificationItem(
        input.verificationStateId
      );

      throw publicConflict(
        "INVENTORY_REPAIR_REVIEW_REQUIRED",
        error.message,
        { writeRequestId: error.requestId, latestItem: item }
      );
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("차단:")) {
      throw publicConflict(
        "INVENTORY_REPAIR_WRITE_BLOCKED",
        message,
        { latestItem: await getSalesChannelInventoryVerificationItem(input.verificationStateId) }
      );
    }

    throw publicUnavailable(
      "INVENTORY_REPAIR_UNAVAILABLE",
      "INVENTORY_REPAIR_UNAVAILABLE"
    );
  }
}
