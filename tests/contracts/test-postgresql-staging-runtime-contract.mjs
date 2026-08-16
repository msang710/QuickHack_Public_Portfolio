import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const staging = read("packaging/create-staging-package.mjs");
const runtimeFiles = read("packaging/server-migration-runtime-files.mjs");
const manifest = read("packaging/demo-build.manifest.json");
const release = read("packaging/README-RELEASE.md");

assert.match(staging, /POSTGRESQL_TOOL_CAPABILITIES\.package/);
assert.match(staging, /assertPostgresqlToolVersions/);
assert.match(staging, /spawnSync\(executablePath, \["--version"\]/);
assert.match(staging, /"postgresql-portable", String\(POSTGRESQL_MAJOR_VERSION\)/);
assert.match(staging, /"PostgreSQL",\s*String\(POSTGRESQL_MAJOR_VERSION\)/);
assert.match(staging, /PostgreSQL \$\{POSTGRESQL_MAJOR_VERSION\} runtime was not found/);
assert.doesNotMatch(staging, /PostgreSQL 17|postgresql-portable", "17"/);
assert.match(runtimeFiles, /quickhack_shared\/platform\/native-runtime-contract\.mjs/);
assert.match(runtimeFiles, /quickhack_shared\/platform\/native-runtime-contract\.d\.mts/);
assert.match(manifest, /Windows server packages include PostgreSQL 18/);
assert.match(release, /system PostgreSQL 18/);
assert.match(release, /artifact-specific ProgramData/);
assert.doesNotMatch(release, /PostgreSQL 17|QuickHackPostgreSQL17/);

console.log("PostgreSQL 18 staging and release contracts verified.");
