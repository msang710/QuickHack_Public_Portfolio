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

assert.equal(POSTGRESQL_MAJOR_VERSION, 18);
assert.equal(NATIVE_RUNTIME_CONTRACT.node.engines, ">=24 <25");
assert.equal(NATIVE_RUNTIME_CONTRACT.npm.packageManager, "npm@11.13.0");
assert.equal(packageJson.engines.node, NATIVE_RUNTIME_CONTRACT.node.engines);
assert.equal(packageJson.engines.npm, ">=11 <12");
assert.equal(packageJson.packageManager, NATIVE_RUNTIME_CONTRACT.npm.packageManager);
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
    npm: "11.13.0",
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
  () => assertNativeRuntimeCapabilities({ npm: "10.9.0" }),
  (error) => error.code === "DEPENDENCY_VERSION_MISMATCH"
);

console.log("Native runtime and PostgreSQL capability contracts verified.");
