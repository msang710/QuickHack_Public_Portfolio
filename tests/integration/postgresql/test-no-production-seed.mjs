import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../support/postgresql-test-scope.mjs";

const removedFiles = [
  "app/api/developer/seed-data/route.ts",
  "quickhack_server/api/developer/seed-data.ts",
  "quickhack_shared/core/developer-seed-policy.ts",
  "tools/seed-test-users.mjs",
];
for (const relativePath of removedFiles) {
  assert.equal(existsSync(path.join(projectRoot, relativePath)), false, `${relativePath} must stay removed.`);
}

const packageSource = readFileSync(path.join(projectRoot, "package.json"), "utf8");
const menuSource = readFileSync(
  path.join(projectRoot, "quickhack_client/components/app-shell/device-workspace-menu.ts"),
  "utf8"
);
const diagnosticsSource = readFileSync(
  path.join(projectRoot, "quickhack_server/api/developer/diagnostics.ts"),
  "utf8"
);
const randomFixtureSource = readFileSync(
  path.join(projectRoot, "tests/support/random-test-account.mjs"),
  "utf8"
);
const accountSecurityTestSource = readFileSync(
  path.join(projectRoot, "tests/integration/postgresql/test-account-security.mjs"),
  "utf8"
);
assert.doesNotMatch(packageSource, /seed:test-users|production-seed-boundary/);
assert.doesNotMatch(menuSource, /developer-seed-data/);
assert.doesNotMatch(diagnosticsSource, /allowDeveloperSeed|developerSeedAllowed/);
assert.match(randomFixtureSource, /assertTemporaryDatabaseScope/);
assert.match(randomFixtureSource, /randomBytes/);
assert.match(accountSecurityTestSource, /createRandomTestAccount/);
console.log("Production seed surfaces are absent; test identities are fixture-only.");
