import type { Prisma } from "@/generated/prisma/client";
import {
  databaseDateTime,
  databaseDateTimeOrNull,
} from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import {
  CARRIER_INVOICE_STATUS,
  type CarrierInvoiceStatus,
} from "@/quickhack_shared/shipment/carrier-invoice-status";
import {
  CARRIER_SHIPMENT_STATUS,
  type CarrierShipmentStatus,
} from "@/quickhack_shared/shipment/carrier-tracking-status";

export type CarrierShipmentStateClient =
  | typeof prisma
  | Prisma.TransactionClient;

export type CarrierShipmentStateOutcome =
  | "APPLIED"
  | "ALREADY_APPLIED"
  | "STALE_IGNORED";

export type CarrierShipmentStateResult<TStatus extends string> = {
  outcome: CarrierShipmentStateOutcome;
  currentStatus: TStatus;
};

const OBSERVED_INVOICE_ALLOWED_FROM: Record<
  CarrierInvoiceStatus,
  readonly CarrierInvoiceStatus[]
> = {
  [CARRIER_INVOICE_STATUS.allocated]: [CARRIER_INVOICE_STATUS.allocated],
  [CARRIER_INVOICE_STATUS.registered]: [
    CARRIER_INVOICE_STATUS.allocated,
    CARRIER_INVOICE_STATUS.registered,
  ],
  [CARRIER_INVOICE_STATUS.replaced]: [
    CARRIER_INVOICE_STATUS.allocated,
    CARRIER_INVOICE_STATUS.registered,
    CARRIER_INVOICE_STATUS.replaced,
  ],
  [CARRIER_INVOICE_STATUS.voidLocal]: [
    CARRIER_INVOICE_STATUS.allocated,
    CARRIER_INVOICE_STATUS.registered,
    CARRIER_INVOICE_STATUS.voidLocal,
  ],
};

const OBSERVED_SHIPMENT_ALLOWED_FROM: Record<
  CarrierShipmentStatus,
  readonly CarrierShipmentStatus[]
> = {
  [CARRIER_SHIPMENT_STATUS.allocated]: [CARRIER_SHIPMENT_STATUS.allocated],
  [CARRIER_SHIPMENT_STATUS.registered]: [
    CARRIER_SHIPMENT_STATUS.allocated,
    CARRIER_SHIPMENT_STATUS.registered,
  ],
  [CARRIER_SHIPMENT_STATUS.inTransit]: [
    CARRIER_SHIPMENT_STATUS.allocated,
    CARRIER_SHIPMENT_STATUS.registered,
    CARRIER_SHIPMENT_STATUS.inTransit,
    CARRIER_SHIPMENT_STATUS.exception,
  ],
  [CARRIER_SHIPMENT_STATUS.exception]: [
    CARRIER_SHIPMENT_STATUS.allocated,
    CARRIER_SHIPMENT_STATUS.registered,
    CARRIER_SHIPMENT_STATUS.inTransit,
    CARRIER_SHIPMENT_STATUS.exception,
  ],
  [CARRIER_SHIPMENT_STATUS.delivered]: [
    CARRIER_SHIPMENT_STATUS.allocated,
    CARRIER_SHIPMENT_STATUS.registered,
    CARRIER_SHIPMENT_STATUS.inTransit,
    CARRIER_SHIPMENT_STATUS.exception,
    CARRIER_SHIPMENT_STATUS.delivered,
  ],
};

export class CarrierShipmentStateConflictError extends Error {
  readonly code = "CARRIER_SHIPMENT_STATE_CONFLICT";
  readonly carrierShipmentId: number;
  readonly stateField: "invoice_status" | "shipment_status";
  readonly expectedFrom: readonly string[];
  readonly requestedStatus: string;
  readonly actualStatus: string | null;

  constructor(
    carrierShipmentId: number,
    stateField: "invoice_status" | "shipment_status",
    expectedFrom: readonly string[],
    requestedStatus: string,
    actualStatus: string | null
  ) {
    super(
      `Carrier shipment ${carrierShipmentId} ${stateField} changed from the expected state.`
    );
    this.name = "CarrierShipmentStateConflictError";
    this.carrierShipmentId = carrierShipmentId;
    this.stateField = stateField;
    this.expectedFrom = expectedFrom;
    this.requestedStatus = requestedStatus;
    this.actualStatus = actualStatus;
  }
}

export class CarrierShipmentStateNotFoundError extends Error {
  readonly code = "CARRIER_SHIPMENT_NOT_FOUND";
  readonly carrierShipmentId: number;

  constructor(carrierShipmentId: number) {
    super(`Carrier shipment ${carrierShipmentId} was not found.`);
    this.name = "CarrierShipmentStateNotFoundError";
    this.carrierShipmentId = carrierShipmentId;
  }
}

async function currentInvoiceStatus(
  client: CarrierShipmentStateClient,
  carrierShipmentId: number
) {
  const row = await client.carrier_shipments.findUnique({
    where: { carrier_shipment_id: carrierShipmentId },
    select: { invoice_status: true },
  });
  if (!row) throw new CarrierShipmentStateNotFoundError(carrierShipmentId);
  return row.invoice_status as CarrierInvoiceStatus;
}

async function currentShipmentStatus(
  client: CarrierShipmentStateClient,
  carrierShipmentId: number
) {
  const row = await client.carrier_shipments.findUnique({
    where: { carrier_shipment_id: carrierShipmentId },
    select: { shipment_status: true },
  });
  if (!row) throw new CarrierShipmentStateNotFoundError(carrierShipmentId);
  return row.shipment_status as CarrierShipmentStatus;
}

export async function applyObservedCarrierInvoiceStatus(
  client: CarrierShipmentStateClient,
  input: {
    carrierShipmentId: number;
    observedStatus: CarrierInvoiceStatus;
    observedAt: DateTimeInput;
    carrierRegisteredAt?: DateTimeInput;
  }
): Promise<CarrierShipmentStateResult<CarrierInvoiceStatus>> {
  const observedAt = databaseDateTime(input.observedAt);
  const carrierRegisteredAt = databaseDateTimeOrNull(
    input.carrierRegisteredAt
  );
  const allowedFrom = OBSERVED_INVOICE_ALLOWED_FROM[input.observedStatus];
  const changed = await client.carrier_shipments.updateMany({
    where: {
      carrier_shipment_id: input.carrierShipmentId,
      invoice_status: { in: [...allowedFrom], not: input.observedStatus },
    },
    data: {
      invoice_status: input.observedStatus,
      ...(input.observedStatus === CARRIER_INVOICE_STATUS.registered &&
      carrierRegisteredAt
        ? { carrier_registered_at: carrierRegisteredAt }
        : {}),
      updated_at: observedAt,
    },
  });
  if (changed.count === 1) {
    return { outcome: "APPLIED", currentStatus: input.observedStatus };
  }

  const alreadyApplied = await client.carrier_shipments.updateMany({
    where: {
      carrier_shipment_id: input.carrierShipmentId,
      invoice_status: input.observedStatus,
    },
    data: {
      ...(input.observedStatus === CARRIER_INVOICE_STATUS.registered &&
      carrierRegisteredAt
        ? { carrier_registered_at: carrierRegisteredAt }
        : {}),
      updated_at: observedAt,
    },
  });
  if (alreadyApplied.count === 1) {
    return {
      outcome: "ALREADY_APPLIED",
      currentStatus: input.observedStatus,
    };
  }

  return {
    outcome: "STALE_IGNORED",
    currentStatus: await currentInvoiceStatus(
      client,
      input.carrierShipmentId
    ),
  };
}

export async function applyObservedCarrierShipmentStatus(
  client: CarrierShipmentStateClient,
  input: {
    carrierShipmentId: number;
    observedStatus: CarrierShipmentStatus;
    observedAt: DateTimeInput;
  }
): Promise<CarrierShipmentStateResult<CarrierShipmentStatus>> {
  const observedAt = databaseDateTime(input.observedAt);
  const allowedFrom = OBSERVED_SHIPMENT_ALLOWED_FROM[input.observedStatus];
  const changed = await client.carrier_shipments.updateMany({
    where: {
      carrier_shipment_id: input.carrierShipmentId,
      shipment_status: { in: [...allowedFrom], not: input.observedStatus },
    },
    data: {
      shipment_status: input.observedStatus,
      updated_at: observedAt,
    },
  });
  if (changed.count === 1) {
    return { outcome: "APPLIED", currentStatus: input.observedStatus };
  }

  const current = await currentShipmentStatus(client, input.carrierShipmentId);
  if (current === input.observedStatus) {
    return { outcome: "ALREADY_APPLIED", currentStatus: current };
  }
  return { outcome: "STALE_IGNORED", currentStatus: current };
}

export async function transitionCarrierInvoiceStatus(
  client: CarrierShipmentStateClient,
  input: {
    carrierShipmentId: number;
    expectedFrom: readonly CarrierInvoiceStatus[];
    to: CarrierInvoiceStatus;
    transitionedAt: DateTimeInput;
    carrierRegisteredAt?: DateTimeInput;
    expectedPackageGroupId?: number;
    expectedTrackingNumber?: string;
  }
): Promise<CarrierShipmentStateResult<CarrierInvoiceStatus>> {
  const transitionedAt = databaseDateTime(input.transitionedAt);
  const carrierRegisteredAt = databaseDateTimeOrNull(
    input.carrierRegisteredAt
  );
  const globallyAllowedFrom = new Set(
    OBSERVED_INVOICE_ALLOWED_FROM[input.to]
  );
  if (input.expectedFrom.some((status) => !globallyAllowedFrom.has(status))) {
    throw new Error(
      `Invalid carrier invoice transition contract: ${input.expectedFrom.join(
        ","
      )} -> ${input.to}`
    );
  }

  const changed = await client.carrier_shipments.updateMany({
    where: {
      carrier_shipment_id: input.carrierShipmentId,
      ...(input.expectedPackageGroupId !== undefined
        ? { package_group_id: input.expectedPackageGroupId }
        : {}),
      ...(input.expectedTrackingNumber !== undefined
        ? { tracking_number: input.expectedTrackingNumber }
        : {}),
      invoice_status: { in: [...input.expectedFrom] },
    },
    data: {
      invoice_status: input.to,
      ...(input.to === CARRIER_INVOICE_STATUS.registered &&
      carrierRegisteredAt
        ? { carrier_registered_at: carrierRegisteredAt }
        : {}),
      updated_at: transitionedAt,
    },
  });
  if (changed.count === 1) {
    return { outcome: "APPLIED", currentStatus: input.to };
  }

  const alreadyApplied = await client.carrier_shipments.findFirst({
    where: {
      carrier_shipment_id: input.carrierShipmentId,
      ...(input.expectedPackageGroupId !== undefined
        ? { package_group_id: input.expectedPackageGroupId }
        : {}),
      ...(input.expectedTrackingNumber !== undefined
        ? { tracking_number: input.expectedTrackingNumber }
        : {}),
      invoice_status: input.to,
    },
    select: { invoice_status: true },
  });
  if (alreadyApplied) {
    if (
      input.to === CARRIER_INVOICE_STATUS.registered &&
      carrierRegisteredAt
    ) {
      await client.carrier_shipments.updateMany({
        where: {
          carrier_shipment_id: input.carrierShipmentId,
          ...(input.expectedPackageGroupId !== undefined
            ? { package_group_id: input.expectedPackageGroupId }
            : {}),
          ...(input.expectedTrackingNumber !== undefined
            ? { tracking_number: input.expectedTrackingNumber }
            : {}),
          invoice_status: input.to,
          carrier_registered_at: null,
        },
        data: {
          carrier_registered_at: carrierRegisteredAt,
          updated_at: transitionedAt,
        },
      });
    }
    return { outcome: "ALREADY_APPLIED", currentStatus: input.to };
  }

  const current = await currentInvoiceStatus(client, input.carrierShipmentId);

  throw new CarrierShipmentStateConflictError(
    input.carrierShipmentId,
    "invoice_status",
    input.expectedFrom,
    input.to,
    current
  );
}
