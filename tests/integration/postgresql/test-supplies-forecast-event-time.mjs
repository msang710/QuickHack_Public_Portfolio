import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { SUPPLY_CONSUMPTION_TRIGGER } from "../../../quickhack_shared/supplies/supplies.ts";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-supplies-forecast-event-time-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { calculateSupplyForecasts, saveSupplyConsumptionRule } = await import(
    "@/quickhack_server/supplies/supplies-service"
  );
  const userRow = await prisma.users.create({
    data: {
      username: "supply-event-time-test",
      password_hash: "test",
      role: "STAFF",
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "Supply event time test",
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };
  const now = new Date();
  const currentBusinessTime = new Date(now.getTime() - 60 * 60 * 1000);
  const oldStorageTime = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  async function createSupply(code, triggerType, quantityPerUnit) {
    const supply = await prisma.supplies.create({
      data: { supply_code: code, supply_name: code },
    });
    await prisma.supply_inventory.create({
      data: { supply_id: supply.supply_id, current_quantity: 0 },
    });
    await saveSupplyConsumptionRule(
      prisma,
      { supplyId: supply.supply_id, triggerType, quantityPerUnit },
      user
    );
    return supply;
  }

  const purchaseSupply = await createSupply(
    "EVENT_TIME_PURCHASE",
    SUPPLY_CONSUMPTION_TRIGGER.purchasedDevice,
    2
  );
  await prisma.devices.create({
    data: { pg_no: "PG-EVENT-TIME", model: "MODEL-EVENT-TIME" },
  });
  await prisma.inbounds.create({
    data: {
      pg_no: "PG-EVENT-TIME",
      inbound_status: "PURCHASED",
      price_agreed_at: currentBusinessTime,
      created_at: oldStorageTime,
      updated_at: oldStorageTime,
    },
  });
  await calculateSupplyForecasts(
    prisma,
    { supplyId: purchaseSupply.supply_id, lookbackDays: 2 },
    user
  );
  const purchaseForecast = await prisma.supply_forecast_snapshots.findFirstOrThrow({
    where: { supply_id: purchaseSupply.supply_id },
    orderBy: { forecast_id: "desc" },
  });
  assert.equal(
    purchaseForecast.expected_usage_quantity,
    2,
    "Purchase forecast used persistence time instead of price_agreed_at."
  );

  const orderSupply = await createSupply(
    "EVENT_TIME_ORDER",
    SUPPLY_CONSUMPTION_TRIGGER.orderItem,
    3
  );
  await prisma.orders.create({
    data: {
      platform: "LEGACY",
      platform_order_id: "EVENT-TIME-LEGACY",
      ordered_at: currentBusinessTime,
      created_at: oldStorageTime,
      updated_at: oldStorageTime,
      order_items: {
        create: {
          sale_product_name: "event time item",
          quantity: 2,
          created_at: oldStorageTime,
          updated_at: oldStorageTime,
        },
      },
    },
  });
  await prisma.order_matching_work_queue.create({
    data: {
      external_order_id: "EVENT-TIME-CHANNEL",
      external_shipment_id: "EVENT-TIME-SHIPMENT",
      external_vendor_item_id: "EVENT-TIME-ITEM",
      ordered_quantity: 4,
      matchable_quantity: 4,
      ordered_at: currentBusinessTime,
      created_at: oldStorageTime,
      updated_at: oldStorageTime,
    },
  });
  await calculateSupplyForecasts(
    prisma,
    { supplyId: orderSupply.supply_id, lookbackDays: 2 },
    user
  );
  const orderForecast = await prisma.supply_forecast_snapshots.findFirstOrThrow({
    where: { supply_id: orderSupply.supply_id },
    orderBy: { forecast_id: "desc" },
  });
  assert.equal(
    orderForecast.expected_usage_quantity,
    18,
    "Order forecast used ingestion time instead of ordered_at."
  );

  const returnSupply = await createSupply(
    "EVENT_TIME_RETURN",
    SUPPLY_CONSUMPTION_TRIGGER.returnReceived,
    5
  );
  await prisma.sales_channel_write_requests.create({
    data: {
      channel: "COUPANG",
      request_type: "RETURN_RECEIVE_CONFIRMATION",
      request_status: "COMPLETED",
      idempotency_key: "event-time-return-confirmed",
      request_digest: "test-fixture",
      method: "PATCH",
      endpoint_path: "/returns/event-time",
      requested_at: oldStorageTime,
      completed_at: currentBusinessTime,
      local_finalized_at: currentBusinessTime,
      created_at: oldStorageTime,
      updated_at: oldStorageTime,
    },
  });
  await prisma.coupang_return_raw.create({
    data: {
      external_receipt_id: "EVENT-TIME-RAW-ONLY",
      external_order_id: "EVENT-TIME-RAW-ORDER",
      cancel_count: 1,
      created_at: currentBusinessTime,
    },
  });
  await calculateSupplyForecasts(
    prisma,
    { supplyId: returnSupply.supply_id, lookbackDays: 2 },
    user
  );
  const returnForecast = await prisma.supply_forecast_snapshots.findFirstOrThrow({
    where: { supply_id: returnSupply.supply_id },
    orderBy: { forecast_id: "desc" },
  });
  assert.equal(
    returnForecast.expected_usage_quantity,
    5,
    "Return forecast counted raw ingestion instead of confirmed receipt completion."
  );

  await prisma.orders.create({
    data: {
      platform: "LEGACY",
      platform_order_id: "EVENT-TIME-MISSING",
      ordered_at: null,
      order_items: { create: { sale_product_name: "missing time", quantity: 1 } },
    },
  });
  await assert.rejects(
    calculateSupplyForecasts(
      prisma,
      { supplyId: orderSupply.supply_id, lookbackDays: 2 },
      user
    ),
    (error) => error?.code === "SUPPLY_FORECAST_SOURCE_INCOMPLETE"
  );

  console.log("Supply forecast business-event timestamps verified.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
