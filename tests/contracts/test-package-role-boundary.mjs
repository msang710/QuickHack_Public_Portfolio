import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUNTIME_PACKAGE_ROLE_FORBIDDEN_ADAPTER_PREFIXES,
  assertRuntimePackageRole,
  findRuntimePackageRoleViolations,
} from "../../packaging/runtime-package-source-boundary.mjs";
import { projectRoot } from "../support/project-root.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-package-role-"));
  return {
    root,
    write(relativePath) {
      const filename = path.join(root, ...relativePath.split("/"));
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, "fixture\n", "utf8");
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

assert.deepEqual(Object.keys(RUNTIME_PACKAGE_ROLE_FORBIDDEN_ADAPTER_PREFIXES), [
  "demo-server",
  "demo-client",
  "demonstration-server",
  "operational-server",
  "demonstration-client",
  "operational-client",
]);

const server = fixture();
try {
  server.write("server/quickhack_server/platform/windows/index.js");
  server.write("server/quickhack_client/components/shared.js");
  server.write("server/node_modules/example/quickhack_client/platform/windows/index.js");
  assert.deepEqual(findRuntimePackageRoleViolations("demo-server", server.root), []);

  server.write("server/quickhack_client/platform/windows/index.js");
  assert.deepEqual(findRuntimePackageRoleViolations("demo-server", server.root), [
    {
      target: "demo-server",
      path: "server/quickhack_client/platform/windows/index.js",
      ownerRole: "client",
    },
  ]);
  assert.throws(
    () => assertRuntimePackageRole("demo-server", server.root),
    /demo-server:server\/quickhack_client\/platform\/windows\/index\.js \(owner=client\)/
  );
} finally {
  server.remove();
}

const client = fixture();
try {
  client.write("client/quickhack_client/platform/windows/index.js");
  client.write("client/quickhack_server/auth/shared.js");
  assert.deepEqual(findRuntimePackageRoleViolations("demo-client", client.root), []);

  client.write("client/quickhack_server/platform/linux/index.js");
  assert.deepEqual(findRuntimePackageRoleViolations("demo-client", client.root), [
    {
      target: "demo-client",
      path: "client/quickhack_server/platform/linux/index.js",
      ownerRole: "server",
    },
  ]);
  assert.throws(
    () => assertRuntimePackageRole("demo-client", client.root),
    /owner=server/
  );
  client.write("client/tools/platform/linux/systemd-credential-provisioner.mjs");
  assert.equal(
    findRuntimePackageRoleViolations("demo-client", client.root).some(
      (violation) => violation.ownerRole === "operator"
    ),
    true
  );
} finally {
  client.remove();
}

assert.throws(
  () => findRuntimePackageRoleViolations("unknown", projectRoot),
  /Unknown runtime package role/
);

const stagingSource = readFileSync(
  path.join(projectRoot, "packaging", "create-staging-package.mjs"),
  "utf8"
);
assert.match(stagingSource, /assertRuntimePackageRole\(packageTarget, outputDir\)/);
assert.equal(
  [...stagingSource.matchAll(/assertRuntimePackageRole\(packageTarget, outputDir\)/g)]
    .length,
  2,
  "Both staged package targets must enforce the role boundary."
);

console.log("Runtime package native-adapter role boundaries verified.");
