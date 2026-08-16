import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import {
  createInventoryCatalogFixture,
  createSellableDeviceFixtures,
} from "../../support/inventory-business-fixtures.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-inventory-quantity-api-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

function request(path, token) {
  return new NextRequest(`http://localhost${path}`, {
    headers: token
      ? { cookie: `quickhack_session=${token}` }
      : undefined,
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const authService = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const ledgerService = await import(
    "@/quickhack_server/inventory/inventory-quantity-ledger-service"
  );
  const movementApi = await import(
    "@/quickhack_server/api/inventory/quantity-ledger-movements"
  );
  const ledgerApi = await import(
    "@/quickhack_server/api/inventory/quantity-ledger"
  );
  const timestamp = new Date("2026-07-26T02:00:00.000Z");
  const [viewer, staff] = await Promise.all([
    prisma.users.create({
      data: {
        username: "quantity-viewer",
        password_hash: "test-only",
        role: "VIEWER",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
    prisma.users.create({
      data: {
        username: "quantity-staff",
        password_hash: "test-only",
        role: "STAFF",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
  ]);
  const [viewerToken, staffToken] = await Promise.all([
    authService.createUserSession(viewer.user_id),
    authService.createUserSession(staff.user_id),
  ]);
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "API",
    timestamp,
  });
  await createSellableDeviceFixtures(
    prisma,
    ledgerService,
    catalog,
    { count: 1, timestamp }
  );
  const balance =
    await prisma.inventory_quantity_balances.findFirstOrThrow();
  const routeContext = {
    params: Promise.resolve({
      balanceId: String(
        balance.inventory_quantity_balance_id
      ),
    }),
  };

  const unauthorized = await movementApi.GET(
    request(
      `/api/inventory/quantity-ledger/${balance.inventory_quantity_balance_id}/movements`
    ),
    routeContext
  );
  assert.equal(unauthorized.status, 401);

  const forbidden = await movementApi.GET(
    request(
      `/api/inventory/quantity-ledger/${balance.inventory_quantity_balance_id}/movements`,
      viewerToken
    ),
    routeContext
  );
  assert.equal(forbidden.status, 403);

  const ok = await movementApi.GET(
    request(
      `/api/inventory/quantity-ledger/${balance.inventory_quantity_balance_id}/movements?limit=1`,
      staffToken
    ),
    routeContext
  );
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.data.items.length, 1);

  const invalid = await movementApi.GET(
    request(
      "/api/inventory/quantity-ledger/not-a-number/movements",
      staffToken
    ),
    {
      params: Promise.resolve({ balanceId: "not-a-number" }),
    }
  );
  assert.equal(invalid.status, 400);

  const missing = await movementApi.GET(
    request(
      "/api/inventory/quantity-ledger/999999/movements",
      staffToken
    ),
    {
      params: Promise.resolve({ balanceId: "999999" }),
    }
  );
  assert.equal(missing.status, 404);

  const defaultMatrix = await ledgerApi.GET(
    request("/api/inventory/quantity-ledger", staffToken)
  );
  assert.equal(defaultMatrix.status, 200);
  const defaultMatrixBody = await defaultMatrix.json();
  assert.ok(Array.isArray(defaultMatrixBody.data.rows));
  assert.equal(defaultMatrixBody.data.availability, "READY");
  assert.equal("balances" in defaultMatrixBody.data, false);
  assert.equal("movements" in defaultMatrixBody.data, false);

  const matrix = await ledgerApi.GET(
    request(
      "/api/inventory/quantity-ledger?format=matrix",
      staffToken
    )
  );
  assert.equal(matrix.status, 200);
  const matrixBody = await matrix.json();
  assert.ok(Array.isArray(matrixBody.data.rows));
  assert.equal(matrixBody.data.availability, "READY");
  assert.equal("balances" in matrixBody.data, false);
  assert.equal("movements" in matrixBody.data, false);

  const unsupported = await ledgerApi.GET(
    request(
      "/api/inventory/quantity-ledger?format=wide",
      staffToken
    )
  );
  assert.equal(unsupported.status, 400);

  console.log("Inventory quantity API contracts verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
