import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-carrier-shipment-state-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
let sequence = 99000000000;

function at(value) {
  return new Date(`${value.replace(" ", "T")}+09:00`);
}

function nextTrackingNumber() {
  sequence += 1;
  return String(sequence);
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    applyObservedCarrierInvoiceStatus,
    applyObservedCarrierShipmentStatus,
    CarrierShipmentStateConflictError,
    transitionCarrierInvoiceStatus,
  } = await import(
    "@/quickhack_server/shipment/carrier-integration/carrier-shipment-state-service"
  );
  const { appendCarrierTrackingEvents, upsertCarrierShipment } = await import(
    "@/quickhack_server/shipment/carrier-integration/persistence-service"
  );
  const { CARRIER_INVOICE_STATUS } = await import(
    "@/quickhack_shared/shipment/carrier-invoice-status"
  );
  const { CARRIER_SHIPMENT_STATUS } = await import(
    "@/quickhack_shared/shipment/carrier-tracking-status"
  );

  async function createShipment({
    invoiceStatus = CARRIER_INVOICE_STATUS.registered,
    shipmentStatus = CARRIER_SHIPMENT_STATUS.registered,
  } = {}) {
    return prisma.carrier_shipments.create({
      data: {
        carrier_code: "LOGEN",
        source_type: "SELF_PRINT",
        tracking_number: nextTrackingNumber(),
        invoice_status: invoiceStatus,
        shipment_status: shipmentStatus,
        carrier_registered_at:
          invoiceStatus === CARRIER_INVOICE_STATUS.allocated
            ? null
            : at("2026-08-07 09:00:00"),
        created_at: at("2026-08-07 09:00:00"),
        updated_at: at("2026-08-07 09:00:00"),
      },
    });
  }

  const registration = await createShipment({
    invoiceStatus: CARRIER_INVOICE_STATUS.allocated,
    shipmentStatus: CARRIER_SHIPMENT_STATUS.allocated,
  });
  const registered = await applyObservedCarrierInvoiceStatus(prisma, {
    carrierShipmentId: registration.carrier_shipment_id,
    observedStatus: CARRIER_INVOICE_STATUS.registered,
    observedAt: at("2026-08-07 09:01:00"),
    carrierRegisteredAt: at("2026-08-07 09:01:00"),
  });
  assert.equal(registered.outcome, "APPLIED");

  const replacedShipment = await createShipment();
  await transitionCarrierInvoiceStatus(prisma, {
    carrierShipmentId: replacedShipment.carrier_shipment_id,
    expectedFrom: [CARRIER_INVOICE_STATUS.registered],
    to: CARRIER_INVOICE_STATUS.replaced,
    transitionedAt: at("2026-08-07 09:02:00"),
  });
  const staleRegistered = await upsertCarrierShipment({
    carrierCode: "LOGEN",
    sourceType: "CARRIER_POPUP",
    trackingNumber: replacedShipment.tracking_number,
    invoiceStatus: CARRIER_INVOICE_STATUS.registered,
    shipmentStatus: CARRIER_SHIPMENT_STATUS.registered,
  });
  assert.equal(staleRegistered.invoice_status, CARRIER_INVOICE_STATUS.replaced);

  const voidShipment = await createShipment({
    invoiceStatus: CARRIER_INVOICE_STATUS.allocated,
    shipmentStatus: CARRIER_SHIPMENT_STATUS.allocated,
  });
  await transitionCarrierInvoiceStatus(prisma, {
    carrierShipmentId: voidShipment.carrier_shipment_id,
    expectedFrom: [CARRIER_INVOICE_STATUS.allocated],
    to: CARRIER_INVOICE_STATUS.voidLocal,
    transitionedAt: at("2026-08-07 09:03:00"),
  });
  const staleVoidRegistration = await upsertCarrierShipment({
    carrierCode: "LOGEN",
    sourceType: "CARRIER_POPUP",
    trackingNumber: voidShipment.tracking_number,
    invoiceStatus: CARRIER_INVOICE_STATUS.registered,
    shipmentStatus: CARRIER_SHIPMENT_STATUS.registered,
  });
  assert.equal(
    staleVoidRegistration.invoice_status,
    CARRIER_INVOICE_STATUS.voidLocal
  );

  const deliveredShipment = await createShipment();
  await applyObservedCarrierShipmentStatus(prisma, {
    carrierShipmentId: deliveredShipment.carrier_shipment_id,
    observedStatus: CARRIER_SHIPMENT_STATUS.delivered,
    observedAt: at("2026-08-07 09:04:00"),
  });
  const staleTracking = await appendCarrierTrackingEvents({
    carrierShipmentId: deliveredShipment.carrier_shipment_id,
    shipmentStatus: CARRIER_SHIPMENT_STATUS.inTransit,
    events: [
      {
        scanDate: "20260807",
        scanTime: "090500",
        statusName: "IN_TRANSIT_STALE",
      },
    ],
  });
  assert.equal(staleTracking?.outcome, "STALE_IGNORED");
  const deliveredAfterStale =
    await prisma.carrier_shipments.findUniqueOrThrow({
      where: {
        carrier_shipment_id: deliveredShipment.carrier_shipment_id,
      },
    });
  assert.equal(
    deliveredAfterStale.shipment_status,
    CARRIER_SHIPMENT_STATUS.delivered
  );
  assert.ok(deliveredAfterStale.last_tracked_at);
  assert.equal(
    await prisma.carrier_tracking_events.count({
      where: { carrier_shipment_id: deliveredShipment.carrier_shipment_id },
    }),
    1
  );

  const recoveryShipment = await createShipment({
    shipmentStatus: CARRIER_SHIPMENT_STATUS.exception,
  });
  await applyObservedCarrierShipmentStatus(prisma, {
    carrierShipmentId: recoveryShipment.carrier_shipment_id,
    observedStatus: CARRIER_SHIPMENT_STATUS.inTransit,
    observedAt: at("2026-08-07 09:06:00"),
  });
  await applyObservedCarrierShipmentStatus(prisma, {
    carrierShipmentId: recoveryShipment.carrier_shipment_id,
    observedStatus: CARRIER_SHIPMENT_STATUS.delivered,
    observedAt: at("2026-08-07 09:07:00"),
  });
  assert.equal(
    (
      await prisma.carrier_shipments.findUniqueOrThrow({
        where: {
          carrier_shipment_id: recoveryShipment.carrier_shipment_id,
        },
      })
    ).shipment_status,
    CARRIER_SHIPMENT_STATUS.delivered
  );

  const unclassifiedShipment = await createShipment();
  const unclassifiedResult = await appendCarrierTrackingEvents({
    carrierShipmentId: unclassifiedShipment.carrier_shipment_id,
    events: [
      {
        scanDate: "20260807",
        scanTime: "090800",
        statusName: "UNCLASSIFIED_RAW_STATUS",
      },
    ],
  });
  assert.equal(unclassifiedResult, null);
  assert.equal(
    (
      await prisma.carrier_shipments.findUniqueOrThrow({
        where: {
          carrier_shipment_id: unclassifiedShipment.carrier_shipment_id,
        },
      })
    ).shipment_status,
    CARRIER_SHIPMENT_STATUS.registered
  );

  const competingTerminalShipment = await createShipment();
  const competingResults = await Promise.allSettled([
    transitionCarrierInvoiceStatus(prisma, {
      carrierShipmentId: competingTerminalShipment.carrier_shipment_id,
      expectedFrom: [CARRIER_INVOICE_STATUS.registered],
      to: CARRIER_INVOICE_STATUS.replaced,
      transitionedAt: at("2026-08-07 09:09:00"),
    }),
    transitionCarrierInvoiceStatus(prisma, {
      carrierShipmentId: competingTerminalShipment.carrier_shipment_id,
      expectedFrom: [CARRIER_INVOICE_STATUS.registered],
      to: CARRIER_INVOICE_STATUS.voidLocal,
      transitionedAt: at("2026-08-07 09:09:00"),
    }),
  ]);
  assert.equal(
    competingResults.filter((result) => result.status === "fulfilled").length,
    1
  );
  const rejectedTerminal = competingResults.find(
    (result) => result.status === "rejected"
  );
  assert.ok(
    rejectedTerminal?.status === "rejected" &&
      rejectedTerminal.reason instanceof CarrierShipmentStateConflictError
  );
  const terminalStatus = (
    await prisma.carrier_shipments.findUniqueOrThrow({
      where: {
        carrier_shipment_id: competingTerminalShipment.carrier_shipment_id,
      },
    })
  ).invoice_status;
  assert.ok(
    [
      CARRIER_INVOICE_STATUS.replaced,
      CARRIER_INVOICE_STATUS.voidLocal,
    ].includes(terminalStatus)
  );

  const convergentDelivery = await createShipment();
  await Promise.all([
    applyObservedCarrierShipmentStatus(prisma, {
      carrierShipmentId: convergentDelivery.carrier_shipment_id,
      observedStatus: CARRIER_SHIPMENT_STATUS.inTransit,
      observedAt: at("2026-08-07 09:10:00"),
    }),
    applyObservedCarrierShipmentStatus(prisma, {
      carrierShipmentId: convergentDelivery.carrier_shipment_id,
      observedStatus: CARRIER_SHIPMENT_STATUS.delivered,
      observedAt: at("2026-08-07 09:10:00"),
    }),
  ]);
  assert.equal(
    (
      await prisma.carrier_shipments.findUniqueOrThrow({
        where: {
          carrier_shipment_id: convergentDelivery.carrier_shipment_id,
        },
      })
    ).shipment_status,
    CARRIER_SHIPMENT_STATUS.delivered
  );

  const idempotent = await transitionCarrierInvoiceStatus(prisma, {
    carrierShipmentId: replacedShipment.carrier_shipment_id,
    expectedFrom: [CARRIER_INVOICE_STATUS.registered],
    to: CARRIER_INVOICE_STATUS.replaced,
    transitionedAt: at("2026-08-07 09:11:00"),
  });
  assert.equal(idempotent.outcome, "ALREADY_APPLIED");

  console.log("Carrier shipment state transitions verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
