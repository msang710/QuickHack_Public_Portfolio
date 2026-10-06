import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createDeliveryApiWebhookClient, verifyDeliveryApiWebhook } from "../../quickhack_server/integration/deliveryapi/webhooks.ts";

test("webhook signature accepts the raw body once and rejects tampering or stale timestamp", () => {
  const timestamp = "1790553600";
  const rawBody = JSON.stringify({ event: "tracking.polled", requestId: "req_1" });
  const signature = `sha256=${createHmac("sha256", "secret").update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const headers = new Headers({ "x-webhook-timestamp": timestamp, "x-webhook-signature": signature, "x-webhook-id": "evt_1" });
  const nowMs = Number(timestamp) * 1000;
  assert.equal(verifyDeliveryApiWebhook(rawBody, headers, "secret", nowMs).requestId, "req_1");
  assert.throws(() => verifyDeliveryApiWebhook(rawBody + " ", headers, "secret", nowMs), /signature/);
  assert.throws(() => verifyDeliveryApiWebhook(rawBody, headers, "secret", nowMs + 301_000), /timestamp/);
});

test("subscription query returns redacted status and rejects an unsafe request ID", async () => {
  let url;
  const client = createDeliveryApiWebhookClient({
    credentials: () => ({ apiKey: "key", secretKey: "secret" }),
    fetchImpl: async (target) => {
      url = String(target);
      return new Response(JSON.stringify({ isSuccess: true, data: { requestId: "req_1", status: "active", items: [{ clientId: "o1", trackingNumber: "123456789012", currentStatus: "IN_TRANSIT" }] } }), { status: 200 });
    },
  });
  const result = await client.getSubscription("req_1");
  assert.equal(url, "https://api.deliveryapi.co.kr/v1/webhooks/subscriptions/req_1");
  assert.deepEqual(result.items, [{ clientId: "o1", currentStatus: "IN_TRANSIT" }]);
  assert.equal(JSON.stringify(result).includes("123456789012"), false);
  await assert.rejects(client.getSubscription("../evil"), /requestId/);
});

test("one-shot subscription registration omits endpoint and redacts the waybill", async () => {
  let request;
  const client = createDeliveryApiWebhookClient({
    credentials: () => ({ apiKey: "key", secretKey: "secret" }),
    fetchImpl: async (url, init) => {
      request = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ isSuccess: true, data: { requestId: "req_2", itemCount: 1, recurring: false } }), { status: 200 });
    },
  });
  const result = await client.registerOnce({ courierCode: "lotte", trackingNumber: "123456789012", clientId: "o1" });
  assert.equal(request.url, "https://api.deliveryapi.co.kr/v1/webhooks/register");
  assert.equal(request.body.recurring, false);
  assert.equal("endpointId" in request.body, false);
  assert.deepEqual(result, { requestId: "req_2", itemCount: 1, recurring: false });
});
