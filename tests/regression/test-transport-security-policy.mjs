import assert from "node:assert/strict";
import fs from "node:fs";
import {
  QUICKHACK_HSTS_HEADER_VALUE,
  isTrustedLoopbackCookieHop,
  resolveTransportSecurityPolicy,
} from "../../quickhack_shared/security/transport-security-policy.mjs";

assert.equal(QUICKHACK_HSTS_HEADER_VALUE, "max-age=31536000");
assert.equal(
  resolveTransportSecurityPolicy({ runtimeRole: "server", production: true }).secureSessionCookie,
  true
);
assert.equal(
  resolveTransportSecurityPolicy({
    runtimeRole: "server",
    production: false,
    httpsTerminated: "1",
    publicOrigin: "https://quickhack.example:3443",
  }).secureSessionCookie,
  true
);
assert.equal(
  resolveTransportSecurityPolicy({ runtimeRole: "server", production: false }).secureSessionCookie,
  false
);
assert.throws(
  () => resolveTransportSecurityPolicy({ runtimeRole: "server", httpsTerminated: "1" }),
  /public origin/
);
assert.throws(
  () => resolveTransportSecurityPolicy({
    runtimeRole: "client",
    httpsTerminated: "1",
    publicOrigin: "https://quickhack.example:3443",
  }),
  /only be asserted/
);

const loopback = {
  runtimeRole: "client",
  remoteOrigin: "https://quickhack.example:3443",
  localOrigin: "http://127.0.0.1:3001",
  hostHeader: "127.0.0.1:3001",
};
assert.equal(isTrustedLoopbackCookieHop(loopback), true);
for (const patch of [
  { runtimeRole: "server" },
  { remoteOrigin: "http://quickhack.example:3000" },
  { localOrigin: "http://localhost:3001" },
  { localOrigin: "https://127.0.0.1:3001" },
  { localOrigin: "http://127.0.0.1:3999", hostHeader: "127.0.0.1:3999" },
  { hostHeader: "attacker.example:3001" },
]) {
  assert.equal(isTrustedLoopbackCookieHop({ ...loopback, ...patch }), false);
}

const authSource = fs.readFileSync("quickhack_server/auth/auth-service.ts", "utf8");
const gatewaySource = fs.readFileSync("tools/quickhack-https-gateway.mjs", "utf8");
const consoleSource = fs.readFileSync("tools/server-console-core.mjs", "utf8");
const proxySource = fs.readFileSync("quickhack_shared/core/server-proxy.ts", "utf8");
assert.doesNotMatch(authSource, /QUICKHACK_COOKIE_SECURE/);
assert.match(authSource, /resolveTransportSecurityPolicy/);
assert.match(gatewaySource, /QUICKHACK_HSTS_HEADER_VALUE/);
assert.match(consoleSource, /QUICKHACK_HTTPS_TERMINATED:\s*"1"/);
assert.match(consoleSource, /QUICKHACK_PUBLIC_SERVER_ORIGIN/);
assert.match(proxySource, /isTrustedLoopbackCookieHop/);

console.log("Transport security policy verified.");
