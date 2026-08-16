import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createLinuxServerConsoleRuntime } from "../../tools/platform/linux/server-console-runtime.mjs";
import { createWindowsServerConsoleRuntime } from "../../tools/platform/windows/server-console-runtime.mjs";

const linux = createLinuxServerConsoleRuntime({ environment: {}, interactive: false });
const windows = createWindowsServerConsoleRuntime({ environment: { SystemRoot: "C:\\Windows" } });
for (const runtime of [linux, windows]) {
  for (const method of ["childEnvironment", "execFileText", "timeStatus", "portPids", "terminateOwnedProcess", "processMetadata", "openUrl", "openPath", "secureDirectory", "initializeTls"]) {
    assert.equal(typeof runtime[method], "function", `${runtime.descriptor.platform}.${method}`);
  }
}
assert.equal(linux.descriptor.state, "READY");
assert.equal(linux.requiresExternalDatabaseOperations, true);
assert.equal(linux.openUrl("http://127.0.0.1:2999"), false);
assert.equal(windows.requiresExternalDatabaseOperations, false);

const root = path.resolve(import.meta.dirname, "..", "..");
const commonConsole = readFileSync(path.join(root, "tools/server-console.mjs"), "utf8");
const commonTls = readFileSync(path.join(root, "tools/server-console-tls.mjs"), "utf8");
const linuxTls = readFileSync(path.join(root, "tools/platform/linux/server-console-tls-initializer.mjs"), "utf8");
for (const source of [commonConsole, commonTls]) {
  assert.doesNotMatch(source, /process\.platform|path\.win32|powershell|taskkill|netstat|dpapi/iu);
}
assert.match(linuxTls, /OPENSSL_EXECUTABLE = "\/usr\/bin\/openssl"/);
assert.match(linuxTls, /`file:\$\{files\.passphrase\}`/);
assert.doesNotMatch(linuxTls, /-passout", `pass:/u);

console.log("Windows/Linux server console runtime and TLS native boundaries verified.");
