// QuickHack service: append-only Coupang return, cancellation, exchange and
// withdrawal history stored in the existing raw change event ledger.
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import {
  COUPANG_CLAIM_EVENT_TYPE,
  COUPANG_CLAIM_SOURCE_TABLE,
  COUPANG_EXCHANGE_HISTORY_FIELDS,
  COUPANG_RETURN_HISTORY_FIELDS,
  COUPANG_RETURN_WITHDRAWAL_FIELDS,
  type CoupangClaimHistoryField,
  type CoupangExchangeHistorySnapshot,
  type CoupangReturnHistorySnapshot,
  type CoupangReturnWithdrawalSnapshot,
} from "@/quickhack_shared/sales-channel/coupang/claim-history";

type HistoryFieldNames =
  | typeof COUPANG_RETURN_HISTORY_FIELDS
  | typeof COUPANG_EXCHANGE_HISTORY_FIELDS
  | typeof COUPANG_RETURN_WITHDRAWAL_FIELDS;
type HistorySnapshot = Partial<
  Record<CoupangClaimHistoryField, string | null>
>;

type ObservationEventInput = {
  tx: Prisma.TransactionClient;
  sourceTable: string;
  sourcePk: string;
  observedEventType: string;
  changedEventType: string;
  fieldNames:
    | typeof COUPANG_RETURN_HISTORY_FIELDS
    | typeof COUPANG_EXCHANGE_HISTORY_FIELDS;
  snapshot: HistorySnapshot;
  externalOrderId?: string | null;
  externalShipmentId?: string | null;
  externalReceiptId?: string | null;
  externalExchangeId?: string | null;
  observedAt: DateTimeInput;
  apiCallLogId?: number | null;
  workerJobId?: number | null;
};

type FixedEventInput = {
  tx: Prisma.TransactionClient;
  sourceTable: string;
  sourcePk: string;
  eventType: string;
  fieldNames: typeof COUPANG_RETURN_WITHDRAWAL_FIELDS;
  snapshot: HistorySnapshot;
  externalOrderId?: string | null;
  externalShipmentId?: string | null;
  externalReceiptId?: string | null;
  externalExchangeId?: string | null;
  observedAt: DateTimeInput;
  apiCallLogId?: number | null;
  workerJobId?: number | null;
};

export type CoupangClaimHistoryRecordResult = {
  eventCreated: boolean;
  eventType: string | null;
  noOp: boolean;
  unmatched: boolean;
};

function stableSnapshotEntries(
  fieldNames: HistoryFieldNames,
  snapshot: HistorySnapshot
) {
  return fieldNames.map((fieldName) => [
    fieldName,
    snapshot[fieldName] ?? null,
  ]);
}

function claimHistoryHash(input: {
  sourceTable: string;
  sourcePk: string;
  eventType: string;
  fieldNames: HistoryFieldNames;
  snapshot: HistorySnapshot;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceTable: input.sourceTable,
        sourcePk: input.sourcePk,
        eventType: input.eventType,
        snapshot: stableSnapshotEntries(input.fieldNames, input.snapshot),
      })
    )
    .digest("hex");
}

function snapshotFromEventFields(
  fieldNames: HistoryFieldNames,
  fields: Array<{ field_name: string; after_value: string | null }>
) {
  const values = new Map(
    fields.map((field) => [field.field_name, field.after_value])
  );

  return Object.fromEntries(
    fieldNames.map((fieldName) => [fieldName, values.get(fieldName) ?? null])
  ) as HistorySnapshot;
}

function snapshotsEqual(
  fieldNames: HistoryFieldNames,
  left: HistorySnapshot,
  right: HistorySnapshot
) {
  return fieldNames.every(
    (fieldName) => (left[fieldName] ?? null) === (right[fieldName] ?? null)
  );
}

async function insertEventIfAbsent(
  input: FixedEventInput & { changeHash: string }
) {
  const observedAt = databaseDateTime(input.observedAt);
  const inserted = await input.tx.$queryRaw<Array<{ event_id: number | bigint }>>(
    Prisma.sql`
      INSERT INTO coupang_raw_change_event (
        source_table,
        source_pk,
        external_order_id,
        external_shipment_id,
        external_receipt_id,
        external_exchange_id,
        event_type,
        change_hash,
        api_call_log_id,
        process_status,
        worker_attempt_count,
        detected_at,
        processed_at,
        worker_job_id,
        created_at,
        updated_at
      )
      VALUES (
        ${input.sourceTable},
        ${input.sourcePk},
        ${input.externalOrderId ?? null},
        ${input.externalShipmentId ?? null},
        ${input.externalReceiptId ?? null},
        ${input.externalExchangeId ?? null},
        ${input.eventType},
        ${input.changeHash},
        ${input.apiCallLogId ?? null},
        'DONE',
        0,
        ${observedAt},
        ${observedAt},
        ${input.workerJobId ?? null},
        ${observedAt},
        ${observedAt}
      )
      ON CONFLICT (source_table, source_pk, event_type, change_hash)
      DO NOTHING
      RETURNING coupang_raw_change_event_id AS event_id
    `
  );
  const eventId = inserted[0]?.event_id;

  if (eventId === undefined) {
    return null;
  }

  const rawChangeEventId = Number(eventId);

  await input.tx.coupang_raw_change_event_field.createMany({
    data: input.fieldNames.map((fieldName) => ({
        raw_change_event_id: rawChangeEventId,
        field_name: fieldName,
        before_value: null,
        after_value: input.snapshot[fieldName] ?? null,
        created_at: observedAt,
    })),
  });

  return rawChangeEventId;
}

async function recordObservation(input: ObservationEventInput) {
  const observedAt = databaseDateTime(input.observedAt);
  const latest = await input.tx.coupang_raw_change_event.findFirst({
    where: {
      source_table: input.sourceTable,
      source_pk: input.sourcePk,
      event_type: {
        in: [input.observedEventType, input.changedEventType],
      },
    },
    orderBy: {
      coupang_raw_change_event_id: "desc",
    },
    include: {
      fields: {
        select: {
          field_name: true,
          after_value: true,
        },
      },
    },
  });
  const previousSnapshot = latest
    ? snapshotFromEventFields(input.fieldNames, latest.fields)
    : null;

  if (
    previousSnapshot &&
    snapshotsEqual(input.fieldNames, previousSnapshot, input.snapshot)
  ) {
    return {
      eventCreated: false,
      eventType: null,
      noOp: true,
      unmatched: false,
    } satisfies CoupangClaimHistoryRecordResult;
  }

  const eventType = latest
    ? input.changedEventType
    : input.observedEventType;
  const changeHash = claimHistoryHash({
    sourceTable: input.sourceTable,
    sourcePk: input.sourcePk,
    eventType,
    fieldNames: input.fieldNames,
    snapshot: input.snapshot,
  });
  const inserted = await input.tx.$queryRaw<
    Array<{ event_id: number | bigint }>
  >(
    Prisma.sql`
      INSERT INTO coupang_raw_change_event (
        source_table,
        source_pk,
        external_order_id,
        external_shipment_id,
        external_receipt_id,
        external_exchange_id,
        event_type,
        change_hash,
        api_call_log_id,
        process_status,
        worker_attempt_count,
        detected_at,
        processed_at,
        worker_job_id,
        created_at,
        updated_at
      )
      VALUES (
        ${input.sourceTable},
        ${input.sourcePk},
        ${input.externalOrderId ?? null},
        ${input.externalShipmentId ?? null},
        ${input.externalReceiptId ?? null},
        ${input.externalExchangeId ?? null},
        ${eventType},
        ${changeHash},
        ${input.apiCallLogId ?? null},
        'DONE',
        0,
        ${observedAt},
        ${observedAt},
        ${input.workerJobId ?? null},
        ${observedAt},
        ${observedAt}
      )
      ON CONFLICT (source_table, source_pk, event_type, change_hash)
      DO NOTHING
      RETURNING coupang_raw_change_event_id AS event_id
    `
  );
  const eventId = inserted[0]?.event_id;

  if (eventId === undefined) {
    return {
      eventCreated: false,
      eventType: null,
      noOp: true,
      unmatched: false,
    } satisfies CoupangClaimHistoryRecordResult;
  }

  const rawChangeEventId = Number(eventId);

  await input.tx.coupang_raw_change_event_field.createMany({
    data: input.fieldNames.map((fieldName) => ({
        raw_change_event_id: rawChangeEventId,
        field_name: fieldName,
        before_value: previousSnapshot?.[fieldName] ?? null,
        after_value: input.snapshot[fieldName] ?? null,
        created_at: observedAt,
    })),
  });

  return {
    eventCreated: true,
    eventType,
    noOp: false,
    unmatched: false,
  } satisfies CoupangClaimHistoryRecordResult;
}

export function recordReturnObservation(input: {
  tx: Prisma.TransactionClient;
  externalReceiptId: string;
  externalOrderId?: string | null;
  externalShipmentId?: string | null;
  snapshot: CoupangReturnHistorySnapshot;
  observedAt: DateTimeInput;
  apiCallLogId?: number | null;
  workerJobId?: number | null;
}) {
  return recordObservation({
    ...input,
    sourceTable: COUPANG_CLAIM_SOURCE_TABLE.returns,
    sourcePk: input.externalReceiptId,
    externalReceiptId: input.externalReceiptId,
    observedEventType: COUPANG_CLAIM_EVENT_TYPE.returnObserved,
    changedEventType: COUPANG_CLAIM_EVENT_TYPE.returnChanged,
    fieldNames: COUPANG_RETURN_HISTORY_FIELDS,
  });
}

export function recordExchangeObservation(input: {
  tx: Prisma.TransactionClient;
  externalExchangeId: string;
  externalOrderId?: string | null;
  externalShipmentId?: string | null;
  snapshot: CoupangExchangeHistorySnapshot;
  observedAt: DateTimeInput;
  apiCallLogId?: number | null;
  workerJobId?: number | null;
}) {
  return recordObservation({
    ...input,
    sourceTable: COUPANG_CLAIM_SOURCE_TABLE.exchanges,
    sourcePk: input.externalExchangeId,
    externalExchangeId: input.externalExchangeId,
    observedEventType: COUPANG_CLAIM_EVENT_TYPE.exchangeObserved,
    changedEventType: COUPANG_CLAIM_EVENT_TYPE.exchangeChanged,
    fieldNames: COUPANG_EXCHANGE_HISTORY_FIELDS,
  });
}

export async function recordReturnWithdrawal(input: {
  tx: Prisma.TransactionClient;
  externalReceiptId: string;
  externalOrderId?: string | null;
  snapshot: CoupangReturnWithdrawalSnapshot;
  observedAt: DateTimeInput;
  apiCallLogId?: number | null;
  workerJobId?: number | null;
}) {
  const matchedObservation = await input.tx.coupang_raw_change_event.findFirst({
    where: {
      source_table: COUPANG_CLAIM_SOURCE_TABLE.returns,
      source_pk: input.externalReceiptId,
      event_type: COUPANG_CLAIM_EVENT_TYPE.returnObserved,
    },
    select: {
      coupang_raw_change_event_id: true,
    },
  });
  const fixedInput: FixedEventInput = {
    ...input,
    sourceTable: COUPANG_CLAIM_SOURCE_TABLE.returns,
    sourcePk: input.externalReceiptId,
    externalReceiptId: input.externalReceiptId,
    eventType: COUPANG_CLAIM_EVENT_TYPE.returnWithdrawn,
    fieldNames: COUPANG_RETURN_WITHDRAWAL_FIELDS,
  };
  const eventId = await insertEventIfAbsent({
    ...fixedInput,
    changeHash: claimHistoryHash({
      sourceTable: fixedInput.sourceTable,
      sourcePk: fixedInput.sourcePk,
      eventType: fixedInput.eventType,
      fieldNames: fixedInput.fieldNames,
      snapshot: fixedInput.snapshot,
    }),
  });

  return {
    eventCreated: eventId !== null,
    eventType:
      eventId !== null ? COUPANG_CLAIM_EVENT_TYPE.returnWithdrawn : null,
    noOp: eventId === null,
    unmatched: matchedObservation === null,
  } satisfies CoupangClaimHistoryRecordResult;
}
