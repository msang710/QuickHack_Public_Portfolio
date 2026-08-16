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
  RUNTIME_PACKAGE_FORBIDDEN_SOURCE_DIRECTORIES,
  assertNoRuntimePackageSources,
  findRuntimePackageSourceViolations,
} from "../../packaging/runtime-package-source-boundary.mjs";
import { projectRoot } from "../support/project-root.mjs";

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "quickhack-package-boundary-"));

function write(relativePath, source = "fixture") {
  const target = path.join(fixtureRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source, "utf8");
}

try {
  write("server/server.js");
  write("server/tools/verify-postgresql-operational-roles.mjs");
  write("server/node_modules/example/tests/fixture.mjs");
  assert.deepEqual(findRuntimePackageSourceViolations(fixtureRoot), []);
  assert.doesNotThrow(() => assertNoRuntimePackageSources(fixtureRoot));

  write("server/tests/contracts/test-leak.mjs");
  write("server/specs/feature.md");
  write("portfolio/source/react-flow.tsx");
  write("generated/report.json");
  write("server/tools/test-runtime-leak.mjs");

  const violations = findRuntimePackageSourceViolations(fixtureRoot);
  assert.deepEqual(violations, [
    "generated/",
    "portfolio/",
    "server/specs/",
    "server/tests/",
    "server/tools/test-runtime-leak.mjs",
  ]);
  assert.throws(
    () => assertNoRuntimePackageSources(fixtureRoot),
    /Development source entered the runtime package/
  );

  const manifest = JSON.parse(
    readFileSync(path.join(projectRoot, "packaging", "demo-build.manifest.json"), "utf8")
  );
  for (const directoryName of RUNTIME_PACKAGE_FORBIDDEN_SOURCE_DIRECTORIES) {
    assert.ok(
      manifest.exclude.includes(`${directoryName}/`),
      `Demo build manifest must exclude ${directoryName}/.`
    );
  }
  assert.ok(
    manifest.include.includes("tools/verify-postgresql-operational-roles.mjs"),
    "The package must retain the operational PostgreSQL role verification command."
  );
  assert.ok(
    manifest.include.includes("packaging/runtime-package-source-boundary.mjs"),
    "The source package must include the staging source-boundary implementation."
  );
  assert.equal(
    manifest.include.some((entry) => entry.startsWith("tests/")),
    false,
    "The package include list must not opt test source back in."
  );

  const stagingSource = readFileSync(
    path.join(projectRoot, "packaging", "create-staging-package.mjs"),
    "utf8"
  );
  assert.match(stagingSource, /assertNoRuntimePackageSources\(outputDir\)/);

  console.log("Runtime package development-source boundary verified.");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
