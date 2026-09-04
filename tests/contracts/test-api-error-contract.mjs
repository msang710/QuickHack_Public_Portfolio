import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { apiErrorResponse, apiFailureResponse } = await import(
  "@/quickhack_server/api/error-response"
);
const { publicBadRequest, publicConflict, publicForbidden } = await import(
  "@/quickhack_server/core/public-error"
);
const { runOperationTrace } = await import(
  "@/quickhack_server/observability/operation-trace"
);

async function expectPublicInputError(label, work) {
  try {
    await work();
    assert.fail(`${label} did not reject invalid input.`);
  } catch (error) {
    assert.equal(
      error?.name === "PublicError" || error?.status === 400,
      true,
      `${label} must classify expected input failures as public 400 errors.`
    );
    assert.equal(error.status, 400);
    assert.match(error.code, /^[A-Z0-9_]+$/);
  }
}

let publicSnapshot = null;
const publicResponse = await runOperationTrace(
  {
    operationName: "test.api-error.public",
    source: "HTTP",
    route: "/api/test/public-error",
    method: "POST",
    persist: false,
    onComplete(snapshot) {
      publicSnapshot = snapshot;
    },
  },
  () =>
    apiErrorResponse(
      publicConflict(
        "inventory stale state",
        "다른 작업자가 먼저 재고를 변경했습니다.",
        { pgNo: "PG0000000001" }
      )
    )
);
const publicBody = await publicResponse.json();

assert.equal(publicResponse.status, 409);
assert.equal(publicBody.ok, false);
assert.equal(publicBody.code, "INVENTORY_STALE_STATE");
assert.equal(publicBody.message, undefined);
assert.deepEqual(publicBody.details, { pgNo: "PG0000000001" });
assert.match(publicBody.traceId, /^[0-9a-f-]{36}$/);
assert.equal(
  publicResponse.headers.get("x-quickhack-trace-id"),
  publicBody.traceId
);
assert.equal(publicSnapshot?.errorCode, "INVENTORY_STALE_STATE");

const forbiddenResponse = apiErrorResponse(
  publicForbidden(
    "sensitive action forbidden",
    "민감 작업을 인증할 권한이 없습니다."
  )
);
const forbiddenBody = await forbiddenResponse.json();
assert.equal(forbiddenResponse.status, 403);
assert.equal(forbiddenBody.code, "SENSITIVE_ACTION_FORBIDDEN");

const internalSecret =
  "postgres://runtime:do-not-expose@127.0.0.1:5432/quickhack";
let internalSnapshot = null;
const internalResponse = await runOperationTrace(
  {
    operationName: "test.api-error.internal",
    source: "HTTP",
    route: "/api/test/internal-error",
    method: "GET",
    persist: false,
    onComplete(snapshot) {
      internalSnapshot = snapshot;
    },
  },
  () => apiErrorResponse(new Error(internalSecret))
);
const internalBody = await internalResponse.json();

assert.equal(internalResponse.status, 500);
assert.equal(internalBody.ok, false);
assert.equal(internalBody.code, "INTERNAL_ERROR");
assert.equal(internalBody.message, undefined);
assert.equal(JSON.stringify(internalBody).includes("do-not-expose"), false);
assert.equal(JSON.stringify(internalBody).includes("do-not-expose"), false);
assert.equal(
  internalResponse.headers.get("x-quickhack-trace-id"),
  internalBody.traceId
);
assert.equal(internalSnapshot?.errorCode, "INTERNAL_ERROR");
assert.equal(
  internalSnapshot?.errorMessage.includes("quickhack"),
  true,
  "The internal trace must retain diagnostic context."
);
assert.equal(
  internalSnapshot?.errorMessage.includes("do-not-expose"),
  false,
  "Known credential-like values must still be redacted in traces."
);

const sensitiveResponse = await runOperationTrace(
  {
    operationName: "test.api-error.sensitive-auth",
    persist: false,
  },
  () =>
    apiFailureResponse({
      status: 403,
      code: "SENSITIVE_AUTH_REQUIRED",
      extra: {
        sensitiveAuthRequired: true,
        sensitiveAction: "inventory_edit",
      },
    })
);
const sensitiveBody = await sensitiveResponse.json();

assert.equal(sensitiveBody.code, "SENSITIVE_AUTH_REQUIRED");
assert.equal(sensitiveBody.message, undefined);
assert.equal(sensitiveBody.sensitiveAuthRequired, true);
assert.equal(sensitiveBody.sensitiveAction, "inventory_edit");

const directResponse = apiErrorResponse(
  publicBadRequest("invalid request", "입력값이 올바르지 않습니다.")
);
const directBody = await directResponse.json();
assert.equal(directResponse.status, 400);
assert.equal(directBody.code, "INVALID_REQUEST");
assert.equal(
  directResponse.headers.get("x-quickhack-trace-id"),
  directBody.traceId
);

const testUser = {
  userId: 1,
  username: "api-contract-test",
  role: "MANAGER",
  displayName: "API contract test",
  isDeveloper: true,
};
const emptyClient = {};
const [inventoryManagement, inventoryCorrection, inventoryAudit] =
  await Promise.all([
    import("@/quickhack_server/inventory/inventory-management-service"),
    import("@/quickhack_server/inventory/inventory-correction-command-service"),
    import("@/quickhack_server/inventory/inventory-audit-service"),
  ]);
const [inboundBatch, purchaseConfirm, purchaseExport, purchasePrice] =
  await Promise.all([
    import("@/quickhack_server/inbound/inbound-batch-service"),
    import("@/quickhack_server/inbound/purchase-confirm-service"),
    import("@/quickhack_server/inbound/purchase-export-service"),
    import("@/quickhack_server/inbound/purchase-price-service"),
  ]);

await expectPublicInputError("manual inventory create", () =>
  inventoryManagement.createManualInventoryRecord(
    emptyClient,
    {},
    testUser
  )
);
await expectPublicInputError("inventory correction", () =>
  inventoryCorrection.updateExistingInventoryRecord(
    emptyClient,
    "",
    {},
    testUser
  )
);
await expectPublicInputError("inventory audit", () =>
  inventoryAudit.saveInventoryAuditLocations(
    emptyClient,
    {},
    testUser
  )
);
await expectPublicInputError("inbound batch create", () =>
  inboundBatch.createInboundBatch(emptyClient, {}, testUser)
);
await expectPublicInputError("purchase confirmation", () =>
  purchaseConfirm.confirmInboundPurchases(emptyClient, {}, testUser)
);
await expectPublicInputError("purchase export", () =>
  purchaseExport.buildPurchaseExportWorkbook(emptyClient, {})
);
await expectPublicInputError("purchase price save", () =>
  purchasePrice.savePurchasePriceRates(emptyClient, {}, testUser)
);

const migratedRoutePaths = [
  "quickhack_server/api/inventory/device-list.ts",
  "quickhack_server/api/inventory/audit-candidates.ts",
  "quickhack_server/api/inbound/purchase-pending.ts",
  "quickhack_server/api/inventory/audit.ts",
  "quickhack_server/api/inventory/bulk-correction.ts",
  "quickhack_server/api/inventory/device.ts",
  "quickhack_server/api/inventory/inbound-reconciliation.ts",
  "quickhack_server/api/inventory/quantity-ledger.ts",
  "quickhack_server/api/inventory/quantity-ledger-movements.ts",
  "quickhack_server/api/inbound/batches.ts",
  "quickhack_server/api/inbound/purchase-confirm.ts",
  "quickhack_server/api/inbound/purchase-export.ts",
  "quickhack_server/api/inbound/purchase-prices.ts",
];

for (const relativePath of migratedRoutePaths) {
  const source = readFileSync(path.join(projectRoot, relativePath), "utf8");
  assert.equal(
    source.includes("apiFailureResponse"),
    true,
    `${relativePath} must use the shared failure contract.`
  );
  assert.equal(
    source.includes("error instanceof Error ? error.message"),
    false,
    `${relativePath} must not expose raw exception messages.`
  );
  assert.equal(
    /message\s*:\s*error\s+instanceof\s+Error[\s\S]{0,120}?error\.message/.test(source),
    false,
    `${relativePath} must not expose multiline raw exception messages.`
  );
  assert.equal(
    source.includes("String(error)"),
    false,
    `${relativePath} must not stringify unknown exceptions into responses.`
  );
}

function listTypeScriptFiles(rootPath) {
  return readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

const apiRoots = [
  path.join(projectRoot, "quickhack_server", "api"),
  path.join(projectRoot, "app", "api"),
];
const sharedHelperPath = path.join(
  projectRoot,
  "quickhack_server",
  "api",
  "error-response.ts"
);

for (const filePath of apiRoots.flatMap(listTypeScriptFiles)) {
  if (filePath === sharedHelperPath) continue;
  const source = readFileSync(filePath, "utf8");
  const relativePath = path.relative(projectRoot, filePath);
  assert.equal(
    source.includes("error instanceof Error ? error.message"),
    false,
    `${relativePath} must not expose raw exception messages.`
  );
  assert.equal(
    source.includes("String(error)"),
    false,
    `${relativePath} must not stringify unknown exceptions into responses.`
  );
}

console.log("QuickHack API error response contracts verified.");
