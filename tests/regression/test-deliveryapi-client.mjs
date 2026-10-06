import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryApiClient } from "../../quickhack_server/integration/deliveryapi/client.ts";

test("tracking probe uses fixed official URL and emits redacted read evidence", async () => {
  let request;
  const client = createDeliveryApiClient({
    credentials: () => ({ apiKey: "key", secretKey: "secret" }),
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ isSuccess: true, data: { results: [{ clientId: "order-1", success: true, cache: { fromCache: true }, data: { trackingNumber: "123456789012", courierCode: "lotte", deliveryStatus: "IN_TRANSIT", queriedAt: "2026-09-28T00:00:00Z", receiverName: "private" } }], summary: { total: 1, successful: 1, failed: 0, billable: 1 } } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.trace([{ clientId: "order-1", courierCode: "lotte", trackingNumber: "123456789012" }]);
  assert.equal(request.url, "https://api.deliveryapi.co.kr/v1/tracking/trace");
  assert.equal(request.init.headers.Authorization, "Bearer key:secret");
  assert.equal(result.items[0].deliveryStatus, "IN_TRANSIT");
  assert.equal(result.items[0].fromCache, true);
  assert.equal(JSON.stringify(result).includes("123456789012"), false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("tracking probe classifies per-item errors without treating HTTP 200 as success", async () => {
  const client = createDeliveryApiClient({
    credentials: () => ({ apiKey: "key", secretKey: "secret" }),
    fetchImpl: async () => new Response(JSON.stringify({ isSuccess: true, data: { results: [{ clientId: "order-1", success: false, error: { code: "NOT_FOUND", billable: true } }], summary: { total: 1, successful: 0, failed: 1, billable: 1 } } }), { status: 200 }),
  });
  const result = await client.trace([{ clientId: "order-1", courierCode: "lotte", trackingNumber: "123456789012" }]);
  assert.equal(result.items[0].success, false);
  assert.equal(result.items[0].errorCode, "NOT_FOUND");
  assert.equal(result.items[0].billable, true);
});

test("tracking probe caps items and redacts HTTP error bodies", async () => {
  const client = createDeliveryApiClient({
    credentials: () => ({ apiKey: "key", secretKey: "secret" }),
    fetchImpl: async () => new Response("secret 123456789012", { status: 429 }),
  });
  await assert.rejects(client.trace(Array.from({ length: 51 }, () => ({ courierCode: "lotte", trackingNumber: "123456789012" }))), /1 to 50/);
  await assert.rejects(client.trace([{ courierCode: "lotte", trackingNumber: "123456789012" }]), (error) => error.code === "DELIVERYAPI_HTTP" && error.status === 429 && !error.message.includes("secret"));
});
