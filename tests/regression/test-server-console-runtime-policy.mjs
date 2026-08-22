import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseServerConsoleArguments } from "../../tools/server-console-core.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const selector = read("tools/server-console.mjs");
const core = read("tools/server-console-core.mjs");
const operational = read("tools/server-console-operational.mjs");
const demonstration = read("tools/server-console-demonstration.mjs");

assert.match(selector, /readServerRuntimeConfigSync/);
assert.match(selector, /packageFlavor === "OPERATIONAL"/);
assert.match(selector, /packageFlavor === "DEMONSTRATION"/);
assert.doesNotMatch(selector, /node:child_process|powershell|taskkill|netstat|dpapi/iu);

for (const route of [
  "/api/quickhack/start",
  "/api/quickhack/stop",
  "/api/runtime/toggle-environment",
  "/api/runtime/toggle-coupang-write-api",
  "/api/runtime/toggle-logen-write-api",
  "/api/qhkey/status",
  "/api/qhkey/replacement-status",
  "/api/qhkey/replacement-cancel",
  "/api/totp-security/recover",
]) assert.match(core, new RegExp(route.replaceAll("/", "\\/")));

assert.match(core, /packageFlavor: flavor/);
assert.match(core, /CREDENTIALS_DIRECTORY: credentialDirectory/);
assert.match(core, /X-QuickHack-Supervisor-Token/);
assert.doesNotMatch(core, /mock_server|issueMockCoupang|rotateCoupangQhkey|rotateLogenQhkey/iu);
assert.doesNotMatch(operational, /mock_server|mock-issue|issueMock/iu);
assert.match(operational, /\/api\/qhkey\/rotate/);
assert.match(operational, /\/api\/qhkey\/logen\/rotate/);
assert.doesNotMatch(demonstration, /rotateCoupangQhkey|rotateLogenQhkey|Access Key|Secret Key/iu);
assert.match(demonstration, /\/api\/qhkey\/mock-issue/);
assert.doesNotMatch(core, /spawnSync\([^\n]*(?:sudo|pkexec)|spawn\([^\n]*(?:sudo|pkexec)/u);

const runtimeConfigPath = path.join(root, ".runtime", "server-runtime.json");
const packageManifestPath = path.join(root, "quickhack-package.json");
assert.deepEqual(
  parseServerConsoleArguments([
    "--runtime-config",
    runtimeConfigPath,
    "--package-manifest",
    packageManifestPath,
    "--system-service",
    "--no-open",
  ]),
  {
    runtimeConfigPath: path.resolve(runtimeConfigPath),
    packageManifestPath: path.resolve(packageManifestPath),
    noOpen: true,
    systemService: true,
  }
);
for (const invalidArguments of [
  ["--runtime-config", "--no-open"],
  ["--package-manifest"],
  ["--unexpected"],
]) {
  assert.throws(
    () => parseServerConsoleArguments(invalidArguments),
    /requires a file path|Unsupported server console argument/
  );
}

console.log("Server console immutable flavor, common action, and privilege policy checks passed.");
