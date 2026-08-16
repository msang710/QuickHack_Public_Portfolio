import {
  appendRequestSearchToProxyPath,
} from "../../quickhack_shared/core/server-proxy-path.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  appendRequestSearchToProxyPath("/api/coupang/returns", "") ===
    "/api/coupang/returns",
  "An empty client search changed the proxy path."
);

assert(
  appendRequestSearchToProxyPath(
    "/api/coupang/returns",
    "?phase=after&limit=1000"
  ) === "/api/coupang/returns?phase=after&limit=1000",
  "The return phase search was not forwarded."
);

assert(
  appendRequestSearchToProxyPath(
    "/api/coupang/orders",
    "mode=matched&limit=1000"
  ) === "/api/coupang/orders?mode=matched&limit=1000",
  "A search value without a leading question mark was not normalized."
);

assert(
  appendRequestSearchToProxyPath(
    "/api/auth/sensitive-status?action=DELETE",
    "?action=DELETE"
  ) === "/api/auth/sensitive-status?action=DELETE",
  "A route-owned search was duplicated by the common proxy."
);

assert(
  appendRequestSearchToProxyPath(
    "/api/inventory/quantity-ledger/42/movements",
    "?cursor=120&limit=50"
  ) ===
    "/api/inventory/quantity-ledger/42/movements?cursor=120&limit=50",
  "The inventory movement cursor and limit were not forwarded."
);

assert(
  appendRequestSearchToProxyPath(
    "/api/inventory/inbound-reconciliation",
    "?businessDate=2026-07-27&scope=SHORTAGE"
  ) ===
    "/api/inventory/inbound-reconciliation?businessDate=2026-07-27&scope=SHORTAGE",
  "The inbound reconciliation date and scope were not forwarded."
);

assert(
  appendRequestSearchToProxyPath(
    "/api/statistics/returns",
    "?q=Galaxy%20S24"
  ) === "/api/statistics/returns?q=Galaxy%20S24",
  "The return statistics query was not forwarded."
);

console.log("Server proxy query forwarding verified.");
