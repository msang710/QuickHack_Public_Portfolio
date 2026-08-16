// QuickHack service: business-completion based lifecycle for sales-channel delivery PII.
import type { Prisma } from "@/generated/prisma/client";
import {
  databaseDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import {
  maskAddress,
  maskMemo,
  maskName,
  maskPhone,
} from "@/quickhack_server/security/sensitive-data";
import {
  isTerminalCoupangExchangeStatus,
  isTerminalCoupangReturnStatus,
} from "@/quickhack_shared/sales-channel/coupang/claim-lifecycle";
import {
  COUPANG_CLAIM_EVENT_TYPE,
  COUPANG_CLAIM_SOURCE_TABLE,
} from "@/quickhack_shared/sales-channel/coupang/claim-history";
import {
  addSeconds,
  parseKstSqlDateTime,
} from "@/quickhack_shared/core/time";
import { dateTimeEpoch } from "@/quickhack_server/core/database/time-boundary";

export const PERSONAL_DATA_RETENTION_DAYS = 90;
export const PERSONAL_DATA_LIFECYCLE_CHANNEL = "COUPANG";

export const PERSONAL_DATA_RETENTION_BASIS = {
  deliveryCompleted: "DELIVERY_COMPLETED",
  returnCompleted: "RETURN_COMPLETED",
  returnWithdrawn: "RETURN_WITHDRAWN",
  exchangeCompleted: "EXCHANGE_COMPLETED",
} as const;

type RetentionBasis =
  (typeof PERSONAL_DATA_RETENTION_BASIS)[keyof typeof PERSONAL_DATA_RETENTION_BASIS];
type TransactionClient = Prisma.TransactionClient;
type LifecycleEvent = {
  coupang_raw_change_event_id: number;
  source_table: string;
  source_pk: string;
  event_type: string;
  external_shipment_id: string | null;
  detected_at: Date;
  fields: Array<{
    field_name: string;
    after_value: string | null;
  }>;
};

type TerminalEvidence = {
  at: Date;
  basis: RetentionBasis;
  fallbackTimestamp: boolean;
  parseFailed: boolean;
};

type ClaimProjection = {
  activeClaimCount: number;
  latestTerminal: TerminalEvidence | null;
  fallbackTimestampCount: number;
  parseFailedCount: number;
};

export type PersonalDataLifecycleReconciliation = {
  subjectCount: number;
  waitingCompletion: number;
  activeClaim: number;
  fallbackTimestamp: number;
  parseFailed: number;
};

type PersonalOrderFields = {
  ordererName: string | null;
  receiverName: string | null;
  receiverSafeNumber: string | null;
  receiverPostCode: string | null;
  receiverAddress1: string | null;
  receiverAddress2: string | null;
  shippingMemo: string | null;
};

function normalizedIdentifier(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function eventField(event: LifecycleEvent, fieldName: string) {
  return (
    event.fields.find((field) => field.field_name === fieldName)?.after_value ??
    null
  );
}

function parseBusinessTimestamp(value: Date | string | null | undefined) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  const text = String(value ?? "").trim();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return parseKstSqlDateTime(text);
  }

  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizedBusinessTimestamp(
  value: Date | string | null | undefined
) {
  return parseBusinessTimestamp(value);
}

function compareTimestamp(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined
) {
  const leftTime =
    parseBusinessTimestamp(left)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightTime =
    parseBusinessTimestamp(right)?.getTime() ?? Number.NEGATIVE_INFINITY;
  return leftTime - rightTime;
}

function sameTimestamp(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined
) {
  if (left == null || right == null) return left == null && right == null;
  return compareTimestamp(left, right) === 0;
}

function latestEvidence(
  left: TerminalEvidence | null,
  right: TerminalEvidence | null
) {
  if (!left) return right;
  if (!right) return left;
  return compareTimestamp(left.at, right.at) >= 0 ? left : right;
}

function terminalEvidenceFromEvent(
  event: LifecycleEvent,
  preferredFieldName: string,
  basis: RetentionBasis
): TerminalEvidence | null {
  const preferredValue = eventField(event, preferredFieldName);
  const preferredAt = normalizedBusinessTimestamp(preferredValue);
  if (preferredAt) {
    return {
      at: preferredAt,
      basis,
      fallbackTimestamp: false,
      parseFailed: false,
    };
  }

  const fallbackAt = normalizedBusinessTimestamp(event.detected_at);
  if (!fallbackAt) {
    return null;
  }

  return {
    at: fallbackAt,
    basis,
    fallbackTimestamp: true,
    parseFailed: Boolean(preferredValue),
  };
}

function eventsBySourcePk(events: LifecycleEvent[]) {
  const bySourcePk = new Map<string, LifecycleEvent[]>();
  for (const event of events) {
    const key = `${event.source_table}\u0000${event.source_pk}`;
    const current = bySourcePk.get(key) ?? [];
    current.push(event);
    bySourcePk.set(key, current);
  }

  for (const current of bySourcePk.values()) {
    current.sort(
      (left, right) =>
        left.coupang_raw_change_event_id -
        right.coupang_raw_change_event_id
    );
  }
  return bySourcePk;
}

function resolveClaimProjection(input: {
  externalShipmentId: string;
  returns: Array<{
    external_receipt_id: string;
    external_shipment_id: string | null;
    return_receipt_status: string | null;
    items: Array<{ external_shipment_id: string | null }>;
  }>;
  withdrawals: Array<{
    external_receipt_id: string;
    external_withdrawn_at: Date | null;
    observed_at: Date;
  }>;
  exchanges: Array<{
    external_exchange_id: string;
    external_shipment_id: string | null;
    exchange_status: string | null;
    scope_integrity_status: string;
    shipment_scopes: Array<{ external_shipment_id: string }>;
  }>;
  events: LifecycleEvent[];
}): ClaimProjection {
  const relevantReturns = input.returns.filter(
    (claim) => {
      const scopes = claim.items
        .map((item) => item.external_shipment_id)
        .filter((value): value is string => Boolean(value));
      return scopes.length === 0
        ? !claim.external_shipment_id || claim.external_shipment_id === input.externalShipmentId
        : scopes.includes(input.externalShipmentId);
    }
  );
  const relevantExchanges = input.exchanges.filter(
    (claim) =>
      claim.scope_integrity_status !== "VALID" ||
      claim.shipment_scopes.some(
        (scope) => scope.external_shipment_id === input.externalShipmentId
      )
  );
  const bySourcePk = eventsBySourcePk(input.events);
  const returnById = new Map(
    input.returns.map((claim) => [claim.external_receipt_id, claim])
  );
  const representedReturnIds = new Set(
    relevantReturns.map((claim) => claim.external_receipt_id)
  );
  const withdrawalByReceiptId = new Map(
    input.withdrawals.map((withdrawal) => [
      withdrawal.external_receipt_id,
      withdrawal,
    ])
  );
  let activeClaimCount = 0;
  let latestTerminal: TerminalEvidence | null = null;
  let fallbackTimestampCount = 0;
  let parseFailedCount = 0;

  const rememberTerminal = (evidence: TerminalEvidence | null) => {
    if (!evidence) return false;
    latestTerminal = latestEvidence(latestTerminal, evidence);
    fallbackTimestampCount += evidence.fallbackTimestamp ? 1 : 0;
    parseFailedCount += evidence.parseFailed ? 1 : 0;
    return true;
  };
  const requireTerminal = (evidence: TerminalEvidence | null) => {
    if (!rememberTerminal(evidence)) {
      activeClaimCount += 1;
    }
  };

  for (const claim of relevantReturns) {
    const withdrawalProjection = withdrawalByReceiptId.get(
      claim.external_receipt_id
    );
    const claimEvents =
      bySourcePk.get(
        `${COUPANG_CLAIM_SOURCE_TABLE.returns}\u0000${claim.external_receipt_id}`
      ) ?? [];
    const latestWithdrawal = [...claimEvents]
      .reverse()
      .find(
        (event) =>
          event.event_type === COUPANG_CLAIM_EVENT_TYPE.returnWithdrawn
      );
    const historicalTerminalEvent = [...claimEvents]
      .reverse()
      .find(
        (event) =>
          (event.event_type === COUPANG_CLAIM_EVENT_TYPE.returnObserved ||
            event.event_type === COUPANG_CLAIM_EVENT_TYPE.returnChanged) &&
          isTerminalCoupangReturnStatus(eventField(event, "receipt_status"))
      );
    const historicalTerminal = latestEvidence(
      historicalTerminalEvent
        ? terminalEvidenceFromEvent(
            historicalTerminalEvent,
            "external_completed_at",
            PERSONAL_DATA_RETENTION_BASIS.returnCompleted
          )
        : null,
      latestWithdrawal
        ? terminalEvidenceFromEvent(
            latestWithdrawal,
            "external_withdrawn_at",
            PERSONAL_DATA_RETENTION_BASIS.returnWithdrawn
          )
        : null
    );
    if (withdrawalProjection) {
      rememberTerminal({
        at:
          withdrawalProjection.external_withdrawn_at ??
          withdrawalProjection.observed_at,
        basis: PERSONAL_DATA_RETENTION_BASIS.returnWithdrawn,
        fallbackTimestamp:
          withdrawalProjection.external_withdrawn_at === null,
        parseFailed: false,
      });
      continue;
    }

    if (!isTerminalCoupangReturnStatus(claim.return_receipt_status)) {
      activeClaimCount += 1;
      rememberTerminal(historicalTerminal);
      continue;
    }

    requireTerminal(
      historicalTerminalEvent
        ? terminalEvidenceFromEvent(
            historicalTerminalEvent,
            "external_completed_at",
            PERSONAL_DATA_RETENTION_BASIS.returnCompleted
          )
        : null
    );
  }

  for (const claim of relevantExchanges) {
    const historicalTerminalEvent = [
      ...(bySourcePk.get(
        `${COUPANG_CLAIM_SOURCE_TABLE.exchanges}\u0000${claim.external_exchange_id}`
      ) ?? []),
    ]
      .reverse()
      .find(
        (event) =>
          (event.event_type === COUPANG_CLAIM_EVENT_TYPE.exchangeObserved ||
            event.event_type === COUPANG_CLAIM_EVENT_TYPE.exchangeChanged) &&
          isTerminalCoupangExchangeStatus(eventField(event, "exchange_status"))
      );
    if (!isTerminalCoupangExchangeStatus(claim.exchange_status)) {
      activeClaimCount += 1;
      rememberTerminal(
        historicalTerminalEvent
          ? terminalEvidenceFromEvent(
              historicalTerminalEvent,
              "external_modified_at",
              PERSONAL_DATA_RETENTION_BASIS.exchangeCompleted
            )
          : null
      );
      continue;
    }

    requireTerminal(
      historicalTerminalEvent
        ? terminalEvidenceFromEvent(
            historicalTerminalEvent,
            "external_modified_at",
            PERSONAL_DATA_RETENTION_BASIS.exchangeCompleted
          )
        : null
    );
  }

  // A withdrawal can arrive before its return snapshot. Without a known item
  // scope it applies to the whole order conservatively.
  for (const withdrawal of input.withdrawals) {
    if (representedReturnIds.has(withdrawal.external_receipt_id)) continue;
    const knownReturn = returnById.get(withdrawal.external_receipt_id);
    const knownScopes = knownReturn?.items
      .map((item) => item.external_shipment_id)
      .filter((value): value is string => Boolean(value)) ?? [];
    if (knownScopes.length > 0 && !knownScopes.includes(input.externalShipmentId)) {
      continue;
    }
    rememberTerminal({
      at: withdrawal.external_withdrawn_at ?? withdrawal.observed_at,
      basis: PERSONAL_DATA_RETENTION_BASIS.returnWithdrawn,
      fallbackTimestamp: withdrawal.external_withdrawn_at === null,
      parseFailed: false,
    });
  }

  return {
    activeClaimCount,
    latestTerminal,
    fallbackTimestampCount,
    parseFailedCount,
  };
}

async function loadOrderClaimEvidence(
  tx: TransactionClient,
  externalOrderId: string
) {
  const [returns, withdrawals, exchanges, events] = await Promise.all([
    tx.coupang_return_raw.findMany({
      where: { external_order_id: externalOrderId },
      select: {
        external_receipt_id: true,
        external_shipment_id: true,
        return_receipt_status: true,
        items: { select: { external_shipment_id: true } },
      },
    }),
    tx.coupang_return_withdrawal.findMany({
      where: { external_order_id: externalOrderId },
      select: {
        external_receipt_id: true,
        external_withdrawn_at: true,
        observed_at: true,
      },
    }),
    tx.coupang_exchange_raw.findMany({
      where: { external_order_id: externalOrderId },
      select: {
        external_exchange_id: true,
        external_shipment_id: true,
        exchange_status: true,
        scope_integrity_status: true,
        shipment_scopes: { select: { external_shipment_id: true } },
      },
    }),
    tx.coupang_raw_change_event.findMany({
      where: {
        external_order_id: externalOrderId,
        source_table: {
          in: [
            COUPANG_CLAIM_SOURCE_TABLE.returns,
            COUPANG_CLAIM_SOURCE_TABLE.exchanges,
          ],
        },
      },
      orderBy: { coupang_raw_change_event_id: "asc" },
      select: {
        coupang_raw_change_event_id: true,
        source_table: true,
        source_pk: true,
        event_type: true,
        external_shipment_id: true,
        detected_at: true,
        fields: {
          select: {
            field_name: true,
            after_value: true,
          },
        },
      },
    }),
  ]);

  return { returns, withdrawals, exchanges, events };
}

function resolvedRetention(input: {
  deliveryCompletedAt: Date | null;
  latestClaimTerminal: TerminalEvidence | null;
  activeClaimCount: number;
}) {
  if (input.activeClaimCount > 0) {
    return { startedAt: null, basis: null };
  }

  const delivery = input.deliveryCompletedAt
    ? {
        at: input.deliveryCompletedAt,
        basis: PERSONAL_DATA_RETENTION_BASIS.deliveryCompleted,
        fallbackTimestamp: false,
        parseFailed: false,
      }
    : null;
  const evidence = latestEvidence(delivery, input.latestClaimTerminal);
  return {
    startedAt: evidence?.at ?? null,
    basis: evidence?.basis ?? null,
  };
}

async function reconcileSubject(
  tx: TransactionClient,
  input: {
    channel: string;
    externalOrderId: string;
    externalShipmentId: string;
    now: Date | string;
    claimEvidence: Awaited<ReturnType<typeof loadOrderClaimEvidence>>;
  }
) {
  const key = {
    channel_external_order_id_external_shipment_id: {
      channel: input.channel,
      external_order_id: input.externalOrderId,
      external_shipment_id: input.externalShipmentId,
    },
  };
  const existing =
    await tx.sales_channel_personal_data_lifecycles.findUnique({
      where: key,
    });
  const projection = resolveClaimProjection({
    externalShipmentId: input.externalShipmentId,
    ...input.claimEvidence,
  });
  const existingTerminal = existing?.latest_claim_terminal_at
    ? {
        at: existing.latest_claim_terminal_at,
        basis:
          existing.retention_basis ===
            PERSONAL_DATA_RETENTION_BASIS.returnCompleted ||
          existing.retention_basis ===
            PERSONAL_DATA_RETENTION_BASIS.returnWithdrawn ||
          existing.retention_basis ===
            PERSONAL_DATA_RETENTION_BASIS.exchangeCompleted
            ? (existing.retention_basis as RetentionBasis)
            : PERSONAL_DATA_RETENTION_BASIS.returnCompleted,
        fallbackTimestamp: false,
        parseFailed: false,
      }
    : null;
  const latestClaimTerminal = latestEvidence(
    existingTerminal,
    projection.latestTerminal
  );
  const retention = resolvedRetention({
    deliveryCompletedAt: existing?.delivery_completed_at ?? null,
    latestClaimTerminal,
    activeClaimCount: projection.activeClaimCount,
  });
  const sameRetentionStartedAt =
    existing?.retention_started_at === null && retention.startedAt === null
      ? true
      : existing?.retention_started_at != null && retention.startedAt != null
        ? dateTimeEpoch(existing.retention_started_at) ===
          dateTimeEpoch(retention.startedAt)
        : false;
  const cycleChanged =
    !existing ||
    existing.active_claim_count !== projection.activeClaimCount ||
    !sameRetentionStartedAt ||
    existing.retention_basis !== retention.basis;

  const data = {
    latest_claim_terminal_at: latestClaimTerminal?.at ?? null,
    active_claim_count: projection.activeClaimCount,
    retention_started_at: retention.startedAt,
    retention_basis: retention.basis,
    redacted_at: cycleChanged ? null : existing?.redacted_at ?? null,
    updated_at: input.now,
  };

  if (existing) {
    const changed =
      !sameTimestamp(
        existing.latest_claim_terminal_at,
        data.latest_claim_terminal_at
      ) ||
      existing.active_claim_count !== data.active_claim_count ||
      !sameTimestamp(
        existing.retention_started_at,
        data.retention_started_at
      ) ||
      existing.retention_basis !== data.retention_basis ||
      !sameTimestamp(existing.redacted_at, data.redacted_at);
    if (changed) {
      await tx.sales_channel_personal_data_lifecycles.update({
        where: key,
        data,
      });
    }
  } else {
    await tx.sales_channel_personal_data_lifecycles.create({
      data: {
        channel: input.channel,
        external_order_id: input.externalOrderId,
        external_shipment_id: input.externalShipmentId,
        delivery_completed_at: null,
        ...data,
        created_at: input.now,
      },
    });
  }

  return {
    activeClaim: projection.activeClaimCount > 0,
    waitingCompletion:
      projection.activeClaimCount === 0 && retention.startedAt === null,
    fallbackTimestampCount: projection.fallbackTimestampCount,
    parseFailedCount: projection.parseFailedCount,
  };
}

export async function reconcilePersonalDataLifecyclesForOrder(
  tx: TransactionClient,
  input: {
    externalOrderId: string;
    externalShipmentId?: string | null;
    channel?: string;
    now?: Date | string;
  }
): Promise<PersonalDataLifecycleReconciliation> {
  const externalOrderId = normalizedIdentifier(input.externalOrderId);
  if (!externalOrderId) {
    return {
      subjectCount: 0,
      waitingCompletion: 0,
      activeClaim: 0,
      fallbackTimestamp: 0,
      parseFailed: 0,
    };
  }

  const channel = input.channel ?? PERSONAL_DATA_LIFECYCLE_CHANNEL;
  const now = databaseDateTime(input.now ?? databaseNow());
  const explicitShipmentId = normalizedIdentifier(input.externalShipmentId);
  const [orders, existingLifecycles, claimEvidence] = await Promise.all([
    tx.coupang_order_raw.findMany({
      where: {
        external_order_id: externalOrderId,
        ...(explicitShipmentId
          ? { external_shipment_id: explicitShipmentId }
          : {}),
      },
      select: { external_shipment_id: true },
    }),
    tx.sales_channel_personal_data_lifecycles.findMany({
      where: {
        channel,
        external_order_id: externalOrderId,
        ...(explicitShipmentId
          ? { external_shipment_id: explicitShipmentId }
          : {}),
      },
      select: { external_shipment_id: true },
    }),
    loadOrderClaimEvidence(tx, externalOrderId),
  ]);
  const shipmentIds = new Set<string>();
  if (explicitShipmentId) shipmentIds.add(explicitShipmentId);
  for (const row of [...orders, ...existingLifecycles]) {
    const shipmentId = normalizedIdentifier(row.external_shipment_id);
    if (shipmentId) shipmentIds.add(shipmentId);
  }
  if (!explicitShipmentId) {
    for (const claim of [...claimEvidence.returns, ...claimEvidence.exchanges]) {
      const shipmentId = normalizedIdentifier(claim.external_shipment_id);
      if (shipmentId) shipmentIds.add(shipmentId);
    }
  }

  const summary: PersonalDataLifecycleReconciliation = {
    subjectCount: 0,
    waitingCompletion: 0,
    activeClaim: 0,
    fallbackTimestamp: 0,
    parseFailed: 0,
  };
  for (const externalShipmentId of shipmentIds) {
    const result = await reconcileSubject(tx, {
      channel,
      externalOrderId,
      externalShipmentId,
      now,
      claimEvidence,
    });
    summary.subjectCount += 1;
    summary.waitingCompletion += result.waitingCompletion ? 1 : 0;
    summary.activeClaim += result.activeClaim ? 1 : 0;
    summary.fallbackTimestamp += result.fallbackTimestampCount;
    summary.parseFailed += result.parseFailedCount;
  }
  return summary;
}

export async function recordPersonalDataDeliveryCompletion(
  tx: TransactionClient,
  input: {
    channel?: string;
    externalOrderId: string;
    externalShipmentId: string;
    completedAt: Date | string;
    now?: Date | string;
  }
) {
  const channel = input.channel ?? PERSONAL_DATA_LIFECYCLE_CHANNEL;
  const externalOrderId = normalizedIdentifier(input.externalOrderId);
  const externalShipmentId = normalizedIdentifier(input.externalShipmentId);
  const completedAt = normalizedBusinessTimestamp(input.completedAt);
  const now = databaseDateTime(input.now ?? databaseNow());
  if (!externalOrderId || !externalShipmentId || !completedAt) {
    return {
      recorded: false,
      parseFailed: Boolean(input.completedAt) && !completedAt,
      reconciliation: null,
    };
  }

  const key = {
    channel_external_order_id_external_shipment_id: {
      channel,
      external_order_id: externalOrderId,
      external_shipment_id: externalShipmentId,
    },
  };
  const existing =
    await tx.sales_channel_personal_data_lifecycles.findUnique({
      where: key,
    });

  if (!existing) {
    await tx.sales_channel_personal_data_lifecycles.create({
      data: {
        channel,
        external_order_id: externalOrderId,
        external_shipment_id: externalShipmentId,
        delivery_completed_at: completedAt,
        created_at: now,
        updated_at: now,
      },
    });
  } else if (
    !existing.delivery_completed_at ||
    completedAt.getTime() < existing.delivery_completed_at.getTime()
  ) {
    await tx.sales_channel_personal_data_lifecycles.update({
      where: key,
      data: {
        delivery_completed_at: completedAt,
        updated_at: now,
      },
    });
  }

  const reconciliation = await reconcilePersonalDataLifecyclesForOrder(tx, {
    channel,
    externalOrderId,
    externalShipmentId,
    now,
  });
  return { recorded: true, parseFailed: false, reconciliation };
}

export function personalDataRetentionCutoff(
  referenceDate = new Date(),
  retentionDays = PERSONAL_DATA_RETENTION_DAYS
) {
  return addSeconds(
    referenceDate,
    -Math.max(1, retentionDays) * 24 * 60 * 60
  );
}

export function isPersonalDataLifecycleDue(
  lifecycle: {
    active_claim_count: number;
    retention_started_at: Date | null;
  },
  cutoff: Date
) {
  return (
    lifecycle.active_claim_count === 0 &&
    Boolean(
      lifecycle.retention_started_at &&
        lifecycle.retention_started_at.getTime() <= cutoff.getTime()
    )
  );
}

export async function shouldMaskOrderPersonalDataOnSync(
  tx: TransactionClient,
  input: {
    externalOrderId: string;
    externalShipmentId: string;
    referenceDate?: Date;
    retentionDays?: number;
  }
) {
  const lifecycle =
    await tx.sales_channel_personal_data_lifecycles.findUnique({
      where: {
        channel_external_order_id_external_shipment_id: {
          channel: PERSONAL_DATA_LIFECYCLE_CHANNEL,
          external_order_id: input.externalOrderId,
          external_shipment_id: input.externalShipmentId,
        },
      },
      select: {
        active_claim_count: true,
        retention_started_at: true,
        redacted_at: true,
      },
    });
  if (!lifecycle || lifecycle.active_claim_count > 0) {
    return false;
  }
  if (lifecycle.redacted_at) {
    return true;
  }
  const cutoff = personalDataRetentionCutoff(
    input.referenceDate,
    input.retentionDays
  );
  return isPersonalDataLifecycleDue(lifecycle, cutoff);
}

export function maskOrderPersonalData<T extends PersonalOrderFields>(
  order: T
): T {
  return {
    ...order,
    ordererName: maskName(order.ordererName) || null,
    receiverName: maskName(order.receiverName) || null,
    receiverSafeNumber: maskPhone(order.receiverSafeNumber, 4) || null,
    receiverPostCode: maskAddress(order.receiverPostCode) || null,
    receiverAddress1: maskAddress(order.receiverAddress1) || null,
    receiverAddress2: maskAddress(order.receiverAddress2) || null,
    shippingMemo: maskMemo(order.shippingMemo) || null,
  };
}
