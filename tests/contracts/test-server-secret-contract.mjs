import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SERVER_SECRET_KINDS,
  assertServerSecretBuffer,
  assertServerSecretKind,
  createServerSecretProtectionMetadata,
} from "../../quickhack_server/platform/server-secret-contract.mjs";
import {
  WINDOWS_SERVER_SECRET_SCOPE_ENV,
  WINDOWS_SERVER_SECRET_SCOPES,
  createWindowsServerSecretProtector,
  resolveWindowsServerSecretScope,
  windowsMachineServerSecretProtectionMetadata,
  windowsServerSecretProtectionMetadata,
} from "../../quickhack_server/platform/windows/server-secret-protector.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/server-secret-contract-cases.json", import.meta.url),
    "utf8"
  )
);

assert.equal(fixture.version, 1);
assert.deepEqual(
  fixture.cases.map((item) => item.kind),
  [...SERVER_SECRET_KINDS]
);
assert.equal(new Set(fixture.cases.map((item) => item.kind)).size, 5);
for (const testCase of fixture.cases) {
  assert.equal(assertServerSecretKind(testCase.kind), testCase.kind);
  assert.match(testCase.filePrefix, /^QH[A-Z0-9]+\nDPAPI_CURRENT_USER\n$/u);
  assert.equal(typeof testCase.syncUnprotect, "boolean");
  assert.match(testCase.replacementGuard, /^[A-Z][A-Z0-9_]+$/u);
}
assert.deepEqual(fixture.deferred, []);

const metadata = createServerSecretProtectionMetadata({
  protection: "TEST_CURRENT_IDENTITY",
  identityScope: "CURRENT_TEST_IDENTITY",
  portable: false,
  formatVersion: 1,
  lifecycle: "OPAQUE_PAYLOAD",
});
assert.equal(Object.isFrozen(metadata), true);
assert.deepEqual(Object.keys(metadata), [
  "protection",
  "identityScope",
  "portable",
  "formatVersion",
  "lifecycle",
]);
assert.equal(
  Object.values(metadata).some((value) => String(value).includes("secret")),
  false
);
assert.equal(assertServerSecretKind("QHKEY_MASTER_KEY"), "QHKEY_MASTER_KEY");
assert.throws(() => assertServerSecretBuffer(Buffer.alloc(0), "secret"), /non-empty/);
assert.equal(assertServerSecretBuffer(Buffer.from([1]), "secret").length, 1);
assert.equal(WINDOWS_SERVER_SECRET_SCOPE_ENV, "QUICKHACK_WINDOWS_SECRET_SCOPE");
assert.equal(Object.isFrozen(WINDOWS_SERVER_SECRET_SCOPES), true);
assert.deepEqual(WINDOWS_SERVER_SECRET_SCOPES, [
  "CURRENT_USER",
  "LOCAL_MACHINE",
]);
assert.equal(resolveWindowsServerSecretScope(), "CURRENT_USER");
assert.equal(resolveWindowsServerSecretScope(" current_user "), "CURRENT_USER");
assert.equal(resolveWindowsServerSecretScope("local_machine"), "LOCAL_MACHINE");
assert.throws(
  () => resolveWindowsServerSecretScope(""),
  /Unsupported Windows server secret identity scope/u
);
assert.throws(
  () => resolveWindowsServerSecretScope("CURRENT_MACHINE"),
  /Unsupported Windows server secret identity scope/u
);
assert.deepEqual(windowsServerSecretProtectionMetadata, {
  protection: "WINDOWS_DPAPI_CURRENT_USER",
  identityScope: "CURRENT_WINDOWS_USER",
  portable: false,
  formatVersion: 1,
  lifecycle: "OPAQUE_PAYLOAD",
});
assert.deepEqual(windowsMachineServerSecretProtectionMetadata, {
  protection: "WINDOWS_DPAPI_LOCAL_MACHINE",
  identityScope: "LOCAL_WINDOWS_MACHINE",
  portable: false,
  formatVersion: 1,
  lifecycle: "OPAQUE_PAYLOAD",
});

const observedScripts = [];
const windows = createWindowsServerSecretProtector({
  platform: "win32",
  async runScript(script, options) {
    observedScripts.push(script);
    return options.inputLine;
  },
  runScriptSync(script, options) {
    observedScripts.push(script);
    return options.inputLine;
  },
});
const secret = Buffer.from("contract-secret", "utf8");
const protectedPayload = await windows.protector.protect(
  "BACKUP_MASTER_KEY",
  secret
);
assert.equal(protectedPayload.equals(secret), true);
assert.equal(
  (await windows.protector.unprotect("OTP_MASTER_KEY", protectedPayload)).equals(
    secret
  ),
  true
);
assert.equal(
  windows.protector
    .unprotectSync("POSTGRESQL_CREDENTIAL", protectedPayload)
    .equals(secret),
  true
);
assert.equal(windows.protector.metadata.portable, false);
assert.equal(windows.protector.descriptor.state, "READY");
assert.equal(observedScripts.length, 3);
assert.equal(
  observedScripts.every((script) =>
    script.includes("DataProtectionScope]::CurrentUser")
  ),
  true
);
assert.equal(
  windows.protector
    .unprotectSync("QHKEY_MASTER_KEY", protectedPayload)
    .equals(secret),
  true
);

const observedMachineScripts = [];
const windowsMachine = createWindowsServerSecretProtector({
  platform: "win32",
  scope: "LOCAL_MACHINE",
  async runScript(script, options) {
    observedMachineScripts.push(script);
    return options.inputLine;
  },
  runScriptSync(script, options) {
    observedMachineScripts.push(script);
    return options.inputLine;
  },
});
const machinePayload = await windowsMachine.protector.protect(
  "POSTGRESQL_CREDENTIAL",
  secret
);
let openedMachinePayload;
try {
  openedMachinePayload = await windowsMachine.protector.unprotect(
    "POSTGRESQL_CREDENTIAL",
    machinePayload
  );
  assert.equal(
    openedMachinePayload.equals(secret),
    true
  );
  assert.deepEqual(
    windowsMachine.protector.metadata,
    windowsMachineServerSecretProtectionMetadata
  );
  assert.equal(
    observedMachineScripts.every((script) =>
      script.includes("DataProtectionScope]::LocalMachine")
    ),
    true
  );
  assert.equal(
    observedMachineScripts.some((script) =>
      script.includes("DataProtectionScope]::CurrentUser")
    ),
    false
  );
} finally {
  machinePayload.fill(0);
  openedMachinePayload?.fill(0);
}

const failingWindows = createWindowsServerSecretProtector({
  platform: "win32",
  async runScript() {
    throw new Error("leaked-secret-value");
  },
  runScriptSync() {
    throw new Error("leaked-secret-value");
  },
});
await assert.rejects(
  () => failingWindows.protector.protect("OTP_MASTER_KEY", secret),
  (error) =>
    /could not protect/u.test(error.message) &&
    !error.message.includes("leaked-secret-value")
);
assert.throws(
  () =>
    failingWindows.protector.unprotectSync(
      "POSTGRESQL_CREDENTIAL",
      protectedPayload
    ),
  (error) =>
    /could not open/u.test(error.message) &&
    !error.message.includes("leaked-secret-value")
);

console.log("Server secret kinds, metadata, file formats, and owner handoff verified.");
