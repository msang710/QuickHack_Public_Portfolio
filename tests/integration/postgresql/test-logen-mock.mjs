import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTemporaryDatabase } from "../../support/postgresql-test-scope.mjs";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(toolDir, "..", "..", "..");
const serverPath = path.join(rootDir, "mock_server", "logen", "server.mjs");
const databaseScope = createTemporaryDatabase("quickhack-logen-mock-");
const port = 33000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const secretKey = "LOGEN-MOCK-CONTRACT-TEST";
let serverOutput = "";

const child = spawn(
  process.execPath,
  [serverPath, "--host", "127.0.0.1", "--port", String(port)],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      QUICKHACK_TEST_LOGEN_MOCK_DATABASE_URL: databaseScope.databaseUrl,
      LOGEN_MOCK_SECRET_KEY: secretKey,
      LOGEN_MOCK_FAILURE_ENABLED: "false",
      LOGEN_MOCK_TRACKING_INTERVAL_MS: "0",
      LOGEN_MOCK_RETURN_INTERVAL_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

child.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Logen mock exited early (${child.exitCode}).\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {
      // Server startup races are expected here.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Logen mock.\n${serverOutput}`);
}

async function request(pathname, body, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.secret !== null) headers.secretKey = options.secret || secretKey;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

function shipmentPayload(slipNo) {
  return {
    userId: "10358007",
    data: {
      printYn: "Y",
      slipNo,
      slipTy: "100",
      orgnSlipNo: "",
      custCd: "20179999",
      sndCustNm: "QuickHack",
      sndTelNo: "0200000001",
      sndCellNo: "01000000001",
      sndZipCd: "",
      sndCustAddr1: "서울시 송파구 테스트로 1",
      sndCustAddr2: "QuickHack 물류센터",
      rcvCustNm: "Mock 고객",
      rcvTelNo: "0200000002",
      rcvCellNo: "01000000002",
      rcvZipCd: "",
      rcvCustAddr1: "강원 정선군 테스트로 1",
      rcvCustAddr2: "예시건물 1층",
      fareTy: "020",
      qty: 1,
      rcvBranCd: "244",
      goodsNm: "테스트 단말기",
      dlvFare: 3000,
      extraFare: 0,
      goodsAmt: 50000,
      jejuAmtTy: "",
      shipYn: "N",
      takeDt: "20260719",
      remarks: "Mock 계약 테스트",
      fixTakeNo: "QH-MOCK-ORDER-0001",
      jejuAmt: 0,
      shipFare: 0,
      montFare: 0,
      wt: 0,
    },
  };
}

function ilogenOrderPayload(fixTakeNo = "QH-ILOGEN-0001") {
  return {
    userId: "10358007",
    data: [
      {
        custCd: "20179999",
        takeDt: "20260719",
        slipNo: "",
        fixTakeNo,
        sndCustNm: "QuickHack",
        sndCustAddr: "서울시 송파구 테스트로 1",
        sndTelNo: "0200000000",
        sndCellNo: "01000000000",
        rcvCustNm: "Mock 고객",
        rcvCustAddr: "충남 부여군 테스트로 2",
        rcvTelNo: "050200000001",
        rcvCellNo: "01000000003",
        fareTy: "030",
        boxTyCd: "WS001",
        qty: 1,
        dlvFare: 3000,
        extraFare: 0,
        goodsNm: "테스트 단말기",
        goodsAmt: 50000,
        mrgYn: "N",
      },
    ],
  };
}

function returnPayload(orgnSlipNo) {
  return {
    userId: "10358007",
    data: [
      {
        orgnSlipNo,
        fixTakeNo: "QH-RETURN-0001",
        custCd: "20179999",
        sndCustNm: "Mock 고객",
        sndTelNo: "01000000000",
        sndCellNo: "01000000000",
        sndCustAddr1: "경기 고양시 테스트로 1",
        sndCustAddr2: "",
        rcvCustNm: "QuickHack",
        rcvTelNo: "01000000009",
        rcvCellNo: "01000000009",
        rcvCustAddr1: "서울시 송파구 테스트로 1",
        rcvCustAddr2: "",
        qty: 1,
        fareTy: "020",
        dlvFare: 5000,
        goodsNm: "테스트 단말기",
        sndMsg: "Mock 반품",
      },
    ],
  };
}

async function run() {
  const health = await waitForHealth();
  assert.equal(health.ok, true);
  assert.equal(health.implementedApis, 16);

  const capabilitiesResponse = await fetch(`${baseUrl}/admin/capabilities`);
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.publicApiCount, 16);
  assert.equal(capabilities.implementedApiCount, 16);
  assert.equal(capabilities.unavailablePublicSpecCount, 3);

  const missingAuth = await request(
    "/lrm02b-edi/edi/contractTotalInfo",
    { userId: "10358007", data: [{ custCd: "20179999" }] },
    { secret: null }
  );
  assert.equal(missingAuth.status, 401);

  const wrongAuth = await request(
    "/lrm02b-edi/edi/contractTotalInfo",
    { userId: "10358007", data: [{ custCd: "20179999" }] },
    { secret: "WRONG" }
  );
  assert.equal(wrongAuth.status, 401);

  const contracts = await request("/lrm02b-edi/edi/contractTotalInfo", {
    userId: "10358007",
    data: [{ custCd: "20179999" }, { custCd: "99999999" }],
  });
  assert.equal(contracts.status, 200);
  assert.equal(contracts.payload.sttsCd, "PARTIAL SUCCESS");
  assert.equal(contracts.payload.data[0].resultCd, "TRUE");
  assert.equal(contracts.payload.data[1].resultCd, "FALSE");

  const fares = await request("/lrm02b-edi/edi/contPickFares", {
    userId: "10358007",
    data: [{ custCd: "20179999", fareTy: "020" }],
  });
  assert.equal(fares.payload.sttsCd, "SUCCESS");
  assert.equal(fares.payload.data[0].resultCd, "SUCCESS");
  assert.equal(fares.payload.data[0].data1[0].dlvFare, 3000);

  const tooMany = await request("/lrm02b-edi/edi/getSlipNo", {
    userId: "10358007",
    data: [{ slipQty: 10000 }],
  });
  assert.equal(tooMany.payload.sttsCd, "FAIL");

  const allocated = await request("/lrm02b-edi/edi/getSlipNo", {
    userId: "10358007",
    data: [{ slipQty: 2 }],
  });
  assert.equal(allocated.payload.sttsCd, "SUCCESS");
  assert.equal(allocated.payload.data.data1.length, 2);
  const slipNo = allocated.payload.data.data1[0].slipNo;
  assert.match(slipNo, /^\d{11}$/);

  const address = await request("/lrm02b-edi/edi/integratedInquiry", {
    userId: "10358007",
    data: [
      { custCd: "20179999", addr: "제주 예시시 테스트로 1" },
      { custCd: "20179999", addr: "강원 정선군 테스트로 1" },
    ],
  });
  assert.equal(address.payload.sttsCd, "SUCCESS");
  assert.equal(address.payload.data[0].jejuRegYn, "Y");
  assert.equal(address.payload.data[1].montYn, "Y");

  const surcharge = await request("/lrm02b-edi/edi/custExtraFare", {
    userId: "10358007",
    data: [
      {
        custCd: "20179999",
        fareTy: "010",
        qty: 1,
        goodsAmt: 15000000,
        dlvFare: 45000,
      },
    ],
  });
  assert.equal(surcharge.payload.data[0].extraFare, 42750);

  const registered = await request(
    "/lrm02b-edi/edi/slipPrintM",
    shipmentPayload(slipNo)
  );
  assert.equal(registered.payload.sttsCd, "SUCCESS");
  assert.equal(registered.payload.data.resultCd, "TRUE");

  const duplicate = await request(
    "/lrm02b-edi/edi/slipPrintM",
    shipmentPayload(slipNo)
  );
  assert.equal(duplicate.payload.sttsCd, "FAIL");
  assert.match(duplicate.payload.data.resultMsg, /이미 사용된 송장번호/);

  const ilogenRegistration = await request(
    "/lrm02b-edi/edi/registerOrderData",
    ilogenOrderPayload()
  );
  assert.equal(ilogenRegistration.payload.sttsCd, "SUCCESS");

  const popupResponse = await fetch(
    `${baseUrl}/lrm02b-edi/edi/outSlipPrintPop?userId=10358007&custCd=20179999&takeDt=20260719`,
    { headers: { secretKey } }
  );
  assert.equal(popupResponse.status, 200);
  assert.match(popupResponse.headers.get("content-type"), /text\/html/);
  assert.match(await popupResponse.text(), /QH-ILOGEN-0001/);

  const printResult = await request("/admin/ilogen/print", {
    fixTakeNo: "QH-ILOGEN-0001",
  });
  assert.equal(printResult.status, 200);
  assert.match(printResult.payload.slipNo, /^\d{11}$/);
  const ilogenSlipNo = printResult.payload.slipNo;

  const invoiceInquiry = await request("/lrm02b-edi/edi/inquirySlipNoMulti", {
    userId: "10358007",
    data: [{ custCd: "20179999", fixTakeNo: "QH-ILOGEN-0001" }],
  });
  assert.equal(invoiceInquiry.payload.data[0].data1[0].slipNo, ilogenSlipNo);

  const initialTracking = await request("/lrm02b-edi/edi/inquiryCargoTrackingMulti", {
    userId: "10358007",
    data: [{ slipNo }],
  });
  assert.equal(initialTracking.payload.data[0].data1[0].statNm, "송장등록");

  const pickedUp = await request("/admin/shipments/advance", { slipNo });
  assert.equal(pickedUp.payload.state, "PICKED_UP");

  const exception = await request("/admin/shipments/advance", {
    slipNo,
    state: "EXCEPTION",
  });
  assert.equal(exception.payload.state, "EXCEPTION");
  assert.equal(exception.payload.statusName, "미배송");
  const exceptionTracking = await request(
    "/lrm02b-edi/edi/inquiryCargoTrackingMultiLast",
    { userId: "10358007", data: [{ slipNo }] }
  );
  assert.equal(exceptionTracking.payload.data[0].statNm, "미배송");

  const recovered = await request("/admin/shipments/advance", {
    slipNo,
    state: "IN_TRANSIT",
  });
  assert.equal(recovered.payload.state, "IN_TRANSIT");
  assert.equal(recovered.payload.statusName, "간선상차");

  await request("/admin/shipments/advance", { slipNo });
  await request("/admin/shipments/advance", { slipNo });
  const latestTracking = await request(
    "/lrm02b-edi/edi/inquiryCargoTrackingMultiLast",
    { userId: "10358007", data: [{ slipNo }] }
  );
  assert.equal(latestTracking.payload.data[0].statNm, "배송완료");
  assert.equal(latestTracking.payload.data[0].resultCd, "TRUE");

  const reverseFare = await request("/lrm02b-edi/edi/reverseChkInfoMulti", {
    userId: "10358007",
    data: [{ custCd: "20179999", orgnSlipNo: slipNo }],
  });
  assert.equal(reverseFare.payload.data[0].dlvFare, 4000);

  const returnRegistration = await request(
    "/lrm02b-edi/edi/registReturnRequest",
    returnPayload(slipNo)
  );
  assert.equal(returnRegistration.payload.sttsCd, "SUCCESS");
  const takeNo = returnRegistration.payload.data[0].takeNo;
  assert.match(takeNo, /^\d{12}$/);

  const duplicateReturn = await request(
    "/lrm02b-edi/edi/registReturnRequest",
    returnPayload(slipNo)
  );
  assert.equal(duplicateReturn.payload.sttsCd, "FAIL");
  assert.match(duplicateReturn.payload.data[0].resultMsg, /반품이중등록/);

  const returnByReceipt = await request(
    "/lrm02b-edi/edi/inquiryReserveStateMulti",
    { userId: "10358007", data: [{ custCd: "20179999", takeNo }] }
  );
  assert.equal(returnByReceipt.payload.data[0].resvStat, "10");
  const returnSlipNo = returnByReceipt.payload.data[0].slipNo;

  const returnByOrder = await request(
    "/lrm02b-edi/edi/inquiryReserveStateFixTakeNo",
    {
      userId: "10358007",
      data: [{ custCd: "20179999", fixTakeNo: "QH-RETURN-0001" }],
    }
  );
  assert.equal(returnByOrder.payload.data[0].takeNo, takeNo);

  const returnByOriginal = await request(
    "/lrm02b-edi/edi/inquiryReturnStateMulti",
    { userId: "10358007", data: [{ custCd: "20179999", orgnSlipNo: slipNo }] }
  );
  assert.equal(returnByOriginal.payload.data[0].data1[0].takeNo, takeNo);

  await request("/admin/returns/advance", { takeNo });
  await request("/admin/returns/advance", { takeNo });
  const completedReturn = await request(
    "/lrm02b-edi/edi/inquiryReserveStateMulti",
    { userId: "10358007", data: [{ custCd: "20179999", takeNo }] }
  );
  assert.equal(completedReturn.payload.data[0].resvStat, "40");
  assert.match(completedReturn.payload.data[0].procDt, /^\d{8}$/);

  const returnTracking = await request(
    "/lrm02b-edi/edi/inquiryCargoTrackingMulti",
    { userId: "10358007", data: [{ slipNo: returnSlipNo }] }
  );
  assert.equal(returnTracking.payload.data[0].data1.at(-1).statNm, "반품집하완료");

  const stateResponse = await fetch(`${baseUrl}/admin/state`);
  const state = await stateResponse.json();
  assert.equal(state.counts.allocations, 4);
  assert.equal(state.counts.shipments, 2);
  assert.equal(state.counts.ilogenOrders, 1);
  assert.equal(state.counts.returns, 1);
  assert.ok(state.counts.trackingEvents >= 9);
  assert.ok(state.counts.requestLogs >= 18);

  const enableFailure = await request("/admin/failure-policy", {
    enabled: true,
    target: "contractTotalInfo",
    httpFailureRate: 100,
    httpStatus: 503,
  });
  assert.equal(enableFailure.payload.failurePolicy.enabled, true);
  const simulatedFailure = await request(
    "/lrm02b-edi/edi/contractTotalInfo",
    { userId: "10358007", data: [{ custCd: "20179999" }] }
  );
  assert.equal(simulatedFailure.status, 503);
  await request("/admin/failure-policy", {
    enabled: false,
    httpFailureRate: 0,
  });

  await request("/admin/failure-policy", {
    enabled: true,
    target: "registerOrderData",
    writeAppliedResponseFailureRate: 100,
    httpFailureRate: 0,
    httpStatus: 503,
  });
  const lostWriteResponse = await request(
    "/lrm02b-edi/edi/registerOrderData",
    ilogenOrderPayload("QH-ILOGEN-0002")
  );
  assert.equal(lostWriteResponse.status, 503);
  assert.match(lostWriteResponse.payload.sttsMsg, /was applied/);
  await request("/admin/failure-policy", {
    enabled: false,
    writeAppliedResponseFailureRate: 0,
  });
  const reconciledWrite = await request("/lrm02b-edi/edi/inquirySlipNoMulti", {
    userId: "10358007",
    data: [{ custCd: "20179999", fixTakeNo: "QH-ILOGEN-0002" }],
  });
  assert.equal(reconciledWrite.payload.data[0].resultCd, "TRUE");

  await request("/admin/failure-policy", {
    enabled: true,
    target: "inquiryCargoTrackingMultiLast",
    malformedJsonRate: 100,
  });
  const malformedResponse = await fetch(
    `${baseUrl}/lrm02b-edi/edi/inquiryCargoTrackingMultiLast`,
    {
      method: "POST",
      headers: { "content-type": "application/json", secretKey },
      body: JSON.stringify({ userId: "10358007", data: [{ slipNo }] }),
    }
  );
  const malformedText = await malformedResponse.text();
  assert.equal(malformedResponse.status, 200);
  assert.throws(() => JSON.parse(malformedText));
  await request("/admin/failure-policy", { enabled: false, malformedJsonRate: 0 });

  await request("/admin/failure-policy", {
    enabled: true,
    target: "contractTotalInfo",
    missingRequiredFieldRate: 100,
  });
  const missingField = await request("/lrm02b-edi/edi/contractTotalInfo", {
    userId: "10358007",
    data: [{ custCd: "20179999" }],
  });
  assert.equal("resultCd" in missingField.payload.data[0], false);
  await request("/admin/failure-policy", {
    enabled: false,
    missingRequiredFieldRate: 0,
  });

  await request("/admin/failure-policy", {
    enabled: true,
    target: "contractTotalInfo",
    partialDataLossRate: 100,
  });
  const partialLoss = await request("/lrm02b-edi/edi/contractTotalInfo", {
    userId: "10358007",
    data: [{ custCd: "20179999" }, { custCd: "20179999" }],
  });
  assert.equal(partialLoss.payload.data.length, 1);
  await request("/admin/failure-policy", {
    enabled: false,
    partialDataLossRate: 0,
  });

  await request("/admin/failure-policy", {
    enabled: true,
    target: "contractTotalInfo",
    timeoutRate: 100,
    timeoutMs: 10,
  });
  const timedOut = await request("/lrm02b-edi/edi/contractTotalInfo", {
    userId: "10358007",
    data: [{ custCd: "20179999" }],
  });
  assert.equal(timedOut.status, 504);
  await request("/admin/failure-policy", {
    enabled: false,
    timeoutRate: 0,
  });

  const reset = await request("/admin/reset", {});
  assert.equal(reset.status, 200);
  assert.equal(reset.payload.counts.allocations, 0);
  assert.equal(reset.payload.counts.shipments, 0);

  console.log("Logen mock contract tests passed.");
}

try {
  await run();
} catch (error) {
  console.error(error);
  console.error(serverOutput);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const gracefulExit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([gracefulExit, sleep(2000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    const forcedExit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await forcedExit;
  }
  databaseScope.cleanup();
}
