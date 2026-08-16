// QuickHack note: 쿠팡 옵션 재고를 SELLABLE 원장수량과 읽기 전용으로 비교하고 현재 상태를 멱등 갱신합니다.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { isPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";
import {
  CoupangInventoryPayloadError,
  getCoupangVendorItemInventory,
  openCoupangApiCredentialContext,
  type CoupangApiCredentialContext,
} from "@/quickhack_server/sales-channel/coupang/api-client";
import {
  beginCoupangApiCallLog,
  completeCoupangApiCallLog,
  coupangApiCallErrorCode,
  failCoupangApiCallLog,
  markCoupangApiCallProcessing,
  markCoupangApiCallReceived,
} from "@/quickhack_server/sales-channel/coupang/api-call-log-service";
import {
  INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS,
} from "@/quickhack_server/sales-channel/inventory-quantity-projection-service";
import {
  calculateCoupangInventoryVerificationProjection,
  expectedCoupangInventoryQuantity,
  type CoupangInventoryVerificationProjection,
} from "@/quickhack_server/sales-channel/coupang/inventory-verification-projection-service";
import { setOperationTraceField } from "@/quickhack_server/observability/operation-trace";
import { isWorkerShutdownRequestedError } from "@/quickhack_server/workers/shutdown-runtime";
import {
  addSeconds,
  parseKstSqlDateTime,
  quickHackClock,
} from "@/quickhack_shared/core/time";
import { dateTimeEpoch } from "@/quickhack_server/core/database/time-boundary";

const COUPANG_CHANNEL = "COUPANG";
const INVENTORY_API_NAME = "GET_PRODUCT_QUANTITY_PRICE_STATUS";
const DEFAULT_HTTP_RETRY_COUNT = 2;
const DEFAULT_STALE_AFTER_MINUTES = 15;
const WORKER_LEASE_GRACE_SECONDS = 60;
const MAX_VERIFICATION_STATE_PREPARE_ATTEMPTS = 3;
const SKIP_REASON_VALUES = new Set<string>(
  Object.values(INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS)
);

export const COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE = {
  projectionChanged: "INVENTORY_PROJECTION_CHANGED_DURING_CHECK",
  workerShutdown: "WORKER_SHUTDOWN_REQUESTED",
  claimExpired: "INVENTORY_VERIFICATION_CLAIM_EXPIRED",
  cycleIncomplete: "INVENTORY_VERIFICATION_CYCLE_INCOMPLETE",
  projectionFailed: "INVENTORY_LEDGER_PROJECTION_FAILED",
} as const;

export type VerificationState = Awaited<
  ReturnType<
    typeof prisma.sales_channel_inventory_verification_states.findUniqueOrThrow
  >
>;

export type InventoryVerificationDependencies = {
  calculateProjection?: typeof calculateCoupangInventoryVerificationProjection;
  getInventory?: typeof getCoupangVendorItemInventory;
  openCredentialContext?: typeof openCoupangApiCredentialContext;
};

export type RefreshCoupangInventoryVerificationInput = {
  mappingId: number;
  credentialContext?: CoupangApiCredentialContext;
  workerJobId?: number | null;
  executionToken?: string | null;
  signal?: AbortSignal;
  now?: Date;
  dependencies?: InventoryVerificationDependencies;
};

export type InventoryVerificationRefreshResult = {
  mappingId: number;
  verificationStateId: number | null;
  outcome:
    | "MATCHED"
    | "MISMATCH"
    | "CHECK_FAILED"
    | "SKIPPED"
    | "ALREADY_CLAIMED"
    | "CLAIM_LOST";
  desiredVersion: number | null;
  apiCallLogId: number | null;
};

type ProjectionWithIdentity = Exclude<
  CoupangInventoryVerificationProjection,
  { skipReason: "MAPPING_NOT_FOUND" }
>;

export type PreparedCoupangInventoryVerificationProjection = {
  projection: CoupangInventoryVerificationProjection;
  state: VerificationState | null;
};

type ProjectionFailureMappingSnapshot = {
  channel: string;
  externalVendorItemId: string;
  salesOfferId: number | null;
  updatedAt: Date;
};

type ProjectionFailureGuard =
  | { kind: "MAPPING_ABSENT" }
  | {
      kind: "STATE_ABSENT";
      mapping: ProjectionFailureMappingSnapshot;
    }
  | {
      kind: "STATE_PRESENT";
      verificationStateId: number;
      stateRevision: number;
      desiredVersion: number;
      verificationStatus: string;
      processingVersion: number | null;
      executionToken: string | null;
      retryCount: number;
    };

type InventoryVerificationExecutionGuard = {
  verificationStateId: number;
  desiredVersion: number;
  executionToken: string;
};

class InventoryVerificationStateConflictError extends Error {
  constructor(mappingId: number) {
    super(`Inventory verification state ${mappingId} changed during preparation.`);
    this.name = "InventoryVerificationStateConflictError";
  }
}

class InventoryVerificationExecutionOwnershipConflictError extends Error {
  constructor(mappingId: number) {
    super(`Inventory verification state ${mappingId} is owned by another execution.`);
    this.name = "InventoryVerificationExecutionOwnershipConflictError";
  }
}

function endpointPath(vendorItemId: string) {
  return `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(
    vendorItemId
  )}/inventories`;
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return message
    .replace(
      /(authorization|access[_-]?key|secret[_-]?key|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 1000);
}

function isUniqueConstraintError(error: unknown) {
  return isPostgresqlUniqueViolation(error);
}

function requireExecutionToken(value: string | null | undefined) {
  const executionToken = String(value ?? "").trim();

  if (!executionToken) {
    throw Object.assign(
      new Error("Inventory verification execution token is required."),
      { code: "INVENTORY_VERIFICATION_EXECUTION_TOKEN_REQUIRED" }
    );
  }

  return executionToken;
}

async function captureProjectionFailureGuard(
  mappingId: number
): Promise<ProjectionFailureGuard> {
  const mapping = await prisma.sales_channel_product_mappings.findUnique({
    where: { mapping_id: mappingId },
    select: {
      channel: true,
      external_vendor_item_id: true,
      sales_offer_id: true,
      updated_at: true,
      inventory_verification_state: {
        select: {
          verification_state_id: true,
          state_revision: true,
          desired_version: true,
          verification_status: true,
          processing_version: true,
          execution_token: true,
          retry_count: true,
        },
      },
    },
  });

  if (!mapping) return { kind: "MAPPING_ABSENT" };

  if (!mapping.inventory_verification_state) {
    return {
      kind: "STATE_ABSENT",
      mapping: {
        channel: mapping.channel,
        externalVendorItemId: mapping.external_vendor_item_id,
        salesOfferId: mapping.sales_offer_id,
        updatedAt: mapping.updated_at,
      },
    };
  }

  return {
    kind: "STATE_PRESENT",
    verificationStateId:
      mapping.inventory_verification_state.verification_state_id,
    stateRevision: mapping.inventory_verification_state.state_revision,
    desiredVersion: mapping.inventory_verification_state.desired_version,
    verificationStatus:
      mapping.inventory_verification_state.verification_status,
    processingVersion:
      mapping.inventory_verification_state.processing_version,
    executionToken: mapping.inventory_verification_state.execution_token,
    retryCount: mapping.inventory_verification_state.retry_count,
  };
}

function projectionChanged(
  state: VerificationState,
  projection: ProjectionWithIdentity
) {
  return (
    state.sales_offer_id !== projection.salesOfferId ||
    dateTimeEpoch(state.mapping_updated_at_snapshot) !==
      dateTimeEpoch(projection.mappingUpdatedAt) ||
    state.projection_basis_hash !== projection.projectionBasisHash ||
    (projection.status === "PROJECTED" &&
      (state.ledger_quantity !== projection.ledgerQuantity ||
        state.pending_order_quantity !== projection.pendingOrderQuantity))
  );
}

export async function prepareLatestCoupangInventoryVerificationProjection(input: {
  mappingId: number;
  now?: Date;
  calculateProjection?: typeof calculateCoupangInventoryVerificationProjection;
  executionToken?: string | null;
  client?: Prisma.TransactionClient;
}): Promise<PreparedCoupangInventoryVerificationProjection> {
  const calculateProjection =
    input.calculateProjection ?? calculateCoupangInventoryVerificationProjection;
  const projection = await calculateProjection(input.mappingId, input.client);

  if (
    projection.status === "SKIPPED" &&
    projection.skipReason ===
      INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.mappingNotFound
  ) {
    return { projection, state: null };
  }

  const state = await prepareVerificationState(
    projection as ProjectionWithIdentity,
    input.now ?? quickHackClock.nowDate(),
    input.client,
    input.executionToken
  );

  return { projection, state };
}

export async function queueCoupangInventoryVerificationBatch(input: {
  mappingIds: number[];
  executionToken: string;
  workerJobId?: number | null;
  now?: Date;
  dependencies?: Pick<InventoryVerificationDependencies, "calculateProjection">;
}) {
  const now = input.now ?? quickHackClock.nowDate();
  const nowText = now;
  const executionToken = requireExecutionToken(input.executionToken);
  const mappingIds = Array.from(
    new Set(
      input.mappingIds.filter(
        (mappingId) => Number.isSafeInteger(mappingId) && mappingId > 0
      )
    )
  );
  const queuedMappingIds: number[] = [];
  const failedMappingIds: number[] = [];
  let skippedCount = 0;
  let alreadyClaimedCount = 0;

  for (const mappingId of mappingIds) {
    const failureGuard = await captureProjectionFailureGuard(mappingId);
    let prepared: PreparedCoupangInventoryVerificationProjection;

    try {
      prepared = await prepareLatestCoupangInventoryVerificationProjection({
        mappingId,
        now,
        calculateProjection: input.dependencies?.calculateProjection,
      });
    } catch (error) {
      const failed = await persistProjectionFailure({
        mappingId,
        error,
        nowText,
        guard: failureGuard,
        executionToken,
      });
      if (failed.outcome === "CHECK_FAILED") {
        failedMappingIds.push(mappingId);
      } else if (
        failed.outcome === "ALREADY_CLAIMED" ||
        failed.outcome === "CLAIM_LOST"
      ) {
        alreadyClaimedCount += 1;
      }
      continue;
    }

    if (!prepared.state || prepared.projection.status !== "PROJECTED") {
      skippedCount += 1;
      continue;
    }

    const queued =
      await prisma.sales_channel_inventory_verification_states.updateMany({
        where: {
          verification_state_id: prepared.state.verification_state_id,
          desired_version: prepared.state.desired_version,
          state_revision: prepared.state.state_revision,
          verification_status: { not: "CHECKING" },
        },
        data: {
          verification_status: "PENDING",
          processing_version: null,
          execution_token: executionToken,
          next_retry_at: null,
          last_worker_job_id: input.workerJobId ?? null,
          state_revision: { increment: 1 },
          updated_at: nowText,
        },
      });

    if (queued.count === 1) {
      queuedMappingIds.push(mappingId);
    } else {
      alreadyClaimedCount += 1;
    }
  }

  return {
    candidateCount: mappingIds.length,
    queuedCount: queuedMappingIds.length,
    skippedCount,
    failedCount: failedMappingIds.length,
    alreadyClaimedCount,
    mappingIds: queuedMappingIds,
    failedMappingIds,
  };
}

export async function failQueuedCoupangInventoryVerificationBatch(input: {
  mappingIds: number[];
  workerJobId: number;
  executionToken: string;
  error: unknown;
  now?: Date;
}) {
  const mappingIds = Array.from(new Set(input.mappingIds));
  if (mappingIds.length === 0) return { failedCount: 0 };

  const executionToken = requireExecutionToken(input.executionToken);
  const nowText = input.now ?? quickHackClock.nowDate();
  const workerShutdown = isWorkerShutdownRequestedError(input.error);
  const updated =
    await prisma.sales_channel_inventory_verification_states.updateMany({
      where: {
        mapping_id: { in: mappingIds },
        last_worker_job_id: input.workerJobId,
        execution_token: executionToken,
        verification_status: { in: ["PENDING", "CHECKING"] },
      },
      data: {
        verification_status: "CHECK_FAILED",
        processing_version: null,
        execution_token: null,
        retry_count: { increment: 1 },
        next_retry_at: null,
        last_checked_at: nowText,
        resolved_at: null,
        last_error_code: workerShutdown
          ? COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE.workerShutdown
          : COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE.cycleIncomplete,
        state_revision: { increment: 1 },
        last_error_message: workerShutdown
          ? safeErrorMessage(input.error)
          : `주문 매칭 사이클이 재고 점검을 완료하지 못했습니다: ${safeErrorMessage(input.error)}`,
        updated_at: nowText,
      },
    });

  return { failedCount: updated.count };
}

export async function recordCoupangInventoryRepairVerificationObservation(input: {
  mappingId: number;
  desiredVersionSnapshot: number;
  mismatchSinceSnapshot: Date | string;
  projectionBasisHashSnapshot: string;
  expectedChannelQuantitySnapshot: number;
  observedChannelQuantity: number;
  now?: Date;
  client?: Prisma.TransactionClient;
}) {
  const nowText = input.now ?? quickHackClock.nowDate();
  const client = input.client ?? prisma;
  const prepared =
    await prepareLatestCoupangInventoryVerificationProjection({
      mappingId: input.mappingId,
      now: input.now,
      client: input.client,
    });
  const state = prepared.state;

  if (!state || prepared.projection.status !== "PROJECTED") {
    return { state, snapshotCurrent: false };
  }

  const snapshotCurrent =
    state.desired_version === input.desiredVersionSnapshot &&
    dateTimeEpoch(state.mismatch_since) ===
      dateTimeEpoch(input.mismatchSinceSnapshot) &&
    state.projection_basis_hash === input.projectionBasisHashSnapshot &&
    expectedCoupangInventoryQuantity(
      state.ledger_quantity,
      state.pending_order_quantity
    ) === input.expectedChannelQuantitySnapshot;

  if (
    state.verification_status === "CHECKING" ||
    state.execution_token !== null
  ) {
    return { state, snapshotCurrent: false };
  }

  const currentExpectedChannelQuantity = expectedCoupangInventoryQuantity(
    state.ledger_quantity,
    state.pending_order_quantity
  );
  const observationMatchesLatestProjection =
    input.observedChannelQuantity === currentExpectedChannelQuantity;
  const awaitsLocalFinalization =
    snapshotCurrent &&
    input.observedChannelQuantity === input.expectedChannelQuantitySnapshot;
  const verificationStatus = awaitsLocalFinalization
    ? "PENDING"
    : observationMatchesLatestProjection
      ? "MATCHED"
      : "MISMATCH";
  const updated =
    await client.sales_channel_inventory_verification_states.updateMany({
      where: {
        verification_state_id: state.verification_state_id,
        desired_version: state.desired_version,
        state_revision: state.state_revision,
        verification_status: { not: "CHECKING" },
        execution_token: null,
      },
      data: {
        verification_status: verificationStatus,
        processing_version: null,
        execution_token: null,
        channel_quantity: input.observedChannelQuantity,
        retry_count: 0,
        next_retry_at: null,
        mismatch_since:
          verificationStatus === "MATCHED"
            ? null
            : verificationStatus === "MISMATCH"
              ? state.mismatch_since ?? nowText
              : state.mismatch_since,
        resolved_at:
          verificationStatus === "MATCHED" ? nowText : null,
        state_revision: { increment: 1 },
        last_checked_at: nowText,
        last_error_code: null,
        last_error_message: null,
        updated_at: nowText,
      },
    });

  if (updated.count !== 1) {
    return { state, snapshotCurrent: false };
  }

  return {
    state:
      await client.sales_channel_inventory_verification_states.findUnique({
        where: { verification_state_id: state.verification_state_id },
      }),
    snapshotCurrent,
  };
}

function skippedMessage(projection: Extract<
  CoupangInventoryVerificationProjection,
  { status: "SKIPPED" }
>) {
  return `재고 검증 대상에서 제외되었습니다. (${projection.skipReason})`;
}

async function prepareVerificationStateWithClient(
  client: Prisma.TransactionClient,
  projection: ProjectionWithIdentity,
  nowText: Date,
  executionToken?: string | null
) {
    const existing =
      await client.sales_channel_inventory_verification_states.findUnique({
        where: { mapping_id: projection.mappingId },
      });

    if (!existing) {
      if (executionToken) {
        throw new InventoryVerificationExecutionOwnershipConflictError(
          projection.mappingId
        );
      }

      return client.sales_channel_inventory_verification_states.create({
        data: {
          mapping_id: projection.mappingId,
          channel: projection.channel ?? COUPANG_CHANNEL,
          external_vendor_item_id: projection.externalVendorItemId as string,
          sales_offer_id: projection.salesOfferId,
          verification_status:
            projection.status === "PROJECTED" ? "PENDING" : "SKIPPED",
          ledger_quantity:
            projection.status === "PROJECTED" ? projection.ledgerQuantity : 0,
          pending_order_quantity:
            projection.status === "PROJECTED"
              ? projection.pendingOrderQuantity
              : 0,
          mapping_updated_at_snapshot: projection.mappingUpdatedAt,
          projection_basis_hash: projection.projectionBasisHash,
          last_error_code:
            projection.status === "SKIPPED" ? projection.skipReason : null,
          last_error_message:
            projection.status === "SKIPPED"
              ? skippedMessage(projection)
              : null,
          created_at: nowText,
          updated_at: nowText,
        },
      });
    }

    if (executionToken && existing.execution_token !== executionToken) {
      throw new InventoryVerificationExecutionOwnershipConflictError(
        projection.mappingId
      );
    }

    const changed = projectionChanged(existing, projection);
    const desiredVersion = existing.desired_version + (changed ? 1 : 0);
    const checking = existing.verification_status === "CHECKING";
    const unresolved =
      existing.verification_status === "MISMATCH" ||
      existing.verification_status === "CHECK_FAILED";

    const updated =
      await client.sales_channel_inventory_verification_states.updateMany({
        where: {
          verification_state_id: existing.verification_state_id,
          state_revision: existing.state_revision,
          execution_token: executionToken || undefined,
        },
        data: {
          sales_offer_id: projection.salesOfferId,
          ledger_quantity:
            projection.status === "PROJECTED"
              ? projection.ledgerQuantity
              : existing.ledger_quantity,
          pending_order_quantity:
            projection.status === "PROJECTED"
              ? projection.pendingOrderQuantity
              : existing.pending_order_quantity,
          desired_version: desiredVersion,
          mapping_updated_at_snapshot: projection.mappingUpdatedAt,
          projection_basis_hash: projection.projectionBasisHash,
          verification_status:
            projection.status === "SKIPPED"
              ? "SKIPPED"
              : checking
                ? "CHECKING"
                : changed
                  ? "PENDING"
                  : existing.verification_status,
          processing_version:
            projection.status === "SKIPPED"
              ? null
              : checking
                ? existing.processing_version
                : null,
          execution_token:
            projection.status === "SKIPPED"
              ? null
              : existing.execution_token,
          retry_count: changed ? 0 : existing.retry_count,
          next_retry_at: null,
          mismatch_since:
            projection.status === "SKIPPED" ? null : existing.mismatch_since,
          resolved_at:
            projection.status === "SKIPPED" && unresolved
              ? nowText
              : existing.resolved_at,
          last_error_code:
            projection.status === "SKIPPED"
              ? projection.skipReason
              : existing.last_error_code,
          last_error_message:
            projection.status === "SKIPPED"
              ? skippedMessage(projection)
              : existing.last_error_message,
          state_revision: { increment: 1 },
          updated_at: checking && !changed ? existing.updated_at : nowText,
        },
      });

    if (updated.count !== 1) {
      throw new InventoryVerificationStateConflictError(projection.mappingId);
    }

    return client.sales_channel_inventory_verification_states.findUniqueOrThrow({
      where: { verification_state_id: existing.verification_state_id },
    });
}

async function prepareVerificationState(
  projection: ProjectionWithIdentity,
  nowText: Date,
  client?: Prisma.TransactionClient,
  executionToken?: string | null
) {
  if (client) {
    return prepareVerificationStateWithClient(
      client,
      projection,
      nowText,
      executionToken
    );
  }

  let lastConflict: unknown = null;

  for (
    let attempt = 0;
    attempt < MAX_VERIFICATION_STATE_PREPARE_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await prisma.$transaction((tx) =>
        prepareVerificationStateWithClient(
          tx,
          projection,
          nowText,
          executionToken
        )
      );
    } catch (error) {
      if (
        !(error instanceof InventoryVerificationStateConflictError) &&
        !isUniqueConstraintError(error)
      ) {
        throw error;
      }
      lastConflict = error;
    }
  }

  throw (
    lastConflict ??
    new InventoryVerificationStateConflictError(projection.mappingId)
  );
}

async function claimVerificationState(input: {
  state: VerificationState;
  workerJobId?: number | null;
  executionToken?: string | null;
  nowText: Date;
}): Promise<InventoryVerificationExecutionGuard | null> {
  const queuedExecutionToken = input.executionToken
    ? requireExecutionToken(input.executionToken)
    : null;
  const executionToken = queuedExecutionToken ?? randomUUID();
  const claimed =
    await prisma.sales_channel_inventory_verification_states.updateMany({
      where: {
        verification_state_id: input.state.verification_state_id,
        desired_version: input.state.desired_version,
        state_revision: input.state.state_revision,
        verification_status: queuedExecutionToken
          ? "PENDING"
          : { not: "CHECKING" },
        execution_token: queuedExecutionToken,
      },
      data: {
        verification_status: "CHECKING",
        processing_version: input.state.desired_version,
        execution_token: executionToken,
        last_worker_job_id: input.workerJobId ?? null,
        state_revision: { increment: 1 },
        updated_at: input.nowText,
      },
    });

  return claimed.count === 1
    ? {
        verificationStateId: input.state.verification_state_id,
        desiredVersion: input.state.desired_version,
        executionToken,
      }
    : null;
}

function currentStateWasUnresolved(state: VerificationState) {
  return (
    state.mismatch_since !== null ||
    (state.last_error_code !== null &&
      !SKIP_REASON_VALUES.has(state.last_error_code))
  );
}

async function finalizeSuccessfulVerification(input: {
  guard: InventoryVerificationExecutionGuard;
  channelQuantity: number;
  apiCallLogId: number;
  nowText: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const state =
      await tx.sales_channel_inventory_verification_states.findUnique({
        where: { verification_state_id: input.guard.verificationStateId },
      });

    if (
      !state ||
      state.verification_status !== "CHECKING" ||
      state.processing_version !== input.guard.desiredVersion ||
      state.execution_token !== input.guard.executionToken
    ) {
      await completeCoupangApiCallLog(tx, {
        apiCallLogId: input.apiCallLogId,
        processedRowCount: 0,
        skippedRowCount: 1,
        processedAt: input.nowText,
      });
      return "CLAIM_LOST" as const;
    }

    if (state.desired_version !== input.guard.desiredVersion) {
      const updated =
        await tx.sales_channel_inventory_verification_states.updateMany({
          where: {
            verification_state_id: input.guard.verificationStateId,
            desired_version: state.desired_version,
            processing_version: input.guard.desiredVersion,
            execution_token: input.guard.executionToken,
            verification_status: "CHECKING",
            state_revision: state.state_revision,
          },
          data: {
            verification_status: "CHECK_FAILED",
            processing_version: null,
            execution_token: null,
            retry_count: state.retry_count + 1,
            next_retry_at: null,
            last_checked_at: input.nowText,
            resolved_at: null,
            last_error_code:
              COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE.projectionChanged,
            last_error_message:
              "점검 중 재고 원장 또는 미매칭 주문수량이 변경되어 결과를 확정하지 못했습니다.",
            last_api_call_log_id: input.apiCallLogId,
            state_revision: { increment: 1 },
            updated_at: input.nowText,
          },
        });

      if (updated.count !== 1) return "CLAIM_LOST" as const;
      await completeCoupangApiCallLog(tx, {
        apiCallLogId: input.apiCallLogId,
        processedRowCount: 0,
        skippedRowCount: 1,
        processedAt: input.nowText,
      });
      return "CHECK_FAILED" as const;
    }

    const expectedChannelQuantity = expectedCoupangInventoryQuantity(
      state.ledger_quantity,
      state.pending_order_quantity
    );
    const matched = expectedChannelQuantity === input.channelQuantity;
    const unresolved = currentStateWasUnresolved(state);
    const updated =
      await tx.sales_channel_inventory_verification_states.updateMany({
        where: {
          verification_state_id: input.guard.verificationStateId,
          desired_version: input.guard.desiredVersion,
          processing_version: input.guard.desiredVersion,
          execution_token: input.guard.executionToken,
          verification_status: "CHECKING",
          state_revision: state.state_revision,
        },
        data: {
          verification_status: matched ? "MATCHED" : "MISMATCH",
          processing_version: null,
          execution_token: null,
          channel_quantity: input.channelQuantity,
          retry_count: 0,
          next_retry_at: null,
          mismatch_since: matched
            ? null
            : state.mismatch_since ?? input.nowText,
          last_checked_at: input.nowText,
          resolved_at: matched
            ? unresolved
              ? input.nowText
              : state.resolved_at
            : null,
          last_error_code: null,
          last_error_message: null,
          last_api_call_log_id: input.apiCallLogId,
          state_revision: { increment: 1 },
          updated_at: input.nowText,
        },
      });

    if (updated.count !== 1) return "CLAIM_LOST" as const;
    await completeCoupangApiCallLog(tx, {
      apiCallLogId: input.apiCallLogId,
      processedRowCount: 1,
      processedAt: input.nowText,
    });
    return matched ? ("MATCHED" as const) : ("MISMATCH" as const);
  });
}

async function markPayloadErrorReceived(
  apiCallLogId: number,
  error: CoupangInventoryPayloadError,
  nowText: Date
) {
  const metadata = error.responseMetadata;

  if (!metadata) return;
  await markCoupangApiCallReceived({
    apiCallLogId,
    endpointPath: metadata.requestPath,
    httpStatusCode: metadata.httpStatusCode,
    externalResponseCode: metadata.externalResponseCode,
    responseHash: metadata.responseHash,
    receivedAt: nowText,
  });
  await markCoupangApiCallProcessing({
    apiCallLogId,
    responseRowCount: 1,
    processingStartedAt: nowText,
  });
}

async function finalizeFailedVerification(input: {
  guard: InventoryVerificationExecutionGuard;
  apiCallLogId: number | null;
  error: unknown;
  now: Date;
  nowText: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const state =
      await tx.sales_channel_inventory_verification_states.findUniqueOrThrow({
        where: { verification_state_id: input.guard.verificationStateId },
      });

    if (
      state.verification_status !== "CHECKING" ||
      state.processing_version !== input.guard.desiredVersion ||
      state.execution_token !== input.guard.executionToken
    ) {
      return "CLAIM_LOST" as const;
    }

    const stale = state.desired_version !== input.guard.desiredVersion;
    const canceled = isWorkerShutdownRequestedError(input.error);
    const retryCount = state.retry_count + 1;
    const lastErrorCode = stale
      ? COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE.projectionChanged
      : canceled
        ? COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE.workerShutdown
        : coupangApiCallErrorCode(input.error);
    const lastErrorMessage = stale
      ? "점검 중 재고 원장 또는 미매칭 주문수량이 변경되어 결과를 확정하지 못했습니다."
      : safeErrorMessage(input.error);
    const updated =
      await tx.sales_channel_inventory_verification_states.updateMany({
        where: {
          verification_state_id: input.guard.verificationStateId,
          processing_version: input.guard.desiredVersion,
          execution_token: input.guard.executionToken,
          verification_status: "CHECKING",
          state_revision: state.state_revision,
        },
        data: {
          verification_status: "CHECK_FAILED",
          processing_version: null,
          execution_token: null,
          retry_count: retryCount,
          next_retry_at: null,
          last_checked_at: input.nowText,
          resolved_at: null,
          last_error_code: lastErrorCode,
          last_error_message: lastErrorMessage,
          last_api_call_log_id: input.apiCallLogId ?? undefined,
          state_revision: { increment: 1 },
          updated_at: input.nowText,
        },
      });

    return updated.count === 1
      ? ("CHECK_FAILED" as const)
      : ("CLAIM_LOST" as const);
  });
}

function mappingMatchesProjectionFailureSnapshot(
  mapping: {
    channel: string;
    external_vendor_item_id: string;
    sales_offer_id: number | null;
    updated_at: Date;
  },
  snapshot: ProjectionFailureMappingSnapshot
) {
  return (
    mapping.channel === snapshot.channel &&
    mapping.external_vendor_item_id === snapshot.externalVendorItemId &&
    mapping.sales_offer_id === snapshot.salesOfferId &&
    mapping.updated_at.getTime() === snapshot.updatedAt.getTime()
  );
}

async function projectionFailureConflictResult(
  mappingId: number
): Promise<InventoryVerificationRefreshResult> {
  const latest =
    await prisma.sales_channel_inventory_verification_states.findUnique({
      where: { mapping_id: mappingId },
      select: {
        verification_state_id: true,
        verification_status: true,
        desired_version: true,
        execution_token: true,
      },
    });

  return {
    mappingId,
    verificationStateId: latest?.verification_state_id ?? null,
    outcome:
      latest &&
      (latest.verification_status === "CHECKING" ||
        latest.execution_token !== null)
        ? "ALREADY_CLAIMED"
        : "CLAIM_LOST",
    desiredVersion: latest?.desired_version ?? null,
    apiCallLogId: null,
  };
}

async function persistProjectionFailure(input: {
  mappingId: number;
  error: unknown;
  nowText: Date;
  guard: ProjectionFailureGuard;
  executionToken?: string | null;
}): Promise<InventoryVerificationRefreshResult> {
  if (input.guard.kind === "MAPPING_ABSENT") throw input.error;

  if (input.guard.kind === "STATE_ABSENT") {
    const mapping = await prisma.sales_channel_product_mappings.findUnique({
      where: { mapping_id: input.mappingId },
      select: {
        channel: true,
        external_vendor_item_id: true,
        sales_offer_id: true,
        updated_at: true,
      },
    });

    if (
      !mapping ||
      !mappingMatchesProjectionFailureSnapshot(mapping, input.guard.mapping)
    ) {
      return projectionFailureConflictResult(input.mappingId);
    }

    try {
      const created =
        await prisma.sales_channel_inventory_verification_states.create({
          data: {
            mapping_id: input.mappingId,
            channel: mapping.channel,
            external_vendor_item_id: mapping.external_vendor_item_id,
            sales_offer_id: mapping.sales_offer_id,
            verification_status: "CHECK_FAILED",
            retry_count: 1,
            next_retry_at: null,
            last_checked_at: input.nowText,
            resolved_at: null,
            last_error_code:
              COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE.projectionFailed,
            last_error_message: safeErrorMessage(input.error),
            created_at: input.nowText,
            updated_at: input.nowText,
          },
        });

      return {
        mappingId: input.mappingId,
        verificationStateId: created.verification_state_id,
        outcome: "CHECK_FAILED",
        desiredVersion: created.desired_version,
        apiCallLogId: null,
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return projectionFailureConflictResult(input.mappingId);
    }
  }

  const expectedExecutionToken = input.executionToken
    ? requireExecutionToken(input.executionToken)
    : null;

  if (
    input.guard.verificationStatus === "CHECKING" ||
    (input.guard.executionToken !== null &&
      input.guard.executionToken !== expectedExecutionToken)
  ) {
    return projectionFailureConflictResult(input.mappingId);
  }

  const updated =
    await prisma.sales_channel_inventory_verification_states.updateMany({
      where: {
        verification_state_id: input.guard.verificationStateId,
        state_revision: input.guard.stateRevision,
        desired_version: input.guard.desiredVersion,
        verification_status: input.guard.verificationStatus,
        processing_version: input.guard.processingVersion,
        execution_token: input.guard.executionToken,
      },
      data: {
        verification_status: "CHECK_FAILED",
        processing_version: null,
        execution_token: null,
        retry_count: input.guard.retryCount + 1,
        next_retry_at: null,
        last_checked_at: input.nowText,
        resolved_at: null,
        last_error_code:
          COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE.projectionFailed,
        last_error_message: safeErrorMessage(input.error),
        state_revision: { increment: 1 },
        updated_at: input.nowText,
      },
    });

  if (updated.count !== 1) {
    return projectionFailureConflictResult(input.mappingId);
  }

  return {
    mappingId: input.mappingId,
    verificationStateId: input.guard.verificationStateId,
    outcome: "CHECK_FAILED",
    desiredVersion: input.guard.desiredVersion,
    apiCallLogId: null,
  };
}

export async function refreshCoupangInventoryVerification(
  input: RefreshCoupangInventoryVerificationInput
): Promise<InventoryVerificationRefreshResult> {
  const now = input.now ?? quickHackClock.nowDate();
  const nowText = now;
  const executionToken =
    input.executionToken === undefined || input.executionToken === null
      ? null
      : requireExecutionToken(input.executionToken);
  const calculateProjection =
    input.dependencies?.calculateProjection ??
    calculateCoupangInventoryVerificationProjection;
  const getInventory =
    input.dependencies?.getInventory ?? getCoupangVendorItemInventory;
  let projection: CoupangInventoryVerificationProjection;

  setOperationTraceField("inventory.mapping_id", input.mappingId);
  const failureGuard = await captureProjectionFailureGuard(input.mappingId);

  try {
    projection = await calculateProjection(input.mappingId);
  } catch (error) {
    return persistProjectionFailure({
      mappingId: input.mappingId,
      error,
      nowText,
      guard: failureGuard,
      executionToken,
    });
  }

  if (
    projection.status === "SKIPPED" &&
    projection.skipReason ===
      INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.mappingNotFound
  ) {
    return {
      mappingId: input.mappingId,
      verificationStateId: null,
      outcome: "SKIPPED",
      desiredVersion: null,
      apiCallLogId: null,
    };
  }

  let state: VerificationState;

  try {
    state = await prepareVerificationState(
      projection as ProjectionWithIdentity,
      nowText,
      undefined,
      executionToken
    );
  } catch (error) {
    if (
      executionToken &&
      (error instanceof InventoryVerificationStateConflictError ||
        error instanceof InventoryVerificationExecutionOwnershipConflictError)
    ) {
      return projectionFailureConflictResult(input.mappingId);
    }
    throw error;
  }

  if (projection.status === "SKIPPED") {
    setOperationTraceField("inventory.verification_status", "SKIPPED");
    return {
      mappingId: input.mappingId,
      verificationStateId: state.verification_state_id,
      outcome: "SKIPPED",
      desiredVersion: state.desired_version,
      apiCallLogId: null,
    };
  }

  setOperationTraceField(
    "inventory.vendor_item_id",
    projection.externalVendorItemId
  );
  setOperationTraceField("inventory.ledger_quantity", projection.ledgerQuantity);
  setOperationTraceField(
    "inventory.pending_order_quantity",
    projection.pendingOrderQuantity
  );
  setOperationTraceField(
    "inventory.expected_channel_quantity",
    projection.expectedChannelQuantity
  );

  const executionGuard = await claimVerificationState({
    state,
    workerJobId: input.workerJobId,
    executionToken,
    nowText,
  });

  if (!executionGuard) {
    return {
      mappingId: input.mappingId,
      verificationStateId: state.verification_state_id,
      outcome: "ALREADY_CLAIMED",
      desiredVersion: state.desired_version,
      apiCallLogId: null,
    };
  }

  let apiCallLogId: number | null = null;

  try {
    apiCallLogId = await beginCoupangApiCallLog({
      apiName: INVENTORY_API_NAME,
      endpointPath: endpointPath(projection.externalVendorItemId),
      externalVendorItemId: projection.externalVendorItemId,
      workerJobId: input.workerJobId,
      requestStartedAt: nowText,
    });
    const response = await getInventory(
      projection.externalVendorItemId,
      input.credentialContext,
      {
        signal: input.signal,
        retryCount: DEFAULT_HTTP_RETRY_COUNT,
      }
    );
    const receivedAt = input.now ?? quickHackClock.nowDate();
    await markCoupangApiCallReceived({
      apiCallLogId,
      endpointPath: response.requestPath,
      httpStatusCode: response.httpStatusCode,
      externalResponseCode: "SUCCESS",
      responseHash: response.responseHash,
      receivedAt,
    });
    await markCoupangApiCallProcessing({
      apiCallLogId,
      responseRowCount: 1,
      processingStartedAt: receivedAt,
    });
    const outcome = await finalizeSuccessfulVerification({
      guard: executionGuard,
      channelQuantity: response.payload.amountInStock,
      apiCallLogId,
      nowText: receivedAt,
    });
    setOperationTraceField("inventory.channel_quantity", response.payload.amountInStock);
    setOperationTraceField("inventory.verification_status", outcome);

    return {
      mappingId: input.mappingId,
      verificationStateId: state.verification_state_id,
      outcome,
      desiredVersion: state.desired_version,
      apiCallLogId,
    };
  } catch (error) {
    const failedAt = input.now ?? quickHackClock.nowDate();

    if (apiCallLogId !== null) {
      if (error instanceof CoupangInventoryPayloadError) {
        await markPayloadErrorReceived(apiCallLogId, error, failedAt).catch(
          () => undefined
        );
      }

      await failCoupangApiCallLog(apiCallLogId, error).catch(() => undefined);
    }

    const outcome = await finalizeFailedVerification({
      guard: executionGuard,
      apiCallLogId,
      error,
      now,
      nowText: failedAt,
    });
    setOperationTraceField("inventory.verification_status", outcome);

    return {
      mappingId: input.mappingId,
      verificationStateId: state.verification_state_id,
      outcome,
      desiredVersion: state.desired_version,
      apiCallLogId,
    };
  }
}

export async function processCoupangInventoryVerificationBatch(input: {
  mappingIds: number[];
  credentialContext?: CoupangApiCredentialContext;
  workerJobId?: number | null;
  executionToken?: string | null;
  signal?: AbortSignal;
  dependencies?: InventoryVerificationDependencies;
}) {
  const mappingIds = Array.from(
    new Set(
      input.mappingIds.filter(
        (mappingId) => Number.isSafeInteger(mappingId) && mappingId > 0
      )
    )
  );

  if (mappingIds.length === 0) {
    return { requestedCount: 0, results: [] as InventoryVerificationRefreshResult[] };
  }

  const openCredentialContext =
    input.dependencies?.openCredentialContext ?? openCoupangApiCredentialContext;
  const getInventory =
    input.dependencies?.getInventory ?? getCoupangVendorItemInventory;
  let credentialContextPromise: Promise<CoupangApiCredentialContext> | null = null;
  const getInventoryWithSharedContext: typeof getCoupangVendorItemInventory =
    async (vendorItemId, _credentialContext, options) => {
      credentialContextPromise ??= input.credentialContext
        ? Promise.resolve(input.credentialContext)
        : openCredentialContext("CACHED_READ");
      return getInventory(
        vendorItemId,
        await credentialContextPromise,
        options
      );
    };
  const results: InventoryVerificationRefreshResult[] = [];

  for (const mappingId of mappingIds) {
    results.push(
      await refreshCoupangInventoryVerification({
        mappingId,
        workerJobId: input.workerJobId,
        executionToken: input.executionToken,
        signal: input.signal,
        dependencies: {
          ...input.dependencies,
          getInventory: getInventoryWithSharedContext,
        },
      })
    );
  }

  return { requestedCount: mappingIds.length, results };
}

type WorkerSnapshot = {
  status: string;
  started_at: Date | null;
  lease_token: string | null;
  locked_until: Date | null;
};

function workerStillOwnsVerification(input: {
  now: Date;
  stateUpdatedAt: Date;
  executionToken: string | null;
  worker: WorkerSnapshot | null;
}) {
  const worker = input.worker;

  if (
    !worker ||
    worker.status !== "RUNNING" ||
    !worker.lease_token ||
    worker.lease_token !== input.executionToken ||
    !worker.locked_until ||
    !worker.started_at
  ) {
    return false;
  }

  const lockedUntil = parseKstSqlDateTime(worker.locked_until);
  const workerStartedAt = parseKstSqlDateTime(worker.started_at);
  const stateUpdatedAt = parseKstSqlDateTime(input.stateUpdatedAt);

  if (!lockedUntil || !workerStartedAt || !stateUpdatedAt) return false;

  return (
    lockedUntil.getTime() >
      input.now.getTime() - WORKER_LEASE_GRACE_SECONDS * 1000 &&
    stateUpdatedAt.getTime() >= workerStartedAt.getTime()
  );
}

export async function recoverStaleInventoryVerificationClaims(
  input: { now?: Date; staleAfterMinutes?: number } = {}
) {
  const now = input.now ?? quickHackClock.nowDate();
  const staleAfterMinutes =
    Number.isFinite(input.staleAfterMinutes) && Number(input.staleAfterMinutes) > 0
      ? Number(input.staleAfterMinutes)
      : DEFAULT_STALE_AFTER_MINUTES;
  const staleBefore = addSeconds(now, -staleAfterMinutes * 60);
  const nowText = now;
  const candidates =
    await prisma.sales_channel_inventory_verification_states.findMany({
      where: {
        verification_status: { in: ["PENDING", "CHECKING"] },
        updated_at: { lte: staleBefore },
      },
      orderBy: { verification_state_id: "asc" },
      include: {
        last_worker_job: {
          select: {
            status: true,
            started_at: true,
            lease_token: true,
            locked_until: true,
          },
        },
      },
    });
  const recoveredIds: number[] = [];
  let activeOwnerCount = 0;
  let changedBeforeRecoveryCount = 0;

  for (const candidate of candidates) {
    if (
      workerStillOwnsVerification({
        now,
        stateUpdatedAt: candidate.updated_at,
        executionToken: candidate.execution_token,
        worker: candidate.last_worker_job,
      })
    ) {
      activeOwnerCount += 1;
      continue;
    }

    const updated =
      await prisma.sales_channel_inventory_verification_states.updateMany({
        where: {
          verification_state_id: candidate.verification_state_id,
          verification_status: candidate.verification_status,
          processing_version: candidate.processing_version,
          execution_token: candidate.execution_token,
          state_revision: candidate.state_revision,
          updated_at: candidate.updated_at,
        },
        data: {
          verification_status: "CHECK_FAILED",
          processing_version: null,
          execution_token: null,
          retry_count: candidate.retry_count + 1,
          next_retry_at: null,
          last_checked_at: nowText,
          resolved_at: null,
          last_error_code:
            candidate.verification_status === "CHECKING"
              ? COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE.claimExpired
              : COUPANG_INVENTORY_VERIFICATION_FAILURE_CODE.cycleIncomplete,
          state_revision: { increment: 1 },
          last_error_message:
            candidate.verification_status === "CHECKING"
              ? "재고 점검을 소유한 worker 없이 처리 시간이 만료되었습니다."
              : "주문 매칭 사이클이 대기 중인 재고 점검을 시작하지 못한 채 종료되었습니다.",
          updated_at: nowText,
        },
      });

    if (updated.count === 1) {
      recoveredIds.push(candidate.verification_state_id);
    } else {
      changedBeforeRecoveryCount += 1;
    }
  }

  return {
    checkedCount: candidates.length,
    recoveredCount: recoveredIds.length,
    activeOwnerCount,
    changedBeforeRecoveryCount,
    recoveredIds,
    staleBefore,
  };
}
