import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { composeClientPlatform } from "../../quickhack_client/platform/compose-client-platform.ts";
import { composeServerPlatform } from "../../quickhack_server/platform/compose-server-platform.ts";
import { composeOperatorPlatform } from "../../tools/platform/compose-operator-platform.mjs";
import { composeProcessExecution } from "../../tools/platform/compose-process-execution.mjs";
import { projectRoot } from "../support/project-root.mjs";

function errorCode(code) {
  return (error) => error?.code === code;
}

function assertFrozenSurface(platform, expectedKeys) {
  assert.equal(Object.isFrozen(platform), true);
  assert.deepEqual(Object.keys(platform).sort(), [...expectedKeys].sort());
  for (const key of expectedKeys) {
    if (["role", "platform"].includes(key)) continue;
    assert.equal(Object.isFrozen(platform[key]), true, key);
    assert.equal(Object.isFrozen(platform[key].descriptor), true, `${key}.descriptor`);
  }
}

const windowsServer = composeServerPlatform({ platform: "win32" });
assertFrozenSurface(windowsServer, [
  "role",
  "platform",
  "runtimeDirectories",
  "processExecution",
  "secretProtector",
  "qhkeyMasterKey",
  "removableVolume",
  "postgresqlService",
]);
assert.equal(windowsServer.role, "server");
assert.deepEqual(
  [
    windowsServer.runtimeDirectories,
    windowsServer.processExecution,
    windowsServer.secretProtector,
    windowsServer.qhkeyMasterKey,
    windowsServer.removableVolume,
    windowsServer.postgresqlService,
  ].map((capability) => capability.descriptor.state),
  ["READY", "READY", "READY", "COMPATIBILITY", "COMPATIBILITY", "COMPATIBILITY"]
);
assert.equal("printerBackend" in windowsServer, false);
assert.equal("packageLifecycle" in windowsServer, false);

const windowsClient = composeClientPlatform({ platform: "win32" });
assertFrozenSurface(windowsClient, [
  "role",
  "platform",
  "runtimeDirectories",
  "adbExecutableResolver",
  "printerBackend",
]);
assert.equal(windowsClient.role, "client");
assert.equal("secretProtector" in windowsClient, false);
assert.equal("postgresqlService" in windowsClient, false);
assert.deepEqual(
  [
    windowsClient.runtimeDirectories,
    windowsClient.adbExecutableResolver,
    windowsClient.printerBackend,
  ].map((capability) => capability.descriptor.state),
  ["READY", "READY", "READY"]
);

const windowsOperator = composeOperatorPlatform({ platform: "win32" });
const windowsProcessExecution = composeProcessExecution({ platform: "win32" });
assert.equal(windowsProcessExecution.descriptor.id, "process-execution");
assert.equal(windowsProcessExecution.descriptor.platform, "win32");
assertFrozenSurface(windowsOperator, [
  "role",
  "platform",
  "processExecution",
  "launcher",
  "packageLifecycle",
  "removableVolume",
  "serverConsoleRuntime",
  "oneShotProcess",
  "serviceLifecycle",
]);
assert.equal(windowsOperator.role, "operator");
assert.equal("printerBackend" in windowsOperator, false);
assert.equal("secretProtector" in windowsOperator, false);
assert.equal(windowsOperator.packageLifecycle.descriptor.state, "READY");
const stageCommand = windowsOperator.packageLifecycle.stageCommand("demo-client");
assert.equal(stageCommand.executable, process.execPath);
assert.match(
  stageCommand.arguments[0],
  /packaging[\\/]windows[\\/]create-staging-package\.mjs$/
);
assert.deepEqual(stageCommand.arguments.slice(1), ["--target=demo-client"]);
assert.throws(
  () => windowsOperator.packageLifecycle.stageCommand("unknown"),
  /Unsupported package target/
);

const linuxServer = composeServerPlatform({ platform: "linux" });
const linuxClient = composeClientPlatform({ platform: "linux" });
const linuxOperator = composeOperatorPlatform({ platform: "linux" });
const linuxProcessExecution = composeProcessExecution({ platform: "linux" });
assert.equal(linuxProcessExecution.descriptor.id, "process-execution");
assert.equal(linuxProcessExecution.descriptor.platform, "linux");
assert.equal(linuxServer.runtimeDirectories.descriptor.state, "READY");
assert.equal(linuxClient.runtimeDirectories.descriptor.state, "READY");
assert.deepEqual(
  linuxServer.runtimeDirectories.resolve({
    appRoot: "/opt/quickhack",
    deployment: "system-service",
    artifactKind: "DEMONSTRATION_SERVER",
  }),
  {
    appRoot: "/opt/quickhack",
    runtimeDir: "/opt/quickhack/runtime",
    configDir: "/etc/quickhack/demonstration-server",
    dataDir: "/var/lib/quickhack/demonstration-server",
    stateDir: "/var/lib/quickhack/demonstration-server/state",
    logDir: "/var/log/quickhack/demonstration-server",
    cacheDir: "/var/cache/quickhack/demonstration-server",
    secretDir: "/var/lib/quickhack/demonstration-server/security",
    artifactDir: "/var/lib/quickhack/demonstration-server/artifacts",
  }
);
assert.equal(linuxClient.adbExecutableResolver.descriptor.state, "READY");
assert.equal(linuxClient.printerBackend.descriptor.state, "READY");
assert.equal(linuxOperator.packageLifecycle.descriptor.state, "READY");
assert.equal(linuxOperator.processExecution.descriptor.state, "READY");
const linuxStageCommand = linuxOperator.packageLifecycle.stageCommand("demo-client");
assert.equal(linuxStageCommand.executable, process.execPath);
assert.match(
  linuxStageCommand.arguments[0],
  /packaging[\\/]linux[\\/]create-staging-package\.mjs$/
);
assert.deepEqual(linuxStageCommand.arguments.slice(1), ["--target=demo-client"]);
assert.equal(linuxServer.secretProtector.descriptor.ownerStage, "PR-06");
assert.equal(linuxServer.qhkeyMasterKey.descriptor.state, "READY");
assert.equal(linuxServer.qhkeyMasterKey.descriptor.ownerStage, "PR-08");
assert.equal(linuxServer.removableVolume.descriptor.state, "READY");
assert.equal(linuxOperator.removableVolume.descriptor.state, "READY");
assert.equal(linuxServer.postgresqlService.descriptor.state, "READY");
assert.equal(linuxOperator.launcher.descriptor.state, "READY");
assert.equal(linuxOperator.oneShotProcess.descriptor.state, "READY");
assert.equal(linuxOperator.serviceLifecycle.descriptor.state, "READY");
assert.equal(linuxOperator.serverConsoleRuntime.descriptor.state, "READY");
assert.equal(linuxClient.printerBackend.descriptor.ownerStage, "PR-07");
assert.equal(linuxOperator.packageLifecycle.descriptor.ownerStage, "PR-10");

for (const compose of [
  composeServerPlatform,
  composeClientPlatform,
  composeOperatorPlatform,
  composeProcessExecution,
]) {
  assert.throws(
    () => compose({ platform: "aix" }),
    errorCode("UNSUPPORTED_PLATFORM")
  );
}

for (const relativePath of [
  "quickhack_server/platform/windows/index.ts",
  "tools/platform/windows/index.mjs",
]) {
  const source = readFileSync(
    path.join(projectRoot, ...relativePath.split("/")),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /^import\s+.*(?:security|printing|qhkey-drive|runtime-config)/m,
    `${relativePath} eagerly imports a legacy native implementation.`
  );
  assert.match(
    source,
    /await import\(|postgresql-service-controller|server-console-runtime/,
    `${relativePath} must use a compatibility or platform-native adapter.`
  );
}

const windowsClientIndex = readFileSync(
  path.join(projectRoot, "quickhack_client", "platform", "windows", "index.ts"),
  "utf8"
);
assert.match(windowsClientIndex, /windowsAdbExecutableResolver/);
assert.match(windowsClientIndex, /windowsPrinterBackend/);
assert.doesNotMatch(windowsClientIndex, /printing\/printer-service|await import\(/);

for (const relativePath of [
  "quickhack_shared/core/runtime-config-service.ts",
  "quickhack_server/security/windows-user-protected-secret.mjs",
  "tools/postgresql-service-install.mjs",
  "tools/client-runtime-plan.mjs",
  "quickhack_server/security/qhkey-drive-locator.mjs",
]) {
  assert.equal(
    existsSync(path.join(projectRoot, ...relativePath.split("/"))),
    true,
    `Compatibility delegate target is missing: ${relativePath}`
  );
}

console.log("Server, client, and operator platform composition roots verified.");
