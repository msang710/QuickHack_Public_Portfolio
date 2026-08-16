import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { AtomicInsertObservationError } from "@/quickhack_server/core/database/aggregate-command";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  applyObservedCarrierInvoiceStatus,
  applyObservedCarrierShipmentStatus,
} from "@/quickhack_server/shipment/carrier-integration/carrier-shipment-state-service";
import type { CarrierApiResult } from "@/quickhack_server/shipment/carrier-integration/types";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import {
  databaseDateTimeOrNull,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import {
  CARRIER_INVOICE_STATUS,
  type CarrierInvoiceStatus,
} from "@/quickhack_shared/shipment/carrier-invoice-status";
import {
  CARRIER_SHIPMENT_STATUS,
  type CarrierShipmentStatus,
} from "@/quickhack_shared/shipment/carrier-tracking-status";

type CarrierShipmentClient = Pick<
  Prisma.TransactionClient,
  "carrier_reconciliation_works"
>;

function text(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstResultItem(payload: Record<string, unknown>) {
  const data = payload.data;
  if (Array.isArray(data)) return record(data[0]);
  return record(data);
}

function processedStatus(payload: Record<string, unknown>) {
  const status = text(payload.sttsCd);
  if (status === "SUCCESS") return "SUCCEEDED";
  if (status === "PARTIAL SUCCESS") return "PARTIAL_FAILED";
  if (status === "FAIL") return "FAILED";
  return "RECEIVED";
}

export type CarrierShipmentPersistenceInput = {
  carrierCode: string;
  sourceType: "SELF_PRINT" | "CARRIER_POPUP" | "MANUAL";
  trackingNumber: string;
  previousTrackingNumber?: string | null;
  channel?: string | null;
  externalOrderId?: string | null;
  externalShipmentId?: string | null;
  allocationId?: number | null;
  pgNo?: string | null;
  packageGroupId?: number | null;
  invoiceStatus?: CarrierInvoiceStatus;
  shipmentStatus?: CarrierShipmentStatus;
  revisionNo?: number;
  replacesCarrierShipmentId?: number | null;
  allocatedAt?: DateTimeInput;
  carrierRegisteredAt?: DateTimeInput;
  lastTrackedAt?: DateTimeInput;
};

export class CarrierTrackingNumberConflictError extends Error {
  readonly code = "CARRIER_TRACKING_NUMBER_CONFLICT";
  readonly carrierShipmentId: number;
  readonly existingPackageGroupId: number | null;
  readonly requestedPackageGroupId: number | null;

  constructor(
    carrierShipmentId: number,
    existingPackageGroupId: number | null,
    requestedPackageGroupId: number | null
  ) {
    super("The carrier tracking number is already assigned to another package group.");
    this.name = "CarrierTrackingNumberConflictError";
    this.carrierShipmentId = carrierShipmentId;
    this.existingPackageGroupId = existingPackageGroupId;
    this.requestedPackageGroupId = requestedPackageGroupId;
  }
}

export class CarrierShipmentRevisionConflictError extends Error {
  readonly code = "CARRIER_SHIPMENT_REVISION_CONFLICT";
  readonly carrierShipmentId: number;
  readonly packageGroupId: number;
  readonly revisionNo: number;

  constructor(
    carrierShipmentId: number,
    packageGroupId: number,
    revisionNo: number
  ) {
    super("The carrier shipment revision is already assigned.");
    this.name = "CarrierShipmentRevisionConflictError";
    this.carrierShipmentId = carrierShipmentId;
    this.packageGroupId = packageGroupId;
    this.revisionNo = revisionNo;
  }
}

async function persistCarrierShipment(
  input: CarrierShipmentPersistenceInput,
  client: Prisma.TransactionClient
) {
  const now = databaseNow();
  const key = {
    carrier_code: input.carrierCode,
    tracking_number: input.trackingNumber,
  };
  let existing = await client.carrier_shipments.findUnique({
    where: { carrier_code_tracking_number: key },
  });

  if (
    existing &&
    input.packageGroupId != null &&
    existing.package_group_id !== input.packageGroupId
  ) {
    throw new CarrierTrackingNumberConflictError(
      existing.carrier_shipment_id,
      existing.package_group_id,
      input.packageGroupId
    );
  }

  const carrierRegisteredAt =
    input.carrierRegisteredAt === undefined
      ? input.invoiceStatus === "ALLOCATED"
        ? null
        : now
      : databaseDateTimeOrNull(input.carrierRegisteredAt);
  const allocatedAt = databaseDateTimeOrNull(input.allocatedAt);
  const lastTrackedAt = databaseDateTimeOrNull(input.lastTrackedAt);

  if (!existing) {
    const revisionNo = input.revisionNo ?? 1;
    const inserted = await client.$queryRaw<Array<{ carrier_shipment_id: number }>>`
      INSERT INTO carrier_shipments (
        carrier_code,
        source_type,
        channel,
        external_order_id,
        external_shipment_id,
        allocation_id,
        pg_no,
        package_group_id,
        tracking_number,
        previous_tracking_number,
        revision_no,
        replaces_carrier_shipment_id,
        invoice_status,
        shipment_status,
        allocated_at,
        carrier_registered_at,
        last_tracked_at,
        created_at,
        updated_at
      ) VALUES (
        ${input.carrierCode},
        ${input.sourceType},
        ${input.channel ?? null},
        ${input.externalOrderId ?? null},
        ${input.externalShipmentId ?? null},
        ${input.allocationId ?? null},
        ${input.pgNo ?? null},
        ${input.packageGroupId ?? null},
        ${input.trackingNumber},
        ${input.previousTrackingNumber ?? null},
        ${revisionNo},
        ${input.replacesCarrierShipmentId ?? null},
        ${input.invoiceStatus ?? CARRIER_INVOICE_STATUS.registered},
        ${input.shipmentStatus ?? CARRIER_SHIPMENT_STATUS.registered},
        ${allocatedAt},
        ${carrierRegisteredAt},
        ${lastTrackedAt},
        ${now},
        ${now}
      )
      ON CONFLICT DO NOTHING
      RETURNING carrier_shipment_id
    `;

    if (inserted.length === 1) {
      return client.carrier_shipments.findUniqueOrThrow({
        where: { carrier_shipment_id: inserted[0].carrier_shipment_id },
      });
    }

    const [trackingConflict, revisionConflict] = await Promise.all([
      client.carrier_shipments.findUnique({
        where: { carrier_code_tracking_number: key },
      }),
      input.packageGroupId == null
        ? Promise.resolve(null)
        : client.carrier_shipments.findFirst({
            where: {
              package_group_id: input.packageGroupId,
              revision_no: revisionNo,
            },
          }),
    ]);

    if (
      trackingConflict &&
      input.packageGroupId != null &&
      trackingConflict.package_group_id !== input.packageGroupId
    ) {
      throw new CarrierTrackingNumberConflictError(
        trackingConflict.carrier_shipment_id,
        trackingConflict.package_group_id,
        input.packageGroupId
      );
    }
    if (
      revisionConflict &&
      (revisionConflict.carrier_code !== input.carrierCode ||
        revisionConflict.tracking_number !== input.trackingNumber)
    ) {
      throw new CarrierShipmentRevisionConflictError(
        revisionConflict.carrier_shipment_id,
        input.packageGroupId as number,
        revisionNo
      );
    }

    existing = trackingConflict ?? revisionConflict;
    if (!existing) {
      throw new AtomicInsertObservationError("carrier_shipments.unique_identity");
    }
  }

  await client.$queryRaw`
    SELECT carrier_shipment_id
    FROM carrier_shipments
    WHERE carrier_shipment_id = ${existing.carrier_shipment_id}
    FOR UPDATE
  `;
  existing = await client.carrier_shipments.findUniqueOrThrow({
    where: { carrier_shipment_id: existing.carrier_shipment_id },
  });

  if (input.revisionNo != null && existing.revision_no !== input.revisionNo) {
    throw new CarrierTrackingNumberConflictError(
      existing.carrier_shipment_id,
      existing.package_group_id,
      input.packageGroupId ?? null
    );
  }

  await client.carrier_shipments.update({
    where: { carrier_shipment_id: existing.carrier_shipment_id },
    data: {
      source_type: input.sourceType,
      channel: input.channel ?? undefined,
      external_order_id: input.externalOrderId ?? undefined,
      external_shipment_id: input.externalShipmentId ?? undefined,
      allocation_id: input.allocationId ?? undefined,
      pg_no: input.pgNo ?? undefined,
      package_group_id: input.packageGroupId ?? undefined,
      previous_tracking_number: input.previousTrackingNumber ?? undefined,
      replaces_carrier_shipment_id:
        input.replacesCarrierShipmentId ?? undefined,
      allocated_at: input.allocatedAt == null ? undefined : allocatedAt,
      last_tracked_at: input.lastTrackedAt == null ? undefined : lastTrackedAt,
      updated_at: now,
    },
  });

  if (input.invoiceStatus) {
    await applyObservedCarrierInvoiceStatus(client, {
      carrierShipmentId: existing.carrier_shipment_id,
      observedStatus: input.invoiceStatus,
      observedAt: now,
      carrierRegisteredAt: input.carrierRegisteredAt,
    });
  }
  if (input.shipmentStatus) {
    await applyObservedCarrierShipmentStatus(client, {
      carrierShipmentId: existing.carrier_shipment_id,
      observedStatus: input.shipmentStatus,
      observedAt: now,
    });
  }

  return client.carrier_shipments.findUniqueOrThrow({
    where: { carrier_shipment_id: existing.carrier_shipment_id },
  });
}

export async function upsertCarrierShipment(
  input: CarrierShipmentPersistenceInput,
  client?: Prisma.TransactionClient
) {
  if (client) return persistCarrierShipment(input, client);
  return runMeasuredTransaction(prisma, "carrier_shipment.upsert", (tx) =>
    persistCarrierShipment(input, tx)
  );
}
export async function recordCarrierApiCall(input: {
  result: CarrierApiResult;
  carrierShipmentId?: number | null;
  externalOrderId?: string | null;
  trackingNumber?: string | null;
  takeNo?: string | null;
  workerJobId?: number | null;
}) {
  const item = firstResultItem(input.result.payload);
  const now = databaseNow();
  return prisma.carrier_api_call_logs.create({
    data: {
      carrier_code: input.result.carrierCode,
      carrier_shipment_id: input.carrierShipmentId ?? null,
      api_name: input.result.apiName,
      endpoint_path: input.result.requestPath,
      method: input.result.method,
      operation_type: input.result.operationType,
      request_hash: input.result.requestHash,
      response_hash: input.result.responseHash,
      http_status_code: input.result.httpStatusCode,
      external_status_code: text(input.result.payload.sttsCd),
      external_status_message: text(input.result.payload.sttsMsg),
      item_result_code: text(item?.resultCd),
      item_result_message: text(item?.resultMsg),
      external_order_id: input.externalOrderId ?? null,
      tracking_number: input.trackingNumber ?? null,
      take_no: input.takeNo ?? null,
      worker_job_id: input.workerJobId ?? null,
      processed_status: processedStatus(input.result.payload),
      finished_at: now,
      created_at: now,
    },
  });
}

export async function recordCarrierApiFailure(input: {
  carrierCode: string;
  apiName: string;
  endpointPath: string;
  method: "GET" | "POST";
  operationType: "READ" | "WRITE";
  error: unknown;
  externalOrderId?: string | null;
  trackingNumber?: string | null;
  takeNo?: string | null;
  carrierShipmentId?: number | null;
  uncertain?: boolean;
  workerJobId?: number | null;
}) {
  const now = databaseNow();
  const error = input.error instanceof Error ? input.error : new Error(String(input.error));
  return prisma.carrier_api_call_logs.create({
    data: {
      carrier_code: input.carrierCode,
      carrier_shipment_id: input.carrierShipmentId ?? null,
      api_name: input.apiName,
      endpoint_path: input.endpointPath,
      method: input.method,
      operation_type: input.operationType,
      external_order_id: input.externalOrderId ?? null,
      tracking_number: input.trackingNumber ?? null,
      take_no: input.takeNo ?? null,
      worker_job_id: input.workerJobId ?? null,
      processed_status: input.uncertain ? "UNCERTAIN" : "FAILED",
      error_code: error.name,
      error_message: error.message.slice(0, 2000),
      finished_at: now,
      created_at: now,
    },
  });
}

export type CarrierTrackingEventInput = {
  scanDate?: string | null;
  scanTime?: string | null;
  statusName: string;
  branchCode?: string | null;
  branchName?: string | null;
  salesOfficeCode?: string | null;
  salesOfficeName?: string | null;
  recipientTypeName?: string | null;
};

function trackingFingerprint(event: CarrierTrackingEventInput) {
  return createHash("sha256")
    .update(
      [
        event.scanDate,
        event.scanTime,
        event.statusName,
        event.branchCode,
        event.branchName,
        event.salesOfficeCode,
      ]
        .map((value) => String(value ?? ""))
        .join("|")
    )
    .digest("hex");
}

export async function appendCarrierTrackingEvents(input: {
  carrierShipmentId: number;
  events: CarrierTrackingEventInput[];
  responseHash?: string | null;
  shipmentStatus?: CarrierShipmentStatus | null;
  observedAt?: DateTimeInput;
  trackedAt?: DateTimeInput;
  client?: Prisma.TransactionClient;
}) {
  const trackedAt = databaseDateTimeOrNull(input.trackedAt) ?? databaseNow();
  const observedAt = databaseDateTimeOrNull(input.observedAt) ?? trackedAt;
  const persist = async (tx: Prisma.TransactionClient) => {
    for (const event of input.events) {
      const fingerprint = trackingFingerprint(event);
      await tx.carrier_tracking_events.upsert({
        where: {
          carrier_shipment_id_event_fingerprint: {
            carrier_shipment_id: input.carrierShipmentId,
            event_fingerprint: fingerprint,
          },
        },
        create: {
          carrier_shipment_id: input.carrierShipmentId,
          event_fingerprint: fingerprint,
          scan_date: event.scanDate ?? null,
          scan_time: event.scanTime ?? null,
          status_name: event.statusName,
          branch_code: event.branchCode ?? null,
          branch_name: event.branchName ?? null,
          sales_office_code: event.salesOfficeCode ?? null,
          sales_office_name: event.salesOfficeName ?? null,
          recipient_type_name: event.recipientTypeName ?? null,
          response_hash: input.responseHash ?? null,
          created_at: trackedAt,
        },
        update: {
          branch_code: event.branchCode ?? undefined,
          branch_name: event.branchName ?? undefined,
          sales_office_code: event.salesOfficeCode ?? undefined,
          sales_office_name: event.salesOfficeName ?? undefined,
          recipient_type_name: event.recipientTypeName ?? undefined,
          response_hash: input.responseHash ?? undefined,
        },
      });
    }
    const stateTransition = input.shipmentStatus
      ? await applyObservedCarrierShipmentStatus(tx, {
          carrierShipmentId: input.carrierShipmentId,
          observedStatus: input.shipmentStatus,
          observedAt,
        })
      : null;
    await tx.carrier_shipments.update({
      where: { carrier_shipment_id: input.carrierShipmentId },
      data: {
        last_tracked_at: trackedAt,
        updated_at: trackedAt,
      },
    });
    return stateTransition;
  };
  return input.client
    ? persist(input.client)
    : prisma.$transaction((tx) => persist(tx));
}

export async function upsertCarrierReturnRequest(input: {
  carrierCode: string;
  takeNo: string;
  carrierShipmentId?: number | null;
  externalOrderId?: string | null;
  customerCode?: string | null;
  originalTrackingNumber?: string | null;
  returnTrackingNumber?: string | null;
  reservationStatus?: string | null;
  delayCode?: string | null;
  processedDate?: string | null;
  requestStatus?: string;
}) {
  const now = databaseNow();
  return prisma.carrier_return_requests.upsert({
    where: {
      carrier_code_take_no: {
        carrier_code: input.carrierCode,
        take_no: input.takeNo,
      },
    },
    create: {
      carrier_code: input.carrierCode,
      take_no: input.takeNo,
      carrier_shipment_id: input.carrierShipmentId ?? null,
      external_order_id: input.externalOrderId ?? null,
      customer_code: input.customerCode ?? null,
      original_tracking_number: input.originalTrackingNumber ?? null,
      return_tracking_number: input.returnTrackingNumber ?? null,
      reservation_status: input.reservationStatus ?? null,
      delay_code: input.delayCode ?? null,
      processed_date: input.processedDate ?? null,
      request_status: input.requestStatus ?? "CONFIRMED",
      created_at: now,
      updated_at: now,
    },
    update: {
      carrier_shipment_id: input.carrierShipmentId ?? undefined,
      external_order_id: input.externalOrderId ?? undefined,
      customer_code: input.customerCode ?? undefined,
      original_tracking_number: input.originalTrackingNumber ?? undefined,
      return_tracking_number: input.returnTrackingNumber ?? undefined,
      reservation_status: input.reservationStatus ?? undefined,
      delay_code: input.delayCode ?? undefined,
      processed_date: input.processedDate ?? undefined,
      request_status: input.requestStatus ?? undefined,
      updated_at: now,
    },
  });
}

type CarrierReconciliationWorkInput = {
  carrierCode: string;
  operationType: string;
  lookupKeyType: string;
  lookupKeyValue: string;
  apiCallLogId?: number | null;
  reason: string;
  lastErrorMessage?: string | null;
  client?: Prisma.TransactionClient;
};

function upsertCarrierReconciliationWork(
  client: CarrierShipmentClient,
  input: CarrierReconciliationWorkInput,
  now: Date
) {
  return client.carrier_reconciliation_works.upsert({
    where: {
      carrier_code_operation_type_lookup_key_type_lookup_key_value: {
        carrier_code: input.carrierCode,
        operation_type: input.operationType,
        lookup_key_type: input.lookupKeyType,
        lookup_key_value: input.lookupKeyValue,
      },
    },
    create: {
      carrier_code: input.carrierCode,
      operation_type: input.operationType,
      lookup_key_type: input.lookupKeyType,
      lookup_key_value: input.lookupKeyValue,
      reconciliation_status: "PENDING",
      api_call_log_id: input.apiCallLogId ?? null,
      attempt_count: 0,
      revision: 1,
      reason: input.reason,
      last_error_message: input.lastErrorMessage ?? null,
      created_at: now,
      updated_at: now,
    },
    update: {
      reconciliation_status: "PENDING",
      api_call_log_id: input.apiCallLogId ?? null,
      reason: input.reason,
      last_error_message: input.lastErrorMessage ?? null,
      resolved_at: null,
      revision: { increment: 1 },
      updated_at: now,
    },
  });
}

export async function openCarrierReconciliationWork(
  input: CarrierReconciliationWorkInput
) {
  return upsertCarrierReconciliationWork(
    input.client ?? prisma,
    input,
    databaseNow()
  );
}

export async function observeCarrierReconciliationRevision(input: {
  carrierCode: string;
  operationType: string;
  lookupKeyType: string;
  lookupKeyValue: string;
  client?: Prisma.TransactionClient;
}) {
  const client = input.client ?? prisma;
  const work = await client.carrier_reconciliation_works.findUnique({
    where: {
      carrier_code_operation_type_lookup_key_type_lookup_key_value: {
        carrier_code: input.carrierCode,
        operation_type: input.operationType,
        lookup_key_type: input.lookupKeyType,
        lookup_key_value: input.lookupKeyValue,
      },
    },
    select: { revision: true, reconciliation_status: true },
  });
  return work && work.reconciliation_status !== "RESOLVED"
    ? work.revision
    : null;
}

export async function throttleCarrierTrackingAndOpenReadReview(input: {
  carrierShipmentId: number;
  trackingNumber: string;
  apiCallLogId?: number | null;
  reason: string;
  error: unknown;
  client?: Prisma.TransactionClient;
}) {
  const now = databaseNow();
  const persist = async (tx: Prisma.TransactionClient) => {
    await tx.carrier_shipments.update({
      where: {
        carrier_shipment_id: input.carrierShipmentId,
      },
      data: {
        last_tracked_at: now,
        updated_at: now,
      },
    });
    return upsertCarrierReconciliationWork(
      tx,
      {
        carrierCode: "LOGEN",
        operationType: "TRACKING_SYNC_READ",
        lookupKeyType: "TRACKING_NUMBER",
        lookupKeyValue: input.trackingNumber,
        apiCallLogId: input.apiCallLogId ?? null,
        reason: input.reason,
        lastErrorMessage:
          input.error instanceof Error
            ? input.error.message
            : String(input.error),
      },
      now
    );
  };
  return input.client ? persist(input.client) : prisma.$transaction(persist);
}

export async function resolveCarrierReconciliationWork(input: {
  carrierCode: string;
  operationType: string;
  lookupKeyType: string;
  lookupKeyValue: string;
  expectedRevision: number | null;
  client?: Prisma.TransactionClient;
}) {
  const now = databaseNow();
  if (input.expectedRevision === null) return { count: 0 };
  const client = input.client ?? prisma;
  return client.carrier_reconciliation_works.updateMany({
    where: {
      carrier_code: input.carrierCode,
      operation_type: input.operationType,
      lookup_key_type: input.lookupKeyType,
      lookup_key_value: input.lookupKeyValue,
      revision: input.expectedRevision,
      reconciliation_status: {
        in: ["PENDING", "CHECKING", "MANUAL_REVIEW", "FAILED"],
      },
    },
    data: {
      reconciliation_status: "RESOLVED",
      resolved_at: now,
      last_error_message: null,
      revision: { increment: 1 },
      updated_at: now,
    },
  });
}
