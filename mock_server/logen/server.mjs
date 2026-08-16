import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackRequest, validateLogenAuth } from "./auth.mjs";
import {
  LOGEN_PUBLIC_APIS,
  logenCapabilities,
} from "./contract.mjs";
import { getLogenMockConfig } from "./config.mjs";
import {
  advanceReturn,
  advanceShipment,
  databaseState,
  openLogenMockDatabase,
  printIlogenOrder,
  recordApiRequest,
  resetLogenMockDatabase,
} from "./database.mjs";
import {
  applyPayloadFailure,
  maybeSendPostProcessingFailure,
  maybeSimulateFailure,
  updateFailurePolicy,
} from "./failure.mjs";
import { startLifecycleGenerators } from "./lifecycle.mjs";
import { readJsonObject, sendHtml, sendJson } from "./response.mjs";
import { buildCoreResponse } from "./routes/core.mjs";
import { buildIlogenPopupHtml, buildIlogenResponse } from "./routes/ilogen.mjs";
import { buildReturnResponse } from "./routes/returns.mjs";
import { buildTrackingResponse } from "./routes/tracking.mjs";

const modulePath = fileURLToPath(import.meta.url);
const publicApisByPath = new Map(LOGEN_PUBLIC_APIS.map((api) => [api.path, api]));
const writeApiPaths = new Set([
  "/lrm02b-edi/edi/getSlipNo",
  "/lrm02b-edi/edi/slipPrintM",
  "/lrm02b-edi/edi/registerOrderData",
  "/lrm02b-edi/edi/registReturnRequest",
]);

function apiTarget(pathname) {
  return pathname.split("/").filter(Boolean).at(-1) || "unknown";
}

function rejectAdminRequest(response) {
  sendJson(response, 403, { ok: false, message: "Admin endpoints are loopback-only." });
}

async function handleAdminRequest(request, response, url, db, config, failurePolicy) {
  if (!url.pathname.startsWith("/admin/")) return false;
  if (!isLoopbackRequest(request)) {
    rejectAdminRequest(response);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/admin/capabilities") {
    sendJson(response, 200, { ok: true, ...logenCapabilities() });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/admin/state") {
    sendJson(response, 200, { ok: true, ...(await databaseState(db)) });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/admin/failure-policy") {
    sendJson(response, 200, { ok: true, failurePolicy });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/admin/failure-policy") {
    const body = await readJsonObject(request);
    updateFailurePolicy(failurePolicy, body);
    sendJson(response, 200, { ok: true, failurePolicy });
    return true;
  }
  if (
    request.method === "POST" &&
    (url.pathname === "/admin/reset" || url.pathname === "/admin/seed")
  ) {
    await resetLogenMockDatabase(db, config);
    sendJson(response, 200, { ok: true, ...(await databaseState(db)) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/admin/ilogen/print") {
    const body = await readJsonObject(request);
    const result = await printIlogenOrder(db, String(body.fixTakeNo ?? "").trim());
    sendJson(response, result.ok ? 200 : 400, result);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/admin/shipments/advance") {
    const body = await readJsonObject(request);
    const result = await advanceShipment(
      db,
      String(body.slipNo ?? "").trim(),
      body.state ? String(body.state).trim() : undefined
    );
    sendJson(response, result.ok ? 200 : 400, result);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/admin/returns/advance") {
    const body = await readJsonObject(request);
    const result = await advanceReturn(
      db,
      String(body.takeNo ?? "").trim(),
      body.status ? String(body.status).trim() : undefined,
      body.delayCd ? String(body.delayCd).trim() : null
    );
    sendJson(response, result.ok ? 200 : 400, result);
    return true;
  }

  sendJson(response, 404, { ok: false, message: `Unknown admin endpoint: ${url.pathname}` });
  return true;
}

async function handleRequest(request, response, db, config, failurePolicy) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "quickhack-logen-mock",
      implementedApis: logenCapabilities().implementedApiCount,
      publicApis: logenCapabilities().publicApiCount,
      databaseProvider: "postgresql",
      database: (await databaseState(db)).counts,
    });
    return;
  }

  if (await handleAdminRequest(request, response, url, db, config, failurePolicy)) {
    return;
  }

  const api = publicApisByPath.get(url.pathname);
  if (!api) {
    sendJson(response, 404, {
      sttsCd: "FAIL",
      sttsMsg: `Unknown mock endpoint: ${request.method} ${url.pathname}`,
    });
    return;
  }

  if (!(await validateLogenAuth(request, response, db))) return;

  if (
    request.method === "GET" &&
    url.pathname === "/lrm02b-edi/edi/outSlipPrintPop"
  ) {
    if (await maybeSimulateFailure(response, failurePolicy, apiTarget(url.pathname))) {
      return;
    }
    sendHtml(response, 200, await buildIlogenPopupHtml(url, db));
    return;
  }

  if (await maybeSimulateFailure(response, failurePolicy, apiTarget(url.pathname))) {
    return;
  }

  let body;
  try {
    body = await readJsonObject(request);
  } catch (error) {
    sendJson(response, 400, {
      sttsCd: "FAIL",
      sttsMsg: `JSON 요청을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const result =
    (await buildCoreResponse(request.method || "GET", url.pathname, body, db)) ||
    (await buildIlogenResponse(request.method || "GET", url.pathname, body, db)) ||
    (await buildReturnResponse(request.method || "GET", url.pathname, body, db)) ||
    (await buildTrackingResponse(request.method || "GET", url.pathname, body, db));
  if (!result) {
    sendJson(response, 500, { sttsCd: "FAIL", sttsMsg: "Mock route configuration error" });
    return;
  }
  const target = apiTarget(url.pathname);
  const responsePayload = applyPayloadFailure(
    failurePolicy,
    target,
    result.payload
  );
  await recordApiRequest(db, {
    method: request.method || "GET",
    endpointPath: url.pathname,
    httpStatus: result.statusCode,
    sttsCd: result.payload?.sttsCd,
    requestBody: body,
    responseBody: responsePayload,
  });
  if (
    maybeSendPostProcessingFailure(
      response,
      failurePolicy,
      target,
      writeApiPaths.has(url.pathname)
    )
  ) {
    return;
  }
  sendJson(response, result.statusCode, responsePayload);
}

export function createLogenMockServer(db, config, failurePolicy) {
  return http.createServer((request, response) => {
    handleRequest(request, response, db, config, failurePolicy).catch((error) => {
      if (!response.writableEnded) {
        sendJson(response, 500, {
          sttsCd: "FAIL",
          sttsMsg: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
}

export async function startLogenMockServer(config = getLogenMockConfig()) {
  const db = await openLogenMockDatabase(config);
  if (config.initDb) {
    await db.close();
    return { initialized: true, config };
  }

  const failurePolicy = { ...config.failurePolicy };
  const server = createLogenMockServer(db, config, failurePolicy);
  const stopLifecycleGenerators = startLifecycleGenerators(db, config);
  server.listen(config.port, config.host, () => {
    console.log(`[logen-mock] listening on http://${config.host}:${config.port}`);
    console.log("[logen-mock] database: PostgreSQL quickhack_mock_logen");
    console.log(`[logen-mock] implemented APIs: ${logenCapabilities().implementedApiCount}/${logenCapabilities().publicApiCount}`);
    console.log(`[logen-mock] admin capabilities: http://${config.host}:${config.port}/admin/capabilities`);
  });

  const shutdown = () => {
    stopLifecycleGenerators();
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return { initialized: false, config, db, server, failurePolicy };
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (path.resolve(modulePath) === executedPath) {
  const result = await startLogenMockServer();
  if (result.initialized) {
    console.log("[logen-mock] PostgreSQL database initialized");
  }
}
