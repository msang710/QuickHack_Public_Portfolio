import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { linuxServerProcessExecution } from "../../quickhack_server/platform/linux/process-execution.ts";
import { windowsServerProcessExecution } from "../../quickhack_server/platform/windows/process-execution.ts";
import { composeOperatorPlatform } from "../../tools/platform/compose-operator-platform.mjs";
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
createWindowsOperatorProcessExecution("win32", {
  environment: { SystemRoot: "C:\\Windows" },
  spawnSyncImplementation: (executable, argumentsList, options) => {
    terminationCalls.push({ executable, argumentsList, options });
    return { status: 0 };
  },
}).terminateOwnedProcess(42);
assert.equal(terminationCalls[0].executable, "C:\\Windows\\System32\\taskkill.exe");
assert.deepEqual(terminationCalls[0].argumentsList, ["/F", "/T", "/PID", "42"]);
assert.equal("NODE_OPTIONS" in terminationCalls[0].options.env, false);
assert.equal(
  linuxServerProcessExecution.postgresqlExecutable("/usr/lib/postgresql/18/bin", "pg_dump"),
  "/usr/lib/postgresql/18/bin/pg_dump"
);
assert.throws(
  () => windowsServerProcessExecution.postgresqlExecutable("C:\\PostgreSQL\\bin", "arbitrary"),
  /Unsupported PostgreSQL executable key/
);
assert.equal(
  composeOperatorPlatform({ platform: "win32" }).processExecution.sameExecutablePath(
    "C:\\QuickHack\\Tools\\run.mjs",
    "c:\\quickhack\\tools\\RUN.mjs"
  ),
  true
);
assert.equal(
  composeOperatorPlatform({ platform: "linux" }).processExecution.sameExecutablePath(
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

console.log("Role process execution ownership and finite executable keys verified.");
