import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectServerRuntimeClosure } from "../../packaging/common/server-runtime-closure.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-package-closure-"));
try {
  mkdirSync(path.join(root, "tools", "nested"), { recursive: true });
  writeFileSync(path.join(root, "tools", "entry.mjs"), 'import "./nested/child.mjs";\n', "utf8");
  writeFileSync(path.join(root, "tools", "nested", "child.mjs"), 'export { value } from "./value.mjs";\n', "utf8");
  writeFileSync(path.join(root, "tools", "nested", "value.mjs"), "export const value = 1;\n", "utf8");
  assert.deepEqual(
    collectServerRuntimeClosure({ rootDirectory: root, entrypoints: ["tools/entry.mjs"], seeds: [] }),
    ["tools/entry.mjs", "tools/nested/child.mjs", "tools/nested/value.mjs"]
  );
  writeFileSync(path.join(root, "tools", "broken.mjs"), 'import "./missing.mjs";\n', "utf8");
  assert.throws(
    () => collectServerRuntimeClosure({ rootDirectory: root, entrypoints: ["tools/broken.mjs"], seeds: [] }),
    (error) => error.code === "PACKAGE_RUNTIME_CLOSURE_MISSING"
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("QuickHack recursive server runtime closure and missing-import failure verified.");
