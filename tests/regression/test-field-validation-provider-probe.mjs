import assert from "node:assert/strict";
import test from "node:test";
import { runProviderProbe } from "../../tools/field-validation/provider-probe.mjs";

test("provider probe uses server credentials and returns redacted tracking evidence", async () => {
  const result = await runProviderProbe("deliveryapi", { runId: "run-17", courierCode: "lotte", trackingNumber: "123456789012" }, {
    env: { QUICKHACK_DELIVERYAPI_API_KEY: "key", QUICKHACK_DELIVERYAPI_SECRET_KEY: "secret" },
    fetchImpl: async () => new Response(JSON.stringify({ isSuccess: true, data: { results: [{ success: true, data: { deliveryStatus: "DELIVERED", trackingNumber: "123456789012" } }] } }), { status: 200 }),
  });
  assert.equal(result.items[0].deliveryStatus, "DELIVERED");
  assert.equal(result.runId, "run-17");
  assert.equal(JSON.stringify(result).includes("123456789012"), false);
});

test("Cafe24 provider probe records access denial without leaking token", async () => {
  await assert.rejects(runProviderProbe("cafe24", { runId: "run-17" }, {
    env: { QUICKHACK_CAFE24_MALL_ID: "myshop", QUICKHACK_CAFE24_ACCESS_TOKEN: "secret-access" },
    fetchImpl: async () => new Response("secret-access", { status: 403 }),
  }), (error) => error.message.includes("403") && !error.message.includes("secret-access"));
});
