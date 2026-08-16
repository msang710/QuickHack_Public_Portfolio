import {
  assert,
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-read-sync-credential-context-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function apiResponse(requestPath, payload) {
  const responsePayload = { code: "SUCCESS", ...payload };
  return {
    mode: "mock",
    source: `mock:${requestPath.split("?")[0]}`,
    requestPath,
    httpStatusCode: 200,
    responseHash: `hash-${requestPath}`,
    rawPayloadText: JSON.stringify(responsePayload),
    auth: {
      providerType: "USB_QHKEY",
      keyAlias: "read-sync-context-test",
      keyFingerprint: "TEST-FINGERPRINT",
      authStatus: "SUCCEEDED",
      warningMessage: null,
    },
    payload: responsePayload,
  };
}

function fakeCredentialContext(label) {
  return {
    context: {
      providerType: "USB_QHKEY",
      channel: "COUPANG",
      status: "ACTIVE",
      keyAlias: label,
      keyFingerprint: `fingerprint-${label}`,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2036-01-01T00:00:00.000Z",
      warningMessage: null,
      errorMessage: null,
      readEnabled: true,
      writeEnabled: true,
      mode: "mock",
      apiHost: "http://127.0.0.1:3100",
      vendorId: "TEST-VENDOR",
      timeoutMs: 1_000,
    },
    sign() {
      throw new Error("The injected read client must not call the fake signer.");
    },
  };
}

async function expectRejected(promise, pattern, label) {
  let caught = null;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  assert(caught, `${label} did not reject.`);
  assert(
    pattern.test(caught instanceof Error ? caught.message : String(caught)),
    `${label} rejected for an unexpected reason: ${
      caught instanceof Error ? caught.message : String(caught)
    }`
  );
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    syncCoupangAcceptOrders,
    syncCoupangAfterShipmentClaims,
    syncCoupangPreShipmentVerification,
  } = await import("@/quickhack_server/sales-channel/coupang/sync-service");
  const {
    runOperationTrace,
    traceOperationSpanSync,
  } = await import("@/quickhack_server/observability/operation-trace");

  const orderContext = fakeCredentialContext("orders");
  const orderContexts = [];
  const orderCalls = [];
  let orderContextOpenCount = 0;
  let orderTrace = null;

  const orderSummary = await runOperationTrace(
    {
      operationName: "test.coupang.read-sync.orders",
      source: "WORKER",
      persist: false,
      onComplete(snapshot) {
        orderTrace = snapshot;
      },
    },
    () =>
      syncCoupangPreShipmentVerification(
        { reason: "credential-context-test" },
        {
          openCredentialContext() {
            orderContextOpenCount += 1;
            return traceOperationSpanSync("QHKEY_CONTEXT", () => orderContext);
          },
          async getOrdersheets(input, credentialContext) {
            orderContexts.push(credentialContext);
            orderCalls.push({ status: input.status, nextToken: input.nextToken });

            if (input.status === "INSTRUCT" && !input.nextToken) {
              return apiResponse(
                "/ordersheets?status=INSTRUCT",
                { data: [], nextToken: "INSTRUCT-PAGE-2" }
              );
            }

            return apiResponse(
              `/ordersheets?status=${input.status}&nextToken=${
                input.nextToken ?? ""
              }`,
              { data: [] }
            );
          },
        }
      )
  );

  assert(orderSummary.pages === 3, "The order sync did not traverse all pages.");
  assert(orderCalls.length === 3, "Unexpected order API call count.");
  assert(orderContextOpenCount === 1, "The order sync reopened its credential context.");
  assert(
    orderContexts.every((context) => context === orderContext),
    "The order sync did not reuse the same credential context."
  );
  assert(
    orderTrace?.spans.QHKEY_CONTEXT?.count === 1,
    "The order sync trace did not record exactly one QHKey context."
  );
  assert(
    orderTrace?.fields["qhkey.credential_context_scope"] === "READ_SYNC_RUN",
    "The order sync trace has the wrong credential context scope."
  );
  assert(
    orderTrace?.fields["qhkey.credential_context_use_count"] === "3",
    "The order sync trace has the wrong credential context use count."
  );
  assert(
    orderTrace?.fields["qhkey.credential_context_reused"] === "true",
    "The order sync trace did not report context reuse."
  );

  const orderLogs = await prisma.coupang_api_call_log.findMany({
    where: { api_name: "ordersheets.preShipmentVerification" },
    orderBy: { coupang_api_call_log_id: "asc" },
  });
  assert(orderLogs.length === 3, "The order sync did not create one log per page.");
  assert(
    orderLogs.every((row) => row.processed_status === "SUCCESS"),
    "The order sync page logs did not all complete successfully."
  );

  const claimContext = fakeCredentialContext("claims");
  const claimContexts = [];
  const claimCalls = [];
  let claimContextOpenCount = 0;
  let claimTrace = null;

  const claimSummary = await runOperationTrace(
    {
      operationName: "test.coupang.read-sync.claims",
      source: "WORKER",
      persist: false,
      onComplete(snapshot) {
        claimTrace = snapshot;
      },
    },
    () =>
      syncCoupangAfterShipmentClaims(
        { reason: "credential-context-test" },
        {
          openCredentialContext() {
            claimContextOpenCount += 1;
            return traceOperationSpanSync("QHKEY_CONTEXT", () => claimContext);
          },
          async getReturnRequests(input, credentialContext) {
            claimContexts.push(credentialContext);
            claimCalls.push(
              `return:${input.status}:${input.cancelType}:${input.nextToken ?? ""}`
            );

            if (
              input.status === "RU" &&
              input.cancelType === "RETURN" &&
              !input.nextToken
            ) {
              return apiResponse(
                "/returnRequests?status=RU",
                { data: [], nextToken: "RU-PAGE-2" }
              );
            }

            return apiResponse(
              `/returnRequests?status=${input.status}&nextToken=${
                input.nextToken ?? ""
              }`,
              { data: [] }
            );
          },
          async getExchangeRequests(input, credentialContext) {
            claimContexts.push(credentialContext);
            claimCalls.push(`exchange:${input.nextToken ?? ""}`);
            return apiResponse("/exchangeRequests", { data: [] });
          },
          async getReturnWithdrawals(input, credentialContext) {
            claimContexts.push(credentialContext);
            claimCalls.push(`withdrawal:${input.pageIndex}`);
            return apiResponse(
              `/returnWithdrawRequests?pageIndex=${input.pageIndex}`,
              { data: [] }
            );
          },
        }
      )
  );

  assert(claimSummary.returns.pages === 5, "The return sync page count is incorrect.");
  assert(
    claimSummary.returns.receiptTypes.join(",") === "RETURN,CANCEL",
    "The return sync did not explicitly read both receipt types."
  );
  assert(claimSummary.exchanges.pages === 1, "The exchange sync page count is incorrect.");
  assert(
    claimSummary.withdrawals.pages === claimSummary.withdrawals.intervals,
    "The withdrawal sync did not read every seven-day interval."
  );
  assert(
    claimCalls.length === 6 + claimSummary.withdrawals.pages,
    "Unexpected after-shipment API call count."
  );
  assert(
    claimContextOpenCount === 1,
    "The after-shipment sync reopened its credential context."
  );
  assert(
    claimContexts.every((context) => context === claimContext),
    "Returns, exchanges, and withdrawals did not share one credential context."
  );
  assert(
    claimTrace?.spans.QHKEY_CONTEXT?.count === 1,
    "The after-shipment trace did not record exactly one QHKey context."
  );
  assert(
    claimTrace?.fields["qhkey.credential_context_use_count"] ===
      String(claimCalls.length),
    "The after-shipment trace has the wrong context use count."
  );

  const credentialFailure = new Error("QHKEY fixture unavailable");
  let failedReaderCallCount = 0;

  await expectRejected(
    syncCoupangAcceptOrders(
      { reason: "credential-failure-test" },
      {
        openCredentialContext() {
          throw credentialFailure;
        },
        async getOrdersheets() {
          failedReaderCallCount += 1;
          return apiResponse("/ordersheets", { data: [] });
        },
      }
    ),
    /QHKEY fixture unavailable/,
    "Credential failure sync"
  );
  assert(failedReaderCallCount === 0, "The API was called after credential failure.");

  const credentialFailureLog = await prisma.coupang_api_call_log.findFirst({
    where: { api_name: "ordersheets.accept" },
    orderBy: { coupang_api_call_log_id: "desc" },
  });
  assert(credentialFailureLog, "Credential failure did not create an API call log.");
  assert(
    credentialFailureLog.processed_status === "FAILED",
    "Credential failure did not fail the pending API call log."
  );
  assert(
    credentialFailureLog.error_message?.includes("QHKEY fixture unavailable"),
    "Credential failure log did not retain the error message."
  );

  const leaseController = new AbortController();
  let leaseReaderCallCount = 0;
  const leaseWorker = await prisma.server_worker_jobs.create({
    data: {
      worker_key: "test-read-sync-credential-context-lease",
      worker_name: "Test read sync credential context lease",
      worker_type: "COUPANG_SYNC",
      status: "RUNNING",
    },
  });

  await expectRejected(
    syncCoupangAcceptOrders(
      {
        reason: "lease-loss-test",
        workerLease: {
          workerJobId: leaseWorker.worker_job_id,
          signal: leaseController.signal,
          async assertLeaseActive() {},
        },
      },
      {
        openCredentialContext() {
          leaseController.abort(new Error("test worker lease lost"));
          return fakeCredentialContext("lease-loss");
        },
        async getOrdersheets() {
          leaseReaderCallCount += 1;
          return apiResponse("/ordersheets", { data: [] });
        },
      }
    ),
    /test worker lease lost/,
    "Lease loss sync"
  );
  assert(leaseReaderCallCount === 0, "The API was called after the worker lease was lost.");

  const leaseFailureLog = await prisma.coupang_api_call_log.findFirst({
    where: {
      api_name: "ordersheets.accept",
      worker_job_id: leaseWorker.worker_job_id,
    },
    orderBy: { coupang_api_call_log_id: "desc" },
  });
  assert(leaseFailureLog, "Lease loss did not create an API call log.");
  assert(
    leaseFailureLog.processed_status === "FAILED",
    "Lease loss did not fail the pending API call log."
  );

  console.log("Coupang read sync credential context reuse verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
