import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  NATIVE_RUNTIME_CONTRACT,
  NativeRuntimeContractError,
  POSTGRESQL_MAJOR_VERSION,
  assertNativeRuntimeCapabilities,
  assertPostgresqlToolVersions,
  parsePostgresqlMajorVersion,
} from "../../quickhack_shared/platform/native-runtime-contract.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const npmrc = readFileSync(path.join(root, ".npmrc"), "utf8");
const finalIntegrationWorkflow = readFileSync(
  path.join(root, ".github", "workflows", "pull-request-checks.yml"),
  "utf8"
);
const windowsDemoWorkflow = readFileSync(
  path.join(root, ".github", "workflows", "windows-demo-release.yml"),
  "utf8"
);

assert.equal(POSTGRESQL_MAJOR_VERSION, 18);
assert.equal(NATIVE_RUNTIME_CONTRACT.node.engines, ">=24 <25");
assert.equal(NATIVE_RUNTIME_CONTRACT.npm.packageManager, "npm@12.0.2");
assert.equal(packageJson.engines.node, NATIVE_RUNTIME_CONTRACT.node.engines);
assert.equal(packageJson.engines.npm, ">=12 <13");
assert.equal(packageJson.packageManager, NATIVE_RUNTIME_CONTRACT.npm.packageManager);
assert.equal(packageLock.packages[""].engines.npm, packageJson.engines.npm);
assert.deepEqual(packageJson.allowScripts, {
  "prisma@7.9.1": true,
  "@prisma/engines@7.9.1": true,
  "unrs-resolver@1.12.2": true,
});
assert.match(npmrc, /^strict-allow-scripts=true$/m);
assert.equal(
  finalIntegrationWorkflow.match(/npm install --global npm@12\.0\.2/g)?.length,
  3,
  "Every npm-based Final Integration job must pin npm 12.0.2."
);
assert.equal(
  windowsDemoWorkflow.match(/npm install --global npm@12\.0\.2/g)?.length,
  undefined,
  "The production signing workflow must not install npm when it only consumes prebuilt artifacts."
);
assert.equal(parsePostgresqlMajorVersion("postgres (PostgreSQL) 18.4"), 18);
assert.equal(parsePostgresqlMajorVersion("pg_dump (PostgreSQL) 18.1", "pg_dump"), 18);

const packageVersions = Object.fromEntries(
  NATIVE_RUNTIME_CONTRACT.postgresql.tools.package.map((tool) => [
    tool,
    `${tool} (PostgreSQL) 18.4`,
  ])
);
assert.deepEqual(
  assertPostgresqlToolVersions(packageVersions).tools,
  Object.fromEntries(
    NATIVE_RUNTIME_CONTRACT.postgresql.tools.package.map((tool) => [tool, 18])
  )
);
assert.deepEqual(
  assertNativeRuntimeCapabilities({
    node: "v24.17.0",
    npm: "12.0.2",
    postgresql: { capability: "backup", versions: packageVersions },
  }).postgresql.tools,
  { psql: 18, pg_dump: 18, pg_restore: 18 }
);

for (const input of [
  { ...packageVersions, postgres: "postgres (PostgreSQL) 17.9" },
  { ...packageVersions, pg_dump: "unknown" },
]) {
  assert.throws(
    () => assertPostgresqlToolVersions(input),
    (error) =>
      error instanceof NativeRuntimeContractError &&
      error.code === "DEPENDENCY_VERSION_MISMATCH"
  );
}

const missingPsql = { ...packageVersions };
delete missingPsql.psql;
assert.throws(
  () => assertPostgresqlToolVersions(missingPsql),
  (error) =>
    error instanceof NativeRuntimeContractError &&
    error.code === "DEPENDENCY_MISSING"
);
assert.throws(
  () => assertNativeRuntimeCapabilities({ node: "23.11.0" }),
  (error) => error.code === "DEPENDENCY_VERSION_MISMATCH"
);
assert.throws(
  () => assertNativeRuntimeCapabilities({ npm: "11.13.0" }),
  (error) => error.code === "DEPENDENCY_VERSION_MISMATCH"
);
assert.throws(
  () => assertNativeRuntimeCapabilities({ npm: "13.0.0" }),
  (error) => error.code === "DEPENDENCY_VERSION_MISMATCH"
);

console.log("Native runtime and PostgreSQL capability contracts verified.");
