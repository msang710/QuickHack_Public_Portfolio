import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-logen-tracking-isolation-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
let logenCarrierClient;
let originalGetTracking;
const originalFetch = globalThis.fetch;
let fixtureSequence = 0;

function successfulTrackingResult(trackingNumbers) {
  return {
    carrierCode: "LOGEN",
    mode: "mock",
    source: "mock:/lrm02b-edi/edi/inquiryCargoTrackingMulti",
    apiName: "inquiryCargoTrackingMulti",
    requestPath: "/lrm02b-edi/edi/inquiryCargoTrackingMulti",
    method: "POST",
    operationType: "READ",
    httpStatusCode: 200,
    requestHash: `request:${trackingNumbers.join(",")}`,
    responseHash: `response:${trackingNumbers.join(",")}`,
    payload: {
      sttsCd: "SUCCESS",
      sttsMsg: null,
      data: trackingNumbers.map((trackingNumber) => ({
        slipNo: trackingNumber,
        resultCd: "TRUE",
        resultMsg: null,
        data1: [],
      })),
    },
  };
}

function transportError(message, transient) {
  return Object.assign(new Error(message), { transient });
}

async function createTrackingCandidates(trackingNumbers) {
  const shipments = [];
  for (const trackingNumber of trackingNumbers) {
    fixtureSequence += 1;
    const now = new Date(
      `2026-07-31T09:${String(fixtureSequence).padStart(2, "0")}:00+09:00`
    );
    const group = await prisma.shipment_package_groups.create({
      data: {
        channel: "COUPANG",
        grouping_key: `tracking-isolation-${fixtureSequence}`,
        receiver_name_snapshot: `receiver-${fixtureSequence}`,
        receiver_address_snapshot: `address-${fixtureSequence}`,
        group_status: "READY",
        created_at: now,
        updated_at: now,
      },
    });
    const shipment = await prisma.carrier_shipments.create({
      data: {
        carrier_code: "LOGEN",
        source_type: "SELF_PRINT",
        package_group_id: group.package_group_id,
        tracking_number: trackingNumber,
        invoice_status: "REGISTERED",
        shipment_status: "REGISTERED",
        carrier_registered_at: now,
        last_tracked_at: null,
        created_at: now,
        updated_at: now,
      },
    });
    await prisma.shipment_package_groups.update({
      where: { package_group_id: group.package_group_id },
      data: {
        current_carrier_shipment_id: shipment.carrier_shipment_id,
        updated_at: now,
      },
    });
    shipments.push(shipment);
  }
  return shipments;
}

async function assertPermanentSystemicFailureIsRethrown(trackingApi) {
  const trackingNumbers = [
    "88110000001",
    "88110000002",
  ];
  const shipments = await createTrackingCandidates(trackingNumbers);
  const calls = [];

  logenCarrierClient.getTracking = async (requestedTrackingNumbers) => {
    calls.push([...requestedTrackingNumbers]);
    throw transportError("authentication rejected", false);
  };

  let failure = null;
  try {
    await trackingApi.processLogenShipmentTracking({ limit: 10 });
  } catch (error) {
    failure = error;
  }
  assert(failure, "The permanent systemic carrier failure was swallowed.");
  assert(
    calls.length === 1 &&
      JSON.stringify(calls[0]) === JSON.stringify(trackingNumbers),
    `The systemic failure was incorrectly split: ${JSON.stringify(calls)}`
  );
  assert(
    (await prisma.carrier_reconciliation_works.count({
      where: {
        carrier_code: "LOGEN",
        operation_type: "TRACKING_SYNC_READ",
        lookup_key_value: { in: trackingNumbers },
      },
    })) === 0,
    "A systemic carrier failure created per-shipment reviews."
  );
  const persisted = await prisma.carrier_shipments.findMany({
    where: {
      carrier_shipment_id: {
        in: shipments.map((shipment) => shipment.carrier_shipment_id),
      },
    },
  });
  assert(
    persisted.every((shipment) => shipment.last_tracked_at == null),
    "A systemic carrier failure throttled individual shipments."
  );
  assert(
    (await prisma.carrier_api_call_logs.count({
      where: {
        carrier_code: "LOGEN",
        api_name: "inquiryCargoTrackingMulti",
        processed_status: "FAILED",
      },
    })) === 1,
    "The failed systemic call was not logged exactly once."
  );

  await prisma.carrier_shipments.updateMany({
    where: {
      carrier_shipment_id: {
        in: shipments.map((shipment) => shipment.carrier_shipment_id),
      },
    },
    data: { shipment_status: "DELIVERED" },
  });
}

async function assertHttpAndProtocolFailuresAreSystemic(trackingApi) {
  const scenarios = [
    {
      name: "HTTP 401",
      response: () => new Response("unauthorized", { status: 401 }),
    },
    {
      name: "HTTP 403",
      response: () => new Response("forbidden", { status: 403 }),
    },
    {
      name: "HTTP 404",
      response: () => new Response("not found", { status: 404 }),
    },
    {
      name: "malformed JSON",
      response: () => new Response('{"broken":', { status: 200 }),
    },
  ];

  for (const scenario of scenarios) {
    const trackingNumbers = [
      `8822${String(fixtureSequence + 1).padStart(7, "0")}`,
      `8822${String(fixtureSequence + 2).padStart(7, "0")}`,
    ];
    const shipments = await createTrackingCandidates(trackingNumbers);
    let fetchCalls = 0;
    logenCarrierClient.getTracking = originalGetTracking;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return scenario.response();
    };

    let failure = null;
    try {
      await trackingApi.processLogenShipmentTracking({ limit: 10 });
    } catch (error) {
      failure = error;
    }
    assert(failure, `${scenario.name} was swallowed by the tracking worker.`);
    assert(
      fetchCalls === 1,
      `${scenario.name} was split or retried ${fetchCalls} times.`
    );
    assert(
      (await prisma.carrier_reconciliation_works.count({
        where: {
          carrier_code: "LOGEN",
          operation_type: "TRACKING_SYNC_READ",
          lookup_key_value: { in: trackingNumbers },
        },
      })) === 0,
      `${scenario.name} created false per-shipment reviews.`
    );
    const persisted = await prisma.carrier_shipments.findMany({
      where: {
        carrier_shipment_id: {
          in: shipments.map((shipment) => shipment.carrier_shipment_id),
        },
      },
    });
    assert(
      persisted.every((shipment) => shipment.last_tracked_at == null),
      `${scenario.name} throttled individual shipments.`
    );
    await prisma.carrier_shipments.updateMany({
      where: {
        carrier_shipment_id: {
          in: shipments.map((shipment) => shipment.carrier_shipment_id),
        },
      },
      data: { shipment_status: "DELIVERED" },
    });
  }

  globalThis.fetch = originalFetch;
}

async function assertResponseItemFailureRemainsPerShipment(trackingApi) {
  const trackingNumbers = ["88110000031", "88110000032"];
  const shipments = await createTrackingCandidates(trackingNumbers);
  const failedTrackingNumber = trackingNumbers[1];
  const failedShipment = shipments.find(
    (shipment) => shipment.tracking_number === failedTrackingNumber
  );
  assert(failedShipment, "The failed tracking fixture shipment is missing.");
  const calls = [];

  logenCarrierClient.getTracking = async (requestedTrackingNumbers) => {
    calls.push([...requestedTrackingNumbers]);
    const result = successfulTrackingResult(requestedTrackingNumbers);
    const failedItem = result.payload.data.find(
      (item) => item.slipNo === failedTrackingNumber
    );
    failedItem.resultCd = "FALSE";
    failedItem.resultMsg = "invalid tracking number";
    return result;
  };

  const summary = await trackingApi.processLogenShipmentTracking({ limit: 10 });
  assert(
    calls.length === 1 &&
      JSON.stringify(calls[0]) === JSON.stringify(trackingNumbers),
    `A successful item-level response was unexpectedly split: ${JSON.stringify(calls)}`
  );
  assert(
    summary.candidateCount === 2 &&
      summary.processedCount === 2 &&
      summary.succeededCount === 1 &&
      summary.failedCount === 1 &&
      summary.reviewRequiredCount === 1,
    `The item-level result summary was incorrect: ${JSON.stringify(summary)}`
  );
  assert(
    (await prisma.carrier_reconciliation_works.count({
      where: {
        carrier_code: "LOGEN",
        operation_type: "TRACKING_SYNC_READ",
        lookup_key_value: failedTrackingNumber,
      },
    })) === 1,
    "A declared response item failure did not create its shipment review."
  );
  const evidence = await prisma.integration_evidences.findFirst({
    where: {
      provider: "LOGEN",
      evidence_type: "LOGEN_TRACKING_BATCH",
      raw_payload_text: { contains: failedTrackingNumber },
    },
    include: { projection_jobs: true },
  });
  assert(
    evidence?.projection_jobs[0]?.projection_status === "SUCCEEDED",
    "A validated tracking response was not stored and projected through the inbox."
  );

  logenCarrierClient.getTracking = async (requestedTrackingNumbers) =>
    successfulTrackingResult(requestedTrackingNumbers);
  await prisma.carrier_shipments.update({
    where: {
      carrier_shipment_id: failedShipment.carrier_shipment_id,
    },
    data: {
      last_tracked_at: new Date("2026-07-31T00:00:00.000Z"),
    },
  });
  const recovery = await trackingApi.processLogenShipmentTracking({ limit: 10 });
  const recoveredReview =
    await prisma.carrier_reconciliation_works.findFirstOrThrow({
      where: {
        carrier_code: "LOGEN",
        operation_type: "TRACKING_SYNC_READ",
        lookup_key_value: failedTrackingNumber,
      },
    });
  assert(
    recovery.succeededCount === 1 &&
      recoveredReview.reconciliation_status === "RESOLVED",
    `A later successful read did not close the exact observed review incident (summary=${JSON.stringify(recovery)}, status=${recoveredReview.reconciliation_status}).`
  );

  await prisma.carrier_shipments.updateMany({
    where: {
      carrier_shipment_id: {
        in: shipments.map((shipment) => shipment.carrier_shipment_id),
      },
    },
    data: { shipment_status: "DELIVERED" },
  });
}

async function assertTransientFailureIsRethrown(trackingApi) {
  const trackingNumbers = ["88110000011", "88110000012"];
  const shipments = await createTrackingCandidates(trackingNumbers);
  const calls = [];
  logenCarrierClient.getTracking = async (requestedTrackingNumbers) => {
    calls.push([...requestedTrackingNumbers]);
    throw transportError("temporary upstream outage", true);
  };

  let failure = null;
  try {
    await trackingApi.processLogenShipmentTracking({ limit: 10 });
  } catch (error) {
    failure = error;
  }
  assert(failure, "The transient carrier failure was swallowed.");
  assert(
    calls.length === 1 &&
      JSON.stringify(calls[0]) === JSON.stringify(trackingNumbers),
    `The transient failure was incorrectly split: ${JSON.stringify(calls)}`
  );
  assert(
    (await prisma.carrier_reconciliation_works.count({
      where: {
        operation_type: "TRACKING_SYNC_READ",
        lookup_key_value: { in: trackingNumbers },
      },
    })) === 0,
    "A transient carrier outage created item reviews."
  );
  const persisted = await prisma.carrier_shipments.findMany({
    where: {
      carrier_shipment_id: {
        in: shipments.map((shipment) => shipment.carrier_shipment_id),
      },
    },
  });
  assert(
    persisted.every((shipment) => shipment.last_tracked_at == null),
    "A transient carrier outage throttled individual shipments."
  );

  await prisma.carrier_shipments.updateMany({
    where: {
      carrier_shipment_id: {
        in: shipments.map((shipment) => shipment.carrier_shipment_id),
      },
    },
    data: { shipment_status: "DELIVERED" },
  });
}

async function assertLeaseAbortIsRethrown(trackingApi) {
  const trackingNumbers = ["88110000021", "88110000022"];
  const shipments = await createTrackingCandidates(trackingNumbers);
  const controller = new AbortController();
  const leaseFailure = new Error("tracking worker lease lost");
  const calls = [];
  logenCarrierClient.getTracking = async (requestedTrackingNumbers) => {
    calls.push([...requestedTrackingNumbers]);
    controller.abort(leaseFailure);
    throw transportError("invalid batch after lease loss", false);
  };

  let failure = null;
  try {
    await trackingApi.processLogenShipmentTracking({
      limit: 10,
      workerLease: {
        signal: controller.signal,
        assertLeaseActive: async () => undefined,
      },
    });
  } catch (error) {
    failure = error;
  }
  assert(
    failure === leaseFailure,
    "A worker lease abort was converted into a carrier review."
  );
  assert(calls.length === 1, "A worker lease abort continued batch splitting.");
  assert(
    (await prisma.carrier_reconciliation_works.count({
      where: {
        operation_type: "TRACKING_SYNC_READ",
        lookup_key_value: { in: trackingNumbers },
      },
    })) === 0,
    "A worker lease abort created item reviews."
  );
  const persisted = await prisma.carrier_shipments.findMany({
    where: {
      carrier_shipment_id: {
        in: shipments.map((shipment) => shipment.carrier_shipment_id),
      },
    },
  });
  assert(
    persisted.every((shipment) => shipment.last_tracked_at == null),
    "A worker lease abort throttled individual shipments."
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  ({ logenCarrierClient } = await import(
    "@/quickhack_server/shipment/carrier-integration/logen/api-client"
  ));
  originalGetTracking = logenCarrierClient.getTracking;
  const trackingApi = await import(
    "@/quickhack_server/shipment/carrier-integration/logen/tracking-sync-service"
  );

  await assertPermanentSystemicFailureIsRethrown(trackingApi);
  await assertHttpAndProtocolFailuresAreSystemic(trackingApi);
  await assertResponseItemFailureRemainsPerShipment(trackingApi);
  await assertTransientFailureIsRethrown(trackingApi);
  await assertLeaseAbortIsRethrown(trackingApi);

  console.log("Logen tracking transport isolation checks passed.");
} finally {
  if (logenCarrierClient && originalGetTracking) {
    logenCarrierClient.getTracking = originalGetTracking;
  }
  globalThis.fetch = originalFetch;
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
