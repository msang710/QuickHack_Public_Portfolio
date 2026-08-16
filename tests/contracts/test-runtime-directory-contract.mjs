import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linuxClientRuntimeDirectories } from "../../quickhack_client/platform/linux/runtime-directories.ts";
import { windowsClientRuntimeDirectories } from "../../quickhack_client/platform/windows/runtime-directories.ts";
import { linuxServerRuntimeDirectories } from "../../quickhack_server/platform/linux/runtime-directories.ts";
import { windowsServerRuntimeDirectories } from "../../quickhack_server/platform/windows/runtime-directories.ts";
import { RUNTIME_DIRECTORY_FIELDS } from "../../quickhack_shared/platform/runtime-directory-contract.mjs";
import { projectRoot } from "../support/project-root.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/runtime-directory-cases.json", import.meta.url),
    "utf8"
  )
);
assert.equal(fixture.version, 1);

const providers = {
  "client:linux": linuxClientRuntimeDirectories,
  "client:win32": windowsClientRuntimeDirectories,
  "server:linux": linuxServerRuntimeDirectories,
  "server:win32": windowsServerRuntimeDirectories,
};

for (const testCase of fixture.cases) {
  const provider = providers[`${testCase.role}:${testCase.platform}`];
  assert.ok(provider, testCase.name);
  const resolved = provider.resolve(testCase.input);
  assert.deepEqual(resolved, testCase.expected, testCase.name);
  assert.equal(Object.isFrozen(resolved), true, testCase.name);
  assert.deepEqual(Object.keys(resolved), [...RUNTIME_DIRECTORY_FIELDS]);
}

assert.throws(
  () =>
    linuxClientRuntimeDirectories.resolve({
      appRoot: "/opt/quickhack",
      homeDirectory: "/home/worker",
      environment: { XDG_DATA_HOME: "relative/data" },
    }),
  /absolute Linux path/
);
assert.throws(
  () =>
    windowsServerRuntimeDirectories.resolve({
      appRoot: "relative\\quickhack",
      environment: {},
    }),
  /absolute Windows path/
);
assert.throws(
  () =>
    windowsClientRuntimeDirectories.resolve({
      appRoot: "C:\\QuickHack\\..\\escape",
      environment: {},
    }),
  /path traversal/
);
assert.throws(
  () =>
    linuxServerRuntimeDirectories.resolve({
      appRoot: "/usr/lib/quickhack/server",
      deployment: "system-service",
      environment: {},
    }),
  /artifactKind is required/
);
assert.throws(
  () =>
    windowsClientRuntimeDirectories.resolve({
      appRoot: "C:\\QuickHackClient",
      deployment: "system-service",
      environment: {},
    }),
  /artifactKind is required/
);
assert.equal(projectRoot.endsWith("quickhack"), true);

console.log(`Runtime directory providers verified (${fixture.cases.length} cases).`);
