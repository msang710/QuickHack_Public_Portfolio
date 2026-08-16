import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";

const FIELD_PATH_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/;
const MAX_FIELD_VALUE_LENGTH = 2_000;

export type DomainAuditScalar = string | number | boolean | Date | null;

export type DomainAuditEventContract<TFieldPath extends string> = Readonly<{
  eventType: string;
  allowedFieldPaths: ReadonlySet<TFieldPath>;
}>;

export class DomainAuditContractError extends Error {
  readonly code = "DOMAIN_AUDIT_CONTRACT_INVALID";

  constructor(detail: string) {
    super(`Domain audit contract is invalid: ${detail}.`);
    this.name = "DomainAuditContractError";
  }
}

function requiredText(value: string, label: string, maxLength = 160) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new DomainAuditContractError(label);
  }
  return normalized;
}

function scalarText(value: DomainAuditScalar, fieldPath: string) {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new DomainAuditContractError(`${fieldPath} contains an invalid date`);
    }
    return value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new DomainAuditContractError(
        `${fieldPath} must contain a finite safe integer`
      );
    }
  }
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new DomainAuditContractError(`${fieldPath} must contain a scalar`);
  }
  const text = String(value);
  if (text.length > MAX_FIELD_VALUE_LENGTH) {
    throw new DomainAuditContractError(`${fieldPath} exceeds the value limit`);
  }
  return text;
}

export function defineDomainAuditEvent<const TFieldPath extends string>(input: {
  eventType: string;
  allowedFieldPaths: readonly TFieldPath[];
}): DomainAuditEventContract<TFieldPath> {
  const eventType = requiredText(input.eventType, "eventType");
  const paths = input.allowedFieldPaths.map((value) => value.trim() as TFieldPath);
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new DomainAuditContractError(
      "allowedFieldPaths must contain unique explicit paths"
    );
  }
  for (const path of paths) {
    if (!FIELD_PATH_PATTERN.test(path)) {
      throw new DomainAuditContractError(`invalid field path ${path}`);
    }
  }
  return Object.freeze({
    eventType,
    allowedFieldPaths: new Set(paths),
  });
}

export type DomainAuditChange<TFieldPath extends string> = {
  fieldPath: TFieldPath;
  before: DomainAuditScalar;
  after: DomainAuditScalar;
};

export async function appendDomainAuditEvent<TFieldPath extends string>(
  tx: Prisma.TransactionClient,
  input: {
    contract: DomainAuditEventContract<TFieldPath>;
    actorUserId?: number | null;
    action: string;
    aggregateType: string;
    aggregateId: string | number;
    operationKey?: string | null;
    occurredAt?: Date;
    changes: readonly DomainAuditChange<TFieldPath>[];
  }
) {
  const action = requiredText(input.action, "action");
  const aggregateType = requiredText(input.aggregateType, "aggregateType");
  const aggregateId = requiredText(String(input.aggregateId), "aggregateId", 300);
  const operationKey = input.operationKey?.trim() || null;
  if (operationKey && operationKey.length > 300) {
    throw new DomainAuditContractError("operationKey");
  }
  const occurredAt = input.occurredAt ?? databaseNow();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new DomainAuditContractError("occurredAt");
  }
  const seen = new Set<string>();
  const changes = input.changes.map((change) => {
    const fieldPath = change.fieldPath.trim();
    if (
      !input.contract.allowedFieldPaths.has(change.fieldPath) ||
      !FIELD_PATH_PATTERN.test(fieldPath)
    ) {
      throw new DomainAuditContractError(`field ${fieldPath} is not allowlisted`);
    }
    if (seen.has(fieldPath)) {
      throw new DomainAuditContractError(`field ${fieldPath} is duplicated`);
    }
    seen.add(fieldPath);
    return {
      domain_audit_event_change_id: randomUUID(),
      field_path: fieldPath,
      before_value: scalarText(change.before, fieldPath),
      after_value: scalarText(change.after, fieldPath),
      created_at: occurredAt,
    };
  });

  return tx.domain_audit_events.create({
    data: {
      domain_audit_event_id: randomUUID(),
      actor_user_id: input.actorUserId ?? null,
      action,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      operation_key: operationKey,
      event_type: input.contract.eventType,
      occurred_at: occurredAt,
      created_at: occurredAt,
      changes: changes.length > 0 ? { create: changes } : undefined,
    },
    include: { changes: { orderBy: { field_path: "asc" } } },
  });
}

export async function appendDomainAuditEvents<TFieldPath extends string>(
  tx: Prisma.TransactionClient,
  inputs: readonly Parameters<typeof appendDomainAuditEvent<TFieldPath>>[1][]
) {
  const events = [];
  for (const input of inputs) {
    events.push(await appendDomainAuditEvent(tx, input));
  }
  return events;
}
