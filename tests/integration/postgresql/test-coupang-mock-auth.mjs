import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { issueMockCoupangCredential } from "../../../tools/mock-coupang-credential-client.mjs";
import { createTemporaryDatabase } from "../../support/postgresql-test-scope.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let baseUrl = String(process.argv[2] || "").replace(/\/+$/, "");

async function startTestMockServer() {
  if (baseUrl) {
    return null;
  }

  const port = 3111;
  const databaseScope = createTemporaryDatabase("quickhack-mock-auth-");
  const child = spawn(
    process.execPath,
    [
      path.join(rootDir, "mock_server", "coupang-mock-server.mjs"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--order-interval-ms",
      "0",
      "--return-exchange-interval-ms",
      "0",
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_ENV: "test",
        QUICKHACK_TEST_COUPANG_MOCK_DATABASE_URL: databaseScope.databaseUrl,
        COUPANG_MOCK_FAILURE_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  baseUrl = `http://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Mock server exited before test startup. ${stderr}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);

      if (response.ok) {
        return { child, databaseScope };
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  child.kill();
  databaseScope.cleanup();
  throw new Error(`Mock server did not become ready. ${stderr}`);
}

function signedDate(date = new Date()) {
  const iso = date.toISOString();

  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function authorization(input) {
  const date = input.signedDate || signedDate();
  const message = `${date}${input.method}${input.path}${input.query}`;
  const signature = crypto
    .createHmac("sha256", input.secretKey)
    .update(message)
    .digest("hex");

  return `CEA algorithm=HmacSHA256, access-key=${input.accessKey}, signed-date=${date}, signature=${signature}`;
}

async function apiRequest(credential, overrides = {}) {
  const vendorId = overrides.vendorId || credential.vendorId;
  const path = `/v2/providers/openapi/apis/api/v5/vendors/${vendorId}/ordersheets`;
  const query = "createdAtFrom=2026-07-13&createdAtTo=2026-07-13&status=ACCEPT&maxPerPage=1";

  return signedApiRequest(credential, {
    ...overrides,
    path,
    query,
  });
}

async function signedApiRequest(credential, overrides) {
  const method = overrides.method || "GET";
  const path = overrides.path;
  const query = overrides.query || "";
  const auth = authorization({
    method,
    path,
    query,
    accessKey: credential.accessKey,
    secretKey: overrides.secretKey || credential.secretKey,
    signedDate: overrides.signedDate,
  });

  return fetch(`${baseUrl}${path}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      authorization: auth,
      ...(overrides.body ? { "content-type": "application/json" } : {}),
    },
    body: overrides.body,
  });
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}.`);
  }
}

async function readFailurePolicy() {
  const response = await fetch(`${baseUrl}/admin/failure-policy`);
  assertStatus(response, 200, "read failure policy");
  const payload = await response.json();

  return payload.failurePolicy;
}

async function updateFailurePolicy(patch) {
  const response = await fetch(`${baseUrl}/admin/failure-policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  assertStatus(response, 200, "update failure policy");
  const payload = await response.json();

  return payload.failurePolicy;
}

async function applyClaimScenario(input) {
  const response = await fetch(`${baseUrl}/admin/claim-scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  assertStatus(response, 200, `claim scenario ${input.action}`);

  return response.json();
}

async function main() {
  const first = await issueMockCoupangCredential({ baseUrl });
  const resetResponse = await fetch(
    `${baseUrl}/admin/reset?orderCount=12&returnExchangeCount=8`,
    { method: "POST" }
  );
  assertStatus(resetResponse, 200, "mock fixture reset");
  const unsignedPath = `/v2/providers/openapi/apis/api/v5/vendors/${first.vendorId}/ordersheets`;
  assertStatus(
    await fetch(`${baseUrl}${unsignedPath}?status=ACCEPT`),
    401,
    "missing authorization"
  );
  assertStatus(await apiRequest(first), 200, "valid signature");
  const ordersheetListResponse = await apiRequest(first);
  assertStatus(ordersheetListResponse, 200, "ordersheet list for single query");
  const ordersheetList = await ordersheetListResponse.json();
  const orderId = String(ordersheetList.data?.[0]?.orderId || "");

  if (!orderId) {
    throw new Error("Mock ordersheet list did not provide an orderId.");
  }

  const singleOrdersheetPath =
    `/v2/providers/openapi/apis/api/v5/vendors/${first.vendorId}/${orderId}/ordersheets`;
  const singleOrdersheetResponse = await signedApiRequest(first, {
    path: singleOrdersheetPath,
  });
  assertStatus(singleOrdersheetResponse, 200, "single ordersheet query");
  const singleOrdersheet = await singleOrdersheetResponse.json();

  if (
    !Array.isArray(singleOrdersheet.data) ||
    !singleOrdersheet.data.some((row) => String(row.orderId) === orderId)
  ) {
    throw new Error("Single ordersheet query did not return the requested order.");
  }

  const targetOrder = singleOrdersheet.data.find(
    (row) => String(row.orderId) === orderId
  );
  const shipmentBoxId = String(targetOrder?.shipmentBoxId || "");
  const vendorItemId = String(targetOrder?.orderItems?.[0]?.vendorItemId || "");
  if (!shipmentBoxId || !vendorItemId) {
    throw new Error("Mock ordersheet did not provide an invoice upload target.");
  }

  const acknowledgementPath =
    `/v2/providers/openapi/apis/api/v4/vendors/${first.vendorId}` +
    "/ordersheets/acknowledgement";
  const acknowledgementResponse = await signedApiRequest(first, {
    method: "PATCH",
    path: acknowledgementPath,
    body: JSON.stringify({ vendorId: first.vendorId, shipmentBoxIds: [shipmentBoxId] }),
  });
  assertStatus(acknowledgementResponse, 200, "ordersheet acknowledgement");
  const acknowledgement = await acknowledgementResponse.json();
  if (acknowledgement.data?.responseCode !== 0) {
    throw new Error("Mock ordersheet acknowledgement did not succeed.");
  }

  const invoiceNumber = "12345678901";
  const invoicePath =
    `/v2/providers/openapi/apis/api/v4/vendors/${first.vendorId}/orders/invoices`;
  const invoiceResponse = await signedApiRequest(first, {
    method: "POST",
    path: invoicePath,
    body: JSON.stringify({
      vendorId: first.vendorId,
      orderSheetInvoiceApplyDtos: [
        {
          shipmentBoxId,
          orderId,
          vendorItemId,
          deliveryCompanyCode: "KGB",
          invoiceNumber,
          splitShipping: false,
          preSplitShipped: false,
          estimatedShippingDate: "",
        },
      ],
    }),
  });
  assertStatus(invoiceResponse, 200, "invoice upload");
  const invoiceResult = await invoiceResponse.json();
  if (invoiceResult.data?.responseCode !== 0) {
    throw new Error("Mock invoice upload did not succeed.");
  }

  const verifiedOrderResponse = await signedApiRequest(first, {
    path: singleOrdersheetPath,
  });
  assertStatus(verifiedOrderResponse, 200, "invoice verification read");
  const verifiedOrder = (await verifiedOrderResponse.json()).data?.find(
    (row) => String(row.orderId) === orderId
  );
  if (
    verifiedOrder?.status !== "DEPARTURE" ||
    String(verifiedOrder?.invoiceNumber || "") !== invoiceNumber ||
    verifiedOrder?.deliveryCompanyName !== "로젠택배"
  ) {
    throw new Error("Mock invoice upload was not reflected in the targeted order read.");
  }

  const replacementInvoiceNumber = "12345678902";
  const invoiceUpdatePath =
    `/v2/providers/openapi/apis/api/v4/vendors/${first.vendorId}` +
    "/orders/updateInvoices";
  const invoiceUpdateResponse = await signedApiRequest(first, {
    method: "POST",
    path: invoiceUpdatePath,
    body: JSON.stringify({
      vendorId: first.vendorId,
      orderSheetInvoiceApplyDtos: [
        {
          shipmentBoxId,
          orderId,
          vendorItemId,
          deliveryCompanyCode: "KGB",
          invoiceNumber: replacementInvoiceNumber,
          splitShipping: false,
          preSplitShipped: false,
          estimatedShippingDate: "",
        },
      ],
    }),
  });
  assertStatus(invoiceUpdateResponse, 200, "invoice update");
  const invoiceUpdateResult = await invoiceUpdateResponse.json();
  if (invoiceUpdateResult.data?.responseCode !== 0) {
    throw new Error("Mock invoice update did not succeed.");
  }

  const replacementVerificationResponse = await signedApiRequest(first, {
    path: singleOrdersheetPath,
  });
  assertStatus(
    replacementVerificationResponse,
    200,
    "replacement invoice verification read"
  );
  const replacementVerifiedOrder = (
    await replacementVerificationResponse.json()
  ).data?.find((row) => String(row.orderId) === orderId);
  if (
    replacementVerifiedOrder?.status !== "DEPARTURE" ||
    String(replacementVerifiedOrder?.invoiceNumber || "") !==
      replacementInvoiceNumber
  ) {
    throw new Error(
      "Mock invoice update did not preserve DEPARTURE and replace the invoice number."
    );
  }

  const returnListPath =
    `/v2/providers/openapi/apis/api/v6/vendors/${first.vendorId}/returnRequests`;
  const returnListResponse = await signedApiRequest(first, {
    path: returnListPath,
    query: "status=RU&cancelType=RETURN&maxPerPage=50",
  });
  assertStatus(returnListResponse, 200, "return request list");
  const returnList = await returnListResponse.json();
  const returnOrderId = String(returnList.data?.[0]?.orderId || "");
  const returnReceiptId = String(returnList.data?.[0]?.receiptId || "");

  if (returnOrderId) {
    const targetedReturnQuery =
      `searchType=orderId&orderId=${encodeURIComponent(returnOrderId)}` +
      "&cancelType=RETURN&maxPerPage=50";
    const targetedReturnResponse = await signedApiRequest(first, {
      path: returnListPath,
      query: targetedReturnQuery,
    });
    assertStatus(targetedReturnResponse, 200, "order-scoped return query");
    const targetedReturns = await targetedReturnResponse.json();

    if (
      !Array.isArray(targetedReturns.data) ||
      !targetedReturns.data.every(
        (row) => String(row.orderId) === returnOrderId
      )
    ) {
      throw new Error("Order-scoped return query leaked another order.");
    }
  }

  const allCancelTypesResponse = await signedApiRequest(first, {
    path: returnListPath,
    query: "status=RU&maxPerPage=50",
  });
  assertStatus(allCancelTypesResponse, 200, "return list without cancelType");
  const allCancelTypes = await allCancelTypesResponse.json();
  const cancelTypes = new Set(
    (allCancelTypes.data || []).map((row) => String(row.receiptType))
  );

  if (!cancelTypes.has("RETURN") || !cancelTypes.has("CANCEL")) {
    throw new Error(
      "Return query without cancelType did not include both RETURN and CANCEL."
    );
  }

  const cancelOnlyResponse = await signedApiRequest(first, {
    path: returnListPath,
    query: "status=RU&cancelType=CANCEL&maxPerPage=50",
  });
  assertStatus(cancelOnlyResponse, 200, "CANCEL-only return list");
  const cancelOnly = await cancelOnlyResponse.json();

  if (
    !Array.isArray(cancelOnly.data) ||
    cancelOnly.data.length === 0 ||
    !cancelOnly.data.every((row) => row.receiptType === "CANCEL")
  ) {
    throw new Error("Explicit CANCEL return query returned another receipt type.");
  }

  if (!returnReceiptId) {
    throw new Error("Mock return list did not provide a receiptId.");
  }

  const changedReturn = await applyClaimScenario({
    action: "RETURN_CHANGED",
    receiptId: returnReceiptId,
    status: "VENDOR_WAREHOUSE_CONFIRM",
    faultByType: "VENDOR",
  });

  if (
    changedReturn.claim?.receiptStatus !== "VENDOR_WAREHOUSE_CONFIRM" ||
    changedReturn.claim?.faultByType !== "VENDOR"
  ) {
    throw new Error("RETURN_CHANGED scenario did not mutate the return snapshot.");
  }

  const exchangeListPath =
    `/v2/providers/openapi/apis/api/v4/vendors/${first.vendorId}/exchangeRequests`;
  const exchangeListResponse = await signedApiRequest(first, {
    path: exchangeListPath,
    query: "maxPerPage=50",
  });
  assertStatus(exchangeListResponse, 200, "exchange request list");
  const exchangeList = await exchangeListResponse.json();
  const exchangeId = String(exchangeList.data?.[0]?.exchangeId || "");

  if (!exchangeId) {
    throw new Error("Mock exchange list did not provide an exchangeId.");
  }

  const changedExchange = await applyClaimScenario({
    action: "EXCHANGE_CHANGED",
    exchangeId,
    status: "SUCCESS",
    faultType: "VENDOR",
    reasonEtcDetail: "Mock changed exchange",
  });

  if (
    changedExchange.claim?.exchangeStatus !== "SUCCESS" ||
    changedExchange.claim?.faultType !== "VENDOR"
  ) {
    throw new Error("EXCHANGE_CHANGED scenario did not mutate the exchange snapshot.");
  }

  const withdrawnReturn = await applyClaimScenario({
    action: "RETURN_WITHDRAWN",
    receiptId: returnReceiptId,
  });
  const withdrawnAt = String(withdrawnReturn.withdrawal?.createdAt || "");
  const withdrawalDate = withdrawnAt.slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(withdrawalDate)) {
    throw new Error("RETURN_WITHDRAWN scenario did not provide a valid date.");
  }

  const withdrawalPath =
    `/v2/providers/openapi/apis/api/v4/vendors/${first.vendorId}/returnWithdrawRequests`;
  const withdrawalQuery =
    `dateFrom=${withdrawalDate}&dateTo=${withdrawalDate}` +
    "&pageIndex=1&sizePerPage=1";
  const withdrawalResponse = await signedApiRequest(first, {
    path: withdrawalPath,
    query: withdrawalQuery,
  });
  assertStatus(withdrawalResponse, 200, "return withdrawal list");
  const withdrawalList = await withdrawalResponse.json();

  if (
    !Array.isArray(withdrawalList.data) ||
    withdrawalList.data.length !== 1 ||
    withdrawalList.data[0]?.vendorId !== first.vendorId
  ) {
    throw new Error("Return withdrawal list did not return the signed vendor page.");
  }

  const invalidWithdrawalResponse = await signedApiRequest(first, {
    path: withdrawalPath,
    query:
      "dateFrom=2026-07-01&dateTo=2026-07-08&pageIndex=1&sizePerPage=100",
  });
  assertStatus(invalidWithdrawalResponse, 400, "return withdrawal range limit");

  assertStatus(
    await apiRequest(first, { secretKey: "incorrect-secret" }),
    401,
    "invalid signature"
  );
  assertStatus(
    await apiRequest(first, {
      signedDate: signedDate(new Date(Date.now() - 10 * 60 * 1000)),
    }),
    401,
    "stale signed-date"
  );
  assertStatus(
    await apiRequest(first, { vendorId: "A99999999" }),
    401,
    "vendor mismatch"
  );

  const publicStatusResponse = await fetch(`${baseUrl}/admin/openapi-credentials`);
  assertStatus(publicStatusResponse, 200, "public credential status");
  const publicStatus = await publicStatusResponse.json();

  if (
    Object.hasOwn(publicStatus.credential || {}, "accessKey") ||
    Object.hasOwn(publicStatus.credential || {}, "secretKey")
  ) {
    throw new Error("Public credential status exposed credential material.");
  }

  const second = await issueMockCoupangCredential({ baseUrl });
  assertStatus(await apiRequest(first), 401, "revoked credential");
  assertStatus(await apiRequest(second), 200, "replacement credential");

  const originalFailurePolicy = await readFailurePolicy();

  try {
    const teapotPolicy = await updateFailurePolicy({
      enabled: true,
      target: "ordersheets",
      randomFailureRate: 0,
      serverErrorRate: 0,
      rateLimitRate: 0,
      teapotRate: 100,
      timeoutRate: 0,
      responseDelayRate: 0,
      malformedJsonRate: 0,
      missingRequiredFieldRate: 0,
      partialDataLossRate: 0,
      writeAppliedResponseFailureRate: 0,
    });

    if (teapotPolicy.teapotRate !== 100) {
      throw new Error("Coupang mock did not enable the teapot failure policy.");
    }

    const teapotResponse = await apiRequest(second);
    assertStatus(teapotResponse, 418, "teapot failure");
    const teapotPayload = await teapotResponse.json();

    if (
      teapotPayload.code !== 418 ||
      teapotPayload.message !== "I'm a teapot"
    ) {
      throw new Error("Coupang mock returned an invalid teapot error payload.");
    }
  } finally {
    await updateFailurePolicy(originalFailurePolicy);
  }

  console.log("Coupang mock credential and HMAC integration passed.");
}

async function run() {
  const managedServer = await startTestMockServer();

  try {
    await main();
  } finally {
    if (managedServer) {
      if (managedServer.child.exitCode === null) {
        await new Promise((resolve) => {
          managedServer.child.once("exit", resolve);
          managedServer.child.kill();
        });
      }
      managedServer.databaseScope.cleanup();
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
