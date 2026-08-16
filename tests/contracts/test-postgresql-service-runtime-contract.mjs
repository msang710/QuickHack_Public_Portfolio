import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const compatibilityEntry = read("tools/postgresql-service-install.mjs");
const service = read("tools/platform/windows/postgresql-service-install.mjs");
const core = read("tools/postgresql-service-core.mjs");
const installer = read("packaging/quickhack.iss");
const smoke = read("tests/integration/windows/test-postgresql-windows-service.ps1");

assert.match(service, /QUICKHACK_POSTGRESQL_SERVICE_NAME = "QuickHackPostgreSQL"/);
assert.match(service, /POSTGRESQL_TOOL_CAPABILITIES\.service/);
assert.match(service, /assertPostgresqlToolVersions/);
assert.match(
  service,
  /path\.join\(\s*context\.dataDir,\s*"postgresql",\s*POSTGRESQL_MAJOR,\s*"data"\s*\)/
);
assert.match(service, /existingVersion !== POSTGRESQL_MAJOR/);
assert.ok(
  core.indexOf("await adapter.validateToolchain") <
    core.indexOf("await adapter.prepareCredentials"),
  "PostgreSQL toolchain validation must precede credential and service mutation."
);
assert.match(service, /createPostgresqlServiceCore\(adapter\)\.installOrRepair/);
assert.match(compatibilityEntry, /composeServerPlatform\(\)\.postgresqlService\.install/);
assert.doesNotMatch(compatibilityEntry, /process\.platform|PowerShell|NetworkService/iu);
for (const source of [service, installer, smoke]) {
  assert.doesNotMatch(source, /QuickHackPostgreSQL17/);
}
assert.match(installer, /#define PostgresqlServiceName "QuickHackDemoPostgreSQL"/);
assert.match(installer, /Get-Service -Name ''\{#PostgresqlServiceName\}''/);
assert.match(installer, /sc\.exe delete \{#PostgresqlServiceName\}/);
assert.match(installer, /Get-Service -Name ''QuickHackPostgreSQL''/);
assert.doesNotMatch(installer, /sc\.exe delete QuickHackPostgreSQL/);
assert.match(smoke, /\$serviceName = "QuickHackPostgreSQL"/);

console.log("PostgreSQL 18 version-neutral Windows service contracts verified.");
