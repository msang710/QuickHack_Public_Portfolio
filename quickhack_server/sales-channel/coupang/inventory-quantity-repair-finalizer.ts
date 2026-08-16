import type { Prisma } from "@/generated/prisma/client";
import { dateTimeEpoch } from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  prepareLatestCoupangInventoryVerificationProjection,
} from "@/quickhack_server/sales-channel/coupang/inventory-verification-service";
import { expectedCoupangInventoryQuantity } from "@/quickhack_server/sales-channel/coupang/inventory-verification-projection-service";

const INVENTORY_REPAIR_TARGET_TYPE = "INVENTORY_VERIFICATION";

class InventoryQuantityRepairFinalizationConflictError extends Error {
  constructor(verificationStateId: number) {
    super(
      `Inventory verification state ${verificationStateId} changed or is being checked during local finalization.`
    );
    this.name = "InventoryQuantityRepairFinalizationConflictError";
  }
}

async function loadInventoryRepairTarget(
  client: Prisma.TransactionClient | typeof prisma,
  requestId: number
) {
  const target = await client.sales_channel_write_request_targets.findFirst({
    where: {
      sales_channel_write_request_id: requestId,
      target_type: INVENTORY_REPAIR_TARGET_TYPE,
    },
    orderBy: { sales_channel_write_request_target_id: "asc" },
  });

  if (
    !target ||
    target.inventory_verification_state_id === null ||
    target.inventory_desired_version_snapshot === null ||
    !target.inventory_mismatch_since_snapshot ||
    !target.inventory_projection_basis_hash_snapshot ||
    target.inventory_expected_channel_quantity_snapshot === null
  ) {
    throw new Error(
      `Inventory quantity repair snapshot for write request ${requestId} is incomplete.`
    );
  }

  return target;
}

export async function preparePersistedCoupangInventoryQuantityRepairFinalization(
  requestId: number,
  transactionClient?: Prisma.TransactionClient
) {
  const client = transactionClient ?? prisma;
  const target = await loadInventoryRepairTarget(client, requestId);
  const state =
    await client.sales_channel_inventory_verification_states.findUnique({
      where: {
        verification_state_id:
          target.inventory_verification_state_id as number,
      },
      select: { mapping_id: true },
    });

  if (!state) {
    throw new Error(
      `Inventory verification state ${target.inventory_verification_state_id} was not found.`
    );
  }

  return prepareLatestCoupangInventoryVerificationProjection({
    mappingId: state.mapping_id,
    client: transactionClient,
  });
}

export async function finalizePersistedCoupangInventoryQuantityRepair(input: {
  tx: Prisma.TransactionClient;
  requestId: number;
  finalizedAt: Date;
}) {
  const target = await loadInventoryRepairTarget(input.tx, input.requestId);
  const state =
    await input.tx.sales_channel_inventory_verification_states.findUnique({
      where: {
        verification_state_id: target.inventory_verification_state_id as number,
      },
    });

  if (!state) {
    throw new Error(
      `Inventory verification state ${target.inventory_verification_state_id} was not found.`
    );
  }

  if (
    state.verification_status === "CHECKING" ||
    state.execution_token !== null
  ) {
    throw new InventoryQuantityRepairFinalizationConflictError(
      state.verification_state_id
    );
  }

  const currentExpectedChannelQuantity = expectedCoupangInventoryQuantity(
    state.ledger_quantity,
    state.pending_order_quantity
  );

  if (
    state.verification_status === "MATCHED" &&
    state.channel_quantity === currentExpectedChannelQuantity
  ) {
    return;
  }

  const snapshotCurrent =
    state.desired_version === target.inventory_desired_version_snapshot &&
    dateTimeEpoch(state.mismatch_since) ===
      dateTimeEpoch(target.inventory_mismatch_since_snapshot) &&
    state.projection_basis_hash ===
      target.inventory_projection_basis_hash_snapshot &&
    currentExpectedChannelQuantity ===
      target.inventory_expected_channel_quantity_snapshot;

  // A changed projection is prepared as PENDING. The successful PUT remains
  // authoritative for the quantity written, but a completed later check must
  // remain authoritative over this older write fact.
  const canProjectSuccessfulWrite =
    snapshotCurrent || state.verification_status === "PENDING";

  if (!canProjectSuccessfulWrite) {
    return;
  }

  const writtenChannelQuantity =
    target.inventory_expected_channel_quantity_snapshot;
  const matchesLatestProjection =
    writtenChannelQuantity === currentExpectedChannelQuantity;
  const updated =
    await input.tx.sales_channel_inventory_verification_states.updateMany({
      where: {
        verification_state_id: state.verification_state_id,
        desired_version: state.desired_version,
        state_revision: state.state_revision,
        verification_status: { not: "CHECKING" },
        execution_token: null,
      },
      data: {
        verification_status: matchesLatestProjection ? "MATCHED" : "MISMATCH",
        processing_version: null,
        execution_token: null,
        channel_quantity: writtenChannelQuantity,
        retry_count: 0,
        next_retry_at: null,
        mismatch_since: matchesLatestProjection
          ? null
          : state.mismatch_since ?? input.finalizedAt,
        last_checked_at: input.finalizedAt,
        resolved_at: matchesLatestProjection ? input.finalizedAt : null,
        last_error_code: null,
        last_error_message: null,
        state_revision: { increment: 1 },
        updated_at: input.finalizedAt,
      },
    });

  if (updated.count !== 1) {
    throw new InventoryQuantityRepairFinalizationConflictError(
      state.verification_state_id
    );
  }

}
