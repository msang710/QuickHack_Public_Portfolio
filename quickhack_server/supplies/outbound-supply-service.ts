import type { Prisma } from "@/generated/prisma/client";
import {
  NON_REUSABLE_AFTER_PACKING_SUPPLY_CODE,
  OUTBOUND_SUPPLY_CONSUMPTION_POLICY,
  PREPACK_COMPLETED_LOCATION,
  SUPPLY_CONSUMPTION_STAGE,
  SUPPLY_MOVEMENT_TYPE,
} from "@/quickhack_shared/supplies/supplies";
import {
  OUTBOUND_SUPPLY_CONSUMPTION_TRIGGERS,
  supplyConsumptionRuleMatchesOutboundContext,
} from "@/quickhack_server/supplies/supply-consumption-rule-matching";
import { recordSupplyMovementInTransaction } from "@/quickhack_server/supplies/supplies-service";
import { publicConflict } from "@/quickhack_server/core/public-error";

type TransactionClient = Prisma.TransactionClient;

const COUPANG_CHANNEL = "COUPANG";
const PREPACK_SOURCE_TYPE = "INVENTORY_AUDIT_PREPACK";
const PACKING_SOURCE_TYPE = "PACKING_CHECK";
const RETURN_SOURCE_TYPE = "COUPANG_RETURN_SUPPLY_RECOVERY";

type MatchedRule = Awaited<ReturnType<typeof loadMatchedOutboundRules>>[number];

function normalizedText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

async function loadMatchedOutboundRules(
  tx: TransactionClient,
  input: { pgNo: string; allocationId?: number | null }
) {
  const [device, allocation, rules] = await Promise.all([
    tx.devices.findUnique({
      where: { pg_no: input.pgNo },
      select: {
        pg_no: true,
        model: true,
        sale_grade: true,
        warranty: true,
        inventory: {
          select: {
            inventory_status: true,
            location: true,
          },
        },
      },
    }),
    input.allocationId
      ? tx.match_worker_allocation.findUnique({
          where: { allocation_id: input.allocationId },
          select: {
            allocation_id: true,
            pg_no: true,
            required_warranty_group: true,
          },
        })
      : Promise.resolve(null),
    tx.supply_consumption_rules.findMany({
      where: {
        is_active: 1,
        trigger_type: { in: [...OUTBOUND_SUPPLY_CONSUMPTION_TRIGGERS] },
        supplies: { is_active: 1 },
      },
      include: { supplies: true },
      orderBy: [{ supply_id: "asc" }, { rule_id: "asc" }],
    }),
  ]);

  if (!device?.inventory) {
    throw new Error(`\uC7AC\uACE0 \uAE30\uAE30\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${input.pgNo}`);
  }

  if (allocation && allocation.pg_no !== input.pgNo) {
    throw new Error("\uBE44\uD488 \uCC28\uAC10 \uB300\uC0C1 allocation\uACFC PG\uAC00 \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  }

  const matchContext = {
    channel: allocation ? COUPANG_CHANNEL : null,
    model: device.model,
    sale_grade: device.sale_grade,
    warranty: allocation?.required_warranty_group || device.warranty,
    inventoryStatus: device.inventory.inventory_status,
  };
  const matched = rules.filter((rule) =>
    supplyConsumptionRuleMatchesOutboundContext(rule, matchContext)
  );
  const ruleBySupplyId = new Map<number, (typeof matched)[number]>();

  for (const rule of matched) {
    const existing = ruleBySupplyId.get(rule.supply_id);

    if (existing) {
      throw new Error(
        `\uB3D9\uC77C\uD55C \uBE44\uD488\uC5D0 \uB300\uD55C \uD65C\uC131 \uC18C\uBAA8 \uADDC\uCE59\uC774 \uC911\uBCF5\uB429\uB2C8\uB2E4: ${rule.supplies.supply_name} (${existing.rule_id}, ${rule.rule_id})`
      );
    }

    ruleBySupplyId.set(rule.supply_id, rule);
  }

  return [...ruleBySupplyId.values()];
}

function eventKey(input: {
  stage: "prepack" | "packing";
  pgNo: string;
  supplyId: number;
  auditSessionId?: number;
  allocationId?: number;
}) {
  return input.stage === "prepack"
    ? `supply:prepack:audit:${input.auditSessionId}:pg:${input.pgNo}:supply:${input.supplyId}`
    : `supply:packing:allocation:${input.allocationId}:pg:${input.pgNo}:supply:${input.supplyId}`;
}

async function createConsumption(
  tx: TransactionClient,
  input: {
    rule: MatchedRule;
    pgNo: string;
    quantity: number;
    stage: "prepack" | "packing";
    auditSessionId?: number;
    allocationId?: number;
    effectivePeriodFrom?: string | null;
    effectivePeriodTo?: string | null;
    occurredAt: Date | string;
    actorUserId: number;
  }
) {
  const idempotencyKey = eventKey({
    stage: input.stage,
    pgNo: input.pgNo,
    supplyId: input.rule.supply_id,
    auditSessionId: input.auditSessionId,
    allocationId: input.allocationId,
  });
  const existing = await tx.supply_consumption_events.findUnique({
    where: { idempotency_key: idempotencyKey },
  });

  if (existing) {
    return { applied: false, event: existing };
  }

  const sourceType =
    input.stage === "prepack" ? PREPACK_SOURCE_TYPE : PACKING_SOURCE_TYPE;
  const sourceId = String(input.auditSessionId ?? input.allocationId);
  const { movement } = await recordSupplyMovementInTransaction(
    tx,
    {
      supplyId: input.rule.supply_id,
      movementType: SUPPLY_MOVEMENT_TYPE.consumed,
      quantity: input.quantity,
      reason:
        input.stage === "prepack"
          ? "\uC7AC\uACE0\uC2E4\uC0AC \uC120\uD3EC\uC7A5 \uBE44\uD488 \uC18C\uBAA8"
          : "\uD3EC\uC7A5 \uAC80\uC99D \uC644\uB8CC \uBE44\uD488 \uC18C\uBAA8",
      sourceType,
      sourceId,
      pgNo: input.pgNo,
      allocationId: input.allocationId,
      idempotencyKey: `${idempotencyKey}:movement`,
    },
    { userId: input.actorUserId }
  );
  const event = await tx.supply_consumption_events.create({
    data: {
      supply_id: input.rule.supply_id,
      rule_id: input.rule.rule_id,
      trigger_type: input.rule.trigger_type,
      source_type: sourceType,
      source_id: sourceId,
      inventory_audit_session_id: input.auditSessionId ?? null,
      pg_no: input.pgNo,
      quantity: input.quantity,
      applied_rule_revision: input.rule.revision,
      effective_period_from: input.effectivePeriodFrom ?? null,
      effective_period_to: input.effectivePeriodTo ?? null,
      consumed_at: input.occurredAt,
      created_by_user_id: input.actorUserId,
      allocation_id: input.allocationId ?? null,
      stock_movement_id: movement.movement_id,
      idempotency_key: idempotencyKey,
      consumption_stage:
        input.stage === "prepack"
          ? SUPPLY_CONSUMPTION_STAGE.prepack
          : SUPPLY_CONSUMPTION_STAGE.packingConfirmed,
      claimed_at: input.allocationId ? input.occurredAt : null,
    },
  });

  return { applied: true, event };
}

export async function consumePrepackSupplies(
  tx: TransactionClient,
  input: {
    pgNos: string[];
    inventoryAuditSessionId: number;
    auditPeriodFrom: string;
    auditPeriodTo: string;
    occurredAt: string;
    actorUserId: number;
  }
) {
  let consumedCount = 0;
  let skippedCount = 0;

  for (const pgNo of [...new Set(input.pgNos)]) {
    const rules = (await loadMatchedOutboundRules(tx, { pgNo })).filter(
      (rule) =>
        rule.supplies.outbound_consumption_policy ===
        OUTBOUND_SUPPLY_CONSUMPTION_POLICY.prepackAllowed
    );

    for (const rule of rules) {
      const result = await createConsumption(tx, {
        rule,
        pgNo,
        quantity: rule.quantity_per_unit,
        stage: "prepack",
        auditSessionId: input.inventoryAuditSessionId,
        effectivePeriodFrom: input.auditPeriodFrom,
        effectivePeriodTo: input.auditPeriodTo,
        occurredAt: input.occurredAt,
        actorUserId: input.actorUserId,
      });

      if (result.applied) consumedCount += 1;
      else skippedCount += 1;
    }
  }

  return {
    eventCount: consumedCount,
    movementCount: consumedCount,
    skippedCount,
  };
}

export async function consumePackingConfirmedSupplies(
  tx: TransactionClient,
  input: {
    allocationId: number;
    pgNo: string;
    occurredAt: string;
    actorUserId: number;
  }
) {
  const rules = await loadMatchedOutboundRules(tx, {
    pgNo: input.pgNo,
    allocationId: input.allocationId,
  });
  const inventory = await tx.inventory.findUnique({
    where: { pg_no: input.pgNo },
    select: { location: true },
  });
  const existingAllocationEvents = await tx.supply_consumption_events.findMany({
    where: { allocation_id: input.allocationId },
    orderBy: { supply_consumption_event_id: "asc" },
  });
  const allocationEventBySupplyId = new Map<
    number,
    (typeof existingAllocationEvents)[number]
  >();

  for (const event of existingAllocationEvents) {
    if (allocationEventBySupplyId.has(event.supply_id)) {
      throw new Error(
        "\uD558\uB098\uC758 \uCD9C\uACE0 allocation\uC5D0 \uB3D9\uC77C \uBE44\uD488 \uCC28\uAC10 \uC774\uB825\uC774 \uC911\uBCF5\uB429\uB2C8\uB2E4."
      );
    }
    allocationEventBySupplyId.set(event.supply_id, event);
  }
  if (existingAllocationEvents.length > 0) {
    return { claimedCount: 0, consumedCount: 0 };
  }
  const latestPrepackEvent =
    inventory?.location === PREPACK_COMPLETED_LOCATION
      ? await tx.supply_consumption_events.findFirst({
          where: {
            pg_no: input.pgNo,
            consumption_stage: SUPPLY_CONSUMPTION_STAGE.prepack,
            allocation_id: null,
            inventory_audit_session_id: { not: null },
          },
          orderBy: [
            { inventory_audit_session_id: "desc" },
            { supply_consumption_event_id: "desc" },
          ],
          select: { inventory_audit_session_id: true },
        })
      : null;
  const prepackEvents = latestPrepackEvent?.inventory_audit_session_id
    ? await tx.supply_consumption_events.findMany({
        where: {
          pg_no: input.pgNo,
          consumption_stage: SUPPLY_CONSUMPTION_STAGE.prepack,
          allocation_id: null,
          inventory_audit_session_id:
            latestPrepackEvent.inventory_audit_session_id,
        },
        orderBy: { supply_consumption_event_id: "asc" },
      })
    : [];
  const prepackBySupplyId = new Map<number, (typeof prepackEvents)[number]>();

  for (const event of prepackEvents) {
    if (prepackBySupplyId.has(event.supply_id)) {
      throw new Error("\uC120\uD3EC\uC7A5 \uBE44\uD488 \uC774\uB825\uC774 \uD488\uBAA9\uBCC4\uB85C \uC911\uBCF5\uB418\uC5B4 \uD3EC\uC7A5 \uAC80\uC99D\uC744 \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.");
    }
    prepackBySupplyId.set(event.supply_id, event);
  }

  if (prepackEvents.length > 0) {
    const prepackRuleIds = new Set(prepackEvents.map((event) => event.rule_id));
    const newPrepackRule = rules.find(
      (rule) =>
        rule.supplies.outbound_consumption_policy ===
          OUTBOUND_SUPPLY_CONSUMPTION_POLICY.prepackAllowed &&
        !prepackRuleIds.has(rule.rule_id)
    );

    if (newPrepackRule) {
      throw publicConflict(
        "SUPPLY_PREPACK_RULE_SET_CHANGED",
        "SUPPLY_PREPACK_RULE_SET_CHANGED"
      );
    }
  }

  let claimedCount = 0;
  let consumedCount = 0;

  if (prepackEvents.length > 0) {
    const claimed = await tx.supply_consumption_events.updateMany({
      where: {
        supply_consumption_event_id: {
          in: prepackEvents.map((event) => event.supply_consumption_event_id),
        },
        allocation_id: null,
        claimed_at: null,
      },
      data: {
        allocation_id: input.allocationId,
        claimed_at: input.occurredAt,
      },
    });

    if (claimed.count !== prepackEvents.length) {
      throw publicConflict(
        "SUPPLY_PREPACK_BUNDLE_ALREADY_CLAIMED",
        "SUPPLY_PREPACK_BUNDLE_ALREADY_CLAIMED"
      );
    }
    claimedCount = claimed.count;
  }

  for (const rule of rules) {
    if (allocationEventBySupplyId.has(rule.supply_id)) {
      continue;
    }

    const prepackEvent = prepackBySupplyId.get(rule.supply_id);

    if (prepackEvent) {
      continue;
    }

    const result = await createConsumption(tx, {
      rule,
      pgNo: input.pgNo,
      quantity: rule.quantity_per_unit,
      stage: "packing",
      allocationId: input.allocationId,
      occurredAt: input.occurredAt,
      actorUserId: input.actorUserId,
    });
    if (result.applied) consumedCount += 1;
  }

  return { claimedCount, consumedCount };
}

async function restorableEvents(tx: TransactionClient, allocationId: number) {
  return tx.supply_consumption_events.findMany({
    where: { allocation_id: allocationId },
    include: {
      supplies: true,
      reversal_movements: {
        where: { movement_type: SUPPLY_MOVEMENT_TYPE.returned },
        select: { movement_id: true },
      },
    },
    orderBy: { supply_consumption_event_id: "asc" },
  });
}

export async function listReturnSupplyCandidates(
  tx: TransactionClient,
  allocationId: number
) {
  const events = await restorableEvents(tx, allocationId);

  return events.map((event) => ({
    consumptionEventId: event.supply_consumption_event_id,
    supplyCode: event.supplies.supply_code,
    supplyName: event.supplies.supply_name,
    quantity: event.quantity,
    reusable:
      event.supplies.supply_code !== NON_REUSABLE_AFTER_PACKING_SUPPLY_CODE,
    recovered: event.reversal_movements.length > 0,
  }));
}

export async function restoreReturnSupplies(
  tx: TransactionClient,
  input: {
    allocationId: number;
    coupangReturnAllocationId: number;
    selectedConsumptionEventIds?: number[] | null;
    restoreAllReusable: boolean;
    occurredAt: Date | string;
    actorUserId: number | null;
  }
) {
  await tx.$queryRaw`
    SELECT supply_consumption_event_id
    FROM supply_consumption_events
    WHERE allocation_id = ${input.allocationId}
    ORDER BY supply_consumption_event_id
    FOR UPDATE
  `;
  const events = await restorableEvents(tx, input.allocationId);
  const eventById = new Map(
    events.map((event) => [event.supply_consumption_event_id, event])
  );
  const selectedIds = new Set(input.selectedConsumptionEventIds ?? []);

  if (!input.restoreAllReusable) {
    for (const eventId of selectedIds) {
      const event = eventById.get(eventId);
      if (!event || event.allocation_id !== input.allocationId) {
        throw new Error("\uD68C\uC218 \uBE44\uD488 \uC120\uD0DD\uC774 \uD574\uB2F9 PG\uC758 \uCD9C\uACE0 \uCC28\uAC10 \uC774\uB825\uACFC \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      }
      if (
        event.supplies.supply_code ===
        NON_REUSABLE_AFTER_PACKING_SUPPLY_CODE
      ) {
        throw new Error("A-8\uBC15\uC2A4\uB294 \uD3EC\uC7A5 \uAC80\uC99D \uD6C4 \uC7AC\uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      }
    }
  }

  let restoredCount = 0;

  for (const event of events) {
    if (
      event.supplies.supply_code === NON_REUSABLE_AFTER_PACKING_SUPPLY_CODE ||
      event.reversal_movements.length > 0 ||
      (!input.restoreAllReusable &&
        !selectedIds.has(event.supply_consumption_event_id))
    ) {
      continue;
    }

    await recordSupplyMovementInTransaction(
      tx,
      {
        supplyId: event.supply_id,
        movementType: SUPPLY_MOVEMENT_TYPE.returned,
        quantity: event.quantity,
        reason: "\uBC18\uD488 \uAC80\uC218 \uD68C\uC218 \uBE44\uD488 \uBCF5\uAD6C",
        sourceType: RETURN_SOURCE_TYPE,
        sourceId: String(input.coupangReturnAllocationId),
        pgNo: event.pg_no,
        allocationId: input.allocationId,
        coupangReturnAllocationId: input.coupangReturnAllocationId,
        reversalOfConsumptionEventId:
          event.supply_consumption_event_id,
        idempotencyKey: `supply:return:${input.coupangReturnAllocationId}:event:${event.supply_consumption_event_id}`,
      },
      { userId: input.actorUserId }
    );
    restoredCount += 1;
  }

  return { restoredCount };
}

export function normalizeSelectedSupplyEventIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  const result = new Set<number>();
  for (const item of value) {
    const id = Number(item);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("\uD68C\uC218 \uBE44\uD488 \uC774\uB825 ID\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    }
    result.add(id);
  }
  return [...result];
}

export function isPrepackCompletedLocation(value: string | null | undefined) {
  return normalizedText(value) === PREPACK_COMPLETED_LOCATION;
}
