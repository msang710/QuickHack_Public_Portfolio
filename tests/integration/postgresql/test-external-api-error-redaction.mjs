import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

process.env.NODE_ENV = "test";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-external-api-redaction-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const BODY_MARKER = "QH_EXTERNAL_BODY_SECRET=do-not-persist";
const originalFetch = globalThis.fetch;
let prisma = null;

function assertMarkerAbsent(value, label) {
  const ownValues =
    value && typeof value === "object"
      ? Reflect.ownKeys(value).map((key) => {
          try {
            return String(value[key]);
          } catch {
            return "";
          }
        })
      : [];
  const evidence = [
    String(value),
    value instanceof Error ? value.message : "",
    value instanceof Error ? value.stack ?? "" : "",
    JSON.stringify(value),
    ...ownValues,
  ].join("\n");
  assert.equal(evidence.includes(BODY_MARKER), false, `${label} retained the body marker.`);
}

async function captureFailure(work) {
  try {
    await work();
    assert.fail("Expected external API failure.");
  } catch (error) {
    return error;
  }
}

function coupangCredentialContext() {
  return {
    context: {
      channel: "COUPANG",
      providerType: "USB_QHKEY",
      status: "ACTIVE",
      keyAlias: "redaction-test",
      keyFingerprint: "redaction-test-fingerprint",
      expiresAt: "2099-12-31T00:00:00.000Z",
      readEnabled: true,
      writeEnabled: true,
      lastVerifiedAt: "2026-08-05T00:00:00.000Z",
      warningMessage: null,
      errorMessage: null,
      mode: "mock",
      apiHost: "http://127.0.0.1:3199",
      vendorId: "REDATION-TEST-VENDOR",
      timeoutMs: 1000,
    },
    freshness: "CACHED_READ",
    sign() {
      return {
        authorization: "redaction-test-authorization",
        providerType: "USB_QHKEY",
        keyAlias: "redaction-test",
        keyFingerprint: "redaction-test-fingerprint",
        authStatus: "SUCCEEDED",
        warningMessage: null,
      };
    },
  };
}

try {
  const {
    CoupangApiResponseError,
    getCoupangVendorItemInventory,
  } = await import("@/quickhack_server/sales-channel/coupang/api-client");
  const {
    beginCoupangApiCallLog,
    coupangApiCallErrorMessage,
    failCoupangApiCallLog,
    markCoupangApiCallReceived,
  } = await import(
    "@/quickhack_server/sales-channel/coupang/api-call-log-service"
  );
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { logenCarrierClient, LogenApiError } = await import(
    "@/quickhack_server/shipment/carrier-integration/logen/api-client"
  );
  const { runOperationTrace } = await import(
    "@/quickhack_server/observability/operation-trace"
  );
  const credentialContext = coupangCredentialContext();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: "INVALID_RETURN_ACTION",
        message: BODY_MARKER,
        data: { diagnostic: BODY_MARKER },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  const coupangHttpError = await captureFailure(() =>
    getCoupangVendorItemInventory("900000000001", credentialContext, {
      retryCount: 0,
    })
  );
  assert(
    coupangHttpError instanceof CoupangApiResponseError,
    `Unexpected Coupang error type: ${coupangHttpError?.constructor?.name ?? typeof coupangHttpError}: ${coupangHttpError instanceof Error ? coupangHttpError.message : String(coupangHttpError)}`
  );
  assert.equal(coupangHttpError.httpStatusCode, 400);
  assert.equal(coupangHttpError.externalResponseCode, "INVALID_RETURN_ACTION");
  assert.equal("externalResponseMessage" in coupangHttpError, false);
  assert.equal("responseBodyPreview" in coupangHttpError, false);
  assertMarkerAbsent(coupangHttpError, "Coupang HTTP error");
  assertMarkerAbsent(
    coupangApiCallErrorMessage(coupangHttpError),
    "Coupang DB error message"
  );
  const apiCallLogId = await beginCoupangApiCallLog({
    apiName: "getVendorItemInventory",
    endpointPath: "/v2/providers/openapi/apis/api/v4/vendors/test/vendor-items/test",
    externalVendorItemId: "900000000001",
    requestStartedAt: new Date("2026-08-04T15:00:00.000Z"),
  });
  await failCoupangApiCallLog(apiCallLogId, coupangHttpError);
  const persistedApiCallLog = await prisma.coupang_api_call_log.findUniqueOrThrow({
    where: { coupang_api_call_log_id: apiCallLogId },
  });
  assert.equal(persistedApiCallLog.processed_status, "FAILED");
  assert.equal(persistedApiCallLog.http_status_code, 400);
  assert.equal(
    persistedApiCallLog.external_response_code,
    "INVALID_RETURN_ACTION"
  );
  assert.equal(persistedApiCallLog.external_response_message, null);
  assertMarkerAbsent(persistedApiCallLog, "Coupang persisted API call log");

  const successfulApiCallLogId = await beginCoupangApiCallLog({
    apiName: "getOrdersheets",
    endpointPath: "/v2/providers/openapi/apis/api/v5/vendors/test/ordersheets",
    requestStartedAt: new Date("2026-08-04T15:01:00.000Z"),
  });
  await markCoupangApiCallReceived({
    apiCallLogId: successfulApiCallLogId,
    endpointPath:
      "/v2/providers/openapi/apis/api/v5/vendors/test/ordersheets",
    httpStatusCode: 200,
    externalResponseCode: BODY_MARKER,
    externalResponseMessage: BODY_MARKER,
    responseHash: "safe-response-hash",
    receivedAt: new Date("2026-08-04T15:01:01.000Z"),
  });
  const successfulApiCallLog =
    await prisma.coupang_api_call_log.findUniqueOrThrow({
      where: { coupang_api_call_log_id: successfulApiCallLogId },
    });
  assert.equal(successfulApiCallLog.external_response_code, null);
  assert.equal(successfulApiCallLog.external_response_message, null);
  assertMarkerAbsent(successfulApiCallLog, "Coupang successful API call log");

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ code: BODY_MARKER, message: BODY_MARKER }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  const invalidCodeError = await captureFailure(() =>
    getCoupangVendorItemInventory("900000000001", credentialContext, {
      retryCount: 0,
    })
  );
  assert(invalidCodeError instanceof CoupangApiResponseError);
  assert.equal(invalidCodeError.externalResponseCode, null);
  assertMarkerAbsent(invalidCodeError, "Coupang invalid external code");

  globalThis.fetch = async () =>
    new Response(`{"code":"SUCCESS","data":${BODY_MARKER}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const coupangJsonError = await captureFailure(() =>
    getCoupangVendorItemInventory("900000000001", credentialContext, {
      retryCount: 0,
    })
  );
  assert.match(coupangJsonError.message, /Coupang API JSON parse error \(200\)/);
  assertMarkerAbsent(coupangJsonError, "Coupang malformed JSON error");

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: "SUCCESS",
        message: BODY_MARKER,
        data: { amountInStock: BODY_MARKER },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const coupangPayloadError = await captureFailure(() =>
    getCoupangVendorItemInventory("900000000001", credentialContext, {
      retryCount: 0,
    })
  );
  assert.equal(coupangPayloadError.name, "CoupangInventoryPayloadError");
  assert.equal(
    coupangPayloadError.responseMetadata?.externalResponseCode,
    "SUCCESS"
  );
  assert.equal(
    Object.hasOwn(
      coupangPayloadError.responseMetadata ?? {},
      "externalResponseMessage"
    ),
    false
  );
  assertMarkerAbsent(coupangPayloadError, "Coupang malformed payload error");

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: BODY_MARKER }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  const logenHttpError = await captureFailure(() =>
    logenCarrierClient.getContractInfo()
  );
  assert(
    logenHttpError instanceof LogenApiError,
    `Unexpected Logen error type: ${logenHttpError?.constructor?.name ?? typeof logenHttpError}: ${logenHttpError instanceof Error ? logenHttpError.message : String(logenHttpError)}`
  );
  assert.equal(logenHttpError.code, "LOGEN_API_HTTP_ERROR");
  assert.equal(logenHttpError.apiName, "contractTotalInfo");
  assert.equal(logenHttpError.statusCode, 503);
  assertMarkerAbsent(logenHttpError, "Logen HTTP error");

  globalThis.fetch = async () =>
    new Response(`{"data":${BODY_MARKER}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const logenJsonError = await captureFailure(() =>
    logenCarrierClient.getContractInfo()
  );
  assert(logenJsonError instanceof LogenApiError);
  assert.equal(logenJsonError.code, "LOGEN_API_INVALID_RESPONSE");
  assert.equal(logenJsonError.outcomeUncertain, true);
  assertMarkerAbsent(logenJsonError, "Logen malformed JSON error");

  globalThis.fetch = async () =>
    new Response(`<html>${BODY_MARKER}</html>`, {
      status: 500,
      headers: { "content-type": "text/html" },
    });
  const logenHtmlError = await captureFailure(() =>
    logenCarrierClient.getPrintPopupHtml({ takeDate: "20260805" })
  );
  assert(logenHtmlError instanceof LogenApiError);
  assert.equal(logenHtmlError.apiName, "outSlipPrintPop");
  assertMarkerAbsent(logenHtmlError, "Logen HTML error");

  let traceSnapshot = null;
  await assert.rejects(
    runOperationTrace(
      {
        operationName: "test.external-api-error-redaction",
        persist: false,
        onComplete(snapshot) {
          traceSnapshot = snapshot;
        },
      },
      async () => {
        throw coupangHttpError;
      }
    )
  );
  assert.equal(traceSnapshot?.status, "FAILED");
  assertMarkerAbsent(traceSnapshot, "Operation trace");

  console.log("External API error body redaction verified.");
} finally {
  globalThis.fetch = originalFetch;
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
