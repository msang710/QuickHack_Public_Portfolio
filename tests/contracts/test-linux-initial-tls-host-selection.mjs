import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureInitialTls, initialTlsHosts, tlsHostSelectionStatus } from "../../tools/platform/linux/initial-tls-setup.mjs";
import { getQuickHackTlsStatus } from "../../tools/server-console-tls.mjs";

const interfaces = {
  lan: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
  vpn: [{ family: "IPv4", internal: false, address: "10.8.0.3" }],
};
assert.throws(() => initialTlsHosts(interfaces, "server.local"), (error) => error.code === "TLS_HOST_SELECTION_REQUIRED");
const selected = initialTlsHosts(interfaces, "server.local", "192.168.1.20");
assert.equal(selected.primaryHost, "192.168.1.20");
assert(selected.hostNames.includes("10.8.0.3"));
assert.equal(initialTlsHosts({ lan: interfaces.lan }, "server.local").primaryHost, "192.168.1.20");
assert.throws(() => initialTlsHosts({}, "server.local"), (error) => error.code === "TLS_HOST_SELECTION_REQUIRED");
assert.deepEqual(tlsHostSelectionStatus({ ready: false }), { matches: false, code: null });
const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "quickhack-initial-tls-"));
try {
  const first = await ensureInitialTls(dataDirectory, { publicHost: "127.0.0.1", hosts: { primaryHost: "127.0.0.1", hostNames: ["127.0.0.1", "localhost"] } });
  assert.equal(first.created, true);
  const before = getQuickHackTlsStatus(dataDirectory);
  assert.equal(before.ready, true);
  assert.deepEqual(tlsHostSelectionStatus(before, "127.0.0.1"), { matches: true, code: null });
  assert.deepEqual(tlsHostSelectionStatus(before, "127.0.0.1", { lan: interfaces.lan }, "server.local"), { matches: true, code: null });
  assert.deepEqual(tlsHostSelectionStatus(before, "", { lan: interfaces.lan }, "server.local"), { matches: false, code: "TLS_HOST_CHANGED" });
  assert.deepEqual(tlsHostSelectionStatus(before, "", interfaces, "server.local"), { matches: false, code: "TLS_HOST_SELECTION_REQUIRED" });
  await assert.rejects(() => ensureInitialTls(dataDirectory, { networkInterfaces: { lan: interfaces.lan }, hostname: "server.local" }), (error) => error.code === "TLS_HOST_CHANGED");
  assert.equal((await ensureInitialTls(dataDirectory, { publicHost: "127.0.0.1", networkInterfaces: { lan: interfaces.lan }, hostname: "server.local" })).renewed, false);
  const changed = await ensureInitialTls(dataDirectory, { publicHost: "example.test", networkInterfaces: { lan: interfaces.lan }, hostname: "server.local", hosts: { primaryHost: "example.test", hostNames: ["example.test", "localhost"] } });
  assert.equal(changed.renewed, true);
  const after = getQuickHackTlsStatus(dataDirectory);
  assert.equal(after.ready, true);
  assert.equal(after.trustBundle.origin, "https://example.test:3443");
  assert.equal(after.trustBundle.manifest.currentCaSha256, before.trustBundle.manifest.currentCaSha256);
} finally {
  rmSync(dataDirectory, { recursive: true, force: true });
}
console.log("Linux initial TLS host selection verified.");
