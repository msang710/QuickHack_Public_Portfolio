import assert from "node:assert/strict";
import test from "node:test";
import { createCafe24AuthorizationUrl, exchangeCafe24Code, refreshCafe24Token } from "../../quickhack_server/integration/cafe24/oauth.ts";
import { createCafe24ReadClient } from "../../quickhack_server/integration/cafe24/client.ts";

test("Cafe24 OAuth URL requests only read scopes and validates state", async () => {
  const config = { mallId: "myshop", clientId: "app-id", clientSecret: "private", redirectUri: "https://example.org/cafe24/callback" };
  const url = createCafe24AuthorizationUrl(config, "state-123");
  assert.equal(url.origin, "https://myshop.cafe24api.com");
  assert.equal(url.searchParams.get("scope"), "mall.read_product mall.read_order");
  assert.equal(url.searchParams.get("state"), "state-123");
  await assert.rejects(exchangeCafe24Code(config, { code: "auth-code", state: "wrong", expectedState: "state-123" }, async () => { throw new Error("called"); }), /state/);
  assert.throws(() => createCafe24AuthorizationUrl({ ...config, mallId: "myshop.example.org" }, "s"), /mallId/);
});

test("Cafe24 token exchange and refresh use only official token endpoint", async () => {
  const config = { mallId: "myshop", clientId: "app-id", clientSecret: "private", redirectUri: "https://example.org/cafe24/callback" };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: `access-${calls.length}`, refresh_token: `refresh-${calls.length}`, scopes: ["mall.read_product", "mall.read_order"] }), { status: 200 });
  };
  const token = await exchangeCafe24Code(config, { code: "code", state: "state", expectedState: "state" }, fetchImpl);
  const refreshed = await refreshCafe24Token(config, token.refreshToken, fetchImpl);
  assert.equal(token.accessToken, "access-1");
  assert.equal(refreshed.refreshToken, "refresh-2");
  assert.deepEqual(calls.map((x) => x.url), ["https://myshop.cafe24api.com/api/v2/oauth/token", "https://myshop.cafe24api.com/api/v2/oauth/token"]);
  assert.equal(new URLSearchParams(calls[1].init.body).get("grant_type"), "refresh_token");
  assert.equal(JSON.stringify(token).includes("private"), false);
});

test("Cafe24 order preview drops recipient and address fields", async () => {
  const client = createCafe24ReadClient({
    mallId: "myshop",
    accessToken: () => "access",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://myshop.cafe24api.com/api/v2/admin/orders?limit=1");
      assert.equal(init.headers.Authorization, "Bearer access");
      return new Response(JSON.stringify({ orders: [{ order_id: "O1", order_date: "2026-09-28", order_status: "N00", receiver_name: "Secret Person", receiver_address: "Secret Address" }] }), { status: 200 });
    },
  });
  const preview = await client.listOrderPreview(1);
  assert.deepEqual(preview, [{ orderId: "O1", orderDate: "2026-09-28", orderStatus: "N00" }]);
  assert.equal(JSON.stringify(preview).includes("Secret"), false);
});
