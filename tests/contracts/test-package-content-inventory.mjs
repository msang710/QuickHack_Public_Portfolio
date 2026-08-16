import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertPackageContentPolicy,
  createPackageInventory,
  findPackageContentViolations,
} from "../../packaging/common/package-inventory.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-package-inventory-"));
try {
  mkdirSync(path.join(root, "client"), { recursive: true });
  writeFileSync(path.join(root, "client", "entry.mjs"), "export {};\n", "utf8");
  const first = createPackageInventory(root);
  const second = createPackageInventory(root);
  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(findPackageContentViolations("OPERATIONAL_CLIENT", first.entries), []);
  assertPackageContentPolicy("OPERATIONAL_CLIENT", first.entries);
  assert.equal(
    findPackageContentViolations("OPERATIONAL_CLIENT", ["client/quickhack_server/platform/index.js"]).length,
    1
  );
  assert.throws(
    () => assertPackageContentPolicy("OPERATIONAL_SERVER", ["server/mock_server/index.mjs"]),
    (error) => error.code === "PACKAGE_CONTENT_FORBIDDEN"
  );
  assert.throws(
    () => assertPackageContentPolicy("DEMONSTRATION_SERVER", ["tools/server-console-operational.mjs"]),
    (error) => error.code === "PACKAGE_CONTENT_FORBIDDEN"
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("QuickHack canonical package inventory and role/flavor content policy verified.");
