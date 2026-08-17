import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { linuxServerProcessExecution } from "../../quickhack_server/platform/linux/process-execution.ts";
import { windowsServerProcessExecution } from "../../quickhack_server/platform/windows/process-execution.ts";
import { composeOperatorPlatform } from "../../tools/platform/compose-operator-platform.mjs";
import { composeProcessExecution } from "../../tools/platform/compose-process-execution.mjs";
import { createLinuxOperatorProcessExecution } from "../../tools/platform/linux/process-execution.mjs";
import { createWindowsOperatorProcessExecution } from "../../tools/platform/windows/process-execution.mjs";
import { projectRoot } from "../support/project-root.mjs";
import { createCommandPlan } from "../../quickhack_shared/platform/process-execution-contract.mjs";

const ownership = JSON.parse(
  readFileSync(
    new URL("./fixtures/process-execution-ownership.json", import.meta.url),
    "utf8"
  )
);
assert.equal(ownership.version, 1);
assert.equal(new Set(ownership.capabilities.map((entry) => `${entry.role}:${entry.key}`)).size, ownership.capabilities.length);
assert.deepEqual(createCommandPlan({ executable: "/usr/bin/env", arguments: [1] }), {
  executable: "/usr/bin/env",
  arguments: ["1"],
});
assert.throws(
  () => createCommandPlan({ executable: "node", arguments: [] }),
  /absolute process executable/
);

assert.equal(
  windowsServerProcessExecution.postgresqlExecutable("C:\\PostgreSQL\\bin", "pg_dump"),
  "C:\\PostgreSQL\\bin\\pg_dump.exe"
);
const terminationCalls = [];
const windowsSpawnCalls = [];
const windowsOperatorExecution = createWindowsOperatorProcessExecution("win32", {
  environment: { SystemRoot: "C:\\Windows" },
  spawnImplementation: (...argumentsList) => {
    windowsSpawnCalls.push(argumentsList);
    return { pid: 21 };
  },
  spawnSyncImplementation: (executable, argumentsList, options) => {
    terminationCalls.push({ executable, argumentsList, options });
    return { status: 0 };
  },
});
windowsOperatorExecution.terminateOwnedProcess(42);
assert.equal(terminationCalls[0].executable, "C:\\Windows\\System32\\taskkill.exe");
assert.deepEqual(terminationCalls[0].argumentsList, ["/F", "/T", "/PID", "42"]);
assert.equal("NODE_OPTIONS" in terminationCalls[0].options.env, false);
windowsOperatorExecution.spawnOwnedDetached("C:\\node\\node.exe", ["server.js"], { shell: true });
assert.equal(windowsSpawnCalls[0][2].detached, true);
assert.equal(windowsSpawnCalls[0][2].shell, false);
windowsOperatorExecution.terminateOwnedDetachedProcess(43);
assert.deepEqual(terminationCalls[1].argumentsList, ["/F", "/T", "/PID", "43"]);
const linuxTerminationCalls = [];
const linuxSpawnCalls = [];
const linuxOperatorExecution = createLinuxOperatorProcessExecution("linux", {
  spawnImplementation: (...argumentsList) => {
    linuxSpawnCalls.push(argumentsList);
    return { pid: 22 };
  },
  killImplementation: (...argumentsList) =>
    linuxTerminationCalls.push(argumentsList),
});
linuxOperatorExecution.terminateOwnedProcess(84);
linuxOperatorExecution.spawnOwnedChild("/usr/bin/node", ["server.js"], { detached: true });
assert.equal(linuxSpawnCalls[0][2].detached, false);
assert.equal(linuxSpawnCalls[0][2].shell, false);
linuxOperatorExecution.terminateOwnedDetachedProcess(85);
linuxOperatorExecution.terminateOwnedDetachedProcess(86, { force: true });
assert.deepEqual(linuxTerminationCalls, [[84], [-85, "SIGTERM"], [-86, "SIGKILL"]]);
assert.equal(
  linuxServerProcessExecution.postgresqlExecutable("/usr/lib/postgresql/18/bin", "pg_dump"),
  "/usr/lib/postgresql/18/bin/pg_dump"
);
assert.throws(
  () => windowsServerProcessExecution.postgresqlExecutable("C:\\PostgreSQL\\bin", "arbitrary"),
  /Unsupported PostgreSQL executable key/
);
assert.equal(
  composeProcessExecution({ platform: "win32" }).sameExecutablePath(
    "C:\\QuickHack\\Tools\\run.mjs",
    "c:\\quickhack\\tools\\RUN.mjs"
  ),
  true
);
assert.equal(
  composeProcessExecution({ platform: "linux" }).sameExecutablePath(
    "/opt/quickhack/run.mjs",
    "/opt/QuickHack/run.mjs"
  ),
  false
);

for (const relativePath of [
  "quickhack_shared/core/child-process-environment.mjs",
  "quickhack_server/core/database/postgresql-native-operations.mjs",
  "tools/client-runtime-launcher.mjs",
  "tools/provision-initial-leader.mjs",
]) {
  const source = readFileSync(path.join(projectRoot, ...relativePath.split("/")), "utf8");
  assert.doesNotMatch(source, /process\.platform|path\.win32|powershell|cmd\.exe/i, relativePath);
}

const clientLauncherSource = readFileSync(
  path.join(projectRoot, "tools", "client-runtime-launcher.mjs"),
  "utf8"
);
assert.match(clientLauncherSource, /composeProcessExecution\(\)/);
assert.match(clientLauncherSource, /spawnOwnedDetached/);
assert.match(clientLauncherSource, /terminateOwnedDetachedProcess/);
assert.doesNotMatch(clientLauncherSource, /node:child_process/);
assert.doesNotMatch(
  clientLauncherSource,
  /create(?:Windows|Linux)OperatorProcessExecution|platform\/(?:windows|linux)\/process-execution/
);

const clientBootstrapSource = readFileSync(
  path.join(projectRoot, "tools", "client-runtime-bootstrap.mjs"),
  "utf8"
);
assert.match(clientBootstrapSource, /composeProcessExecution\(\)/);
assert.doesNotMatch(clientBootstrapSource, /composeOperatorPlatform/);

console.log("Role process execution ownership and finite executable keys verified.");
