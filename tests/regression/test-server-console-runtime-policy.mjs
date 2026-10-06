import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertConsoleConfigDirectory, parseServerConsoleArguments } from "../../tools/server-console-core.mjs";

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
assert.match(core, /QUICKHACK_ARTIFACT_KIND: args\.packageManifestPath \? `\$\{flavor\}_SERVER` : undefined/u);
assert.match(core, /QUICKHACK_PACKAGE_MANIFEST: args\.packageManifestPath \|\| undefined/u);
assert.ok(core.indexOf("QUICKHACK_ARTIFACT_KIND: args.packageManifestPath") < core.indexOf('spawnOwned("backend"'));
assert.match(core, /stdio: \["ignore", "pipe", "pipe"\]/u);
assert.match(core, /captureChildOutput\(child, id, "stdout", process\.stdout\)/u);
assert.doesNotMatch(core, /source\.pipe\(target|child\.stdout\.pipe\(process\.stdout|child\.stderr\.pipe\(process\.stderr/u);
assert.match(core, /requestUrl\.pathname === "\/api\/logs"/u);
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
if (process.platform === "linux") {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "quickhack-console-config-"));
  try {
    const configDirectory = path.join(fixture, "config");
    mkdirSync(configDirectory, { mode: 0o550 });
    const configPath = path.join(configDirectory, "server-runtime.json");
    assert.equal(assertConsoleConfigDirectory(configPath), configDirectory);
    assert.equal(lstatSync(configDirectory).mode & 0o777, 0o550, "Console startup must not chmod the installed config directory.");
    chmodSync(configDirectory, 0o777);
    assert.throws(() => assertConsoleConfigDirectory(configPath), (error) => error?.code === "RUNTIME_DIRECTORY_INVALID");
    const linkedDirectory = path.join(fixture, "linked");
    symlinkSync(configDirectory, linkedDirectory);
    assert.throws(() => assertConsoleConfigDirectory(path.join(linkedDirectory, "server-runtime.json")), (error) => error?.code === "RUNTIME_DIRECTORY_INVALID");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
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
