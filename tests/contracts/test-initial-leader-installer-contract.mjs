import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");

function source(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

const initializeInstall = source("packaging/initialize-install.ps1");
const finalizeInstall = source("packaging/finalize-install.ps1");
const installer = source("packaging/quickhack.iss");
const staging = source("packaging/create-staging-package.mjs");
const launcher = source("packaging/windows-launcher/QuickHackLauncher.cs");

assert.match(initializeInstall, /Set-PrivateDirectoryAcl/);
assert.match(initializeInstall, /--result-file/);
assert.match(initializeInstall, /--allow-create/);
assert.match(initializeInstall, /server-runtime\.json/);
assert.match(initializeInstall, /--runtime-config/);
assert.match(initializeInstall, /backupRetentionCount\s*=\s*30/);
assert.doesNotMatch(initializeInstall, /\$env:QUICKHACK_(?:ENV|DATA_DIR|WRITE_API_ENABLED)/);
assert.doesNotMatch(initializeInstall, /\$env:DATABASE_URL/);
assert.match(initializeInstall, /QUICKHACK_INITIAL_LEADER_RESULT_V1/);
assert.doesNotMatch(
  initializeInstall,
  /New-NetFirewallRule/,
  "The prepare phase must not expose the server before credential confirmation."
);
assert.doesNotMatch(
  initializeInstall,
  /Write-Host[^\r\n]*(result|password|credential)/i,
  "The prepare phase must not log credential material."
);

assert.match(finalizeInstall, /New-NetFirewallRule/);
assert.match(finalizeInstall, /RemoteAddress LocalSubnet/);

for (const contract of [
  /CreateCustomPage\(/,
  /status=CREATED/,
  /status=ALREADY_INITIALIZED/,
  /WizardSilent/,
  /LoadStringsFromFile/,
  /DeleteProvisionResult/,
  /InitialLeaderConfirmation\.Checked/,
  /RunFinalizeInstall/,
  /ClearInitialLeaderCredentials/,
]) {
  assert.match(installer, contract);
}
assert.doesNotMatch(
  installer,
  /Parameters\s*:=\s*[^;]*InitialLeaderPassword/,
  "The installer must not place the temporary password on a child command line."
);
assert.doesNotMatch(
  installer,
  /Log\([^\r\n]*InitialLeaderPassword/,
  "The installer must not log the temporary password."
);

for (const requiredFile of [
  "provision-initial-leader.mjs",
  "password.mjs",
  "initialize-install.ps1",
  "finalize-install.ps1",
]) {
  assert.match(
    staging,
    new RegExp(requiredFile.replaceAll(".", "\\.")),
    `The staging package is missing ${requiredFile}.`
  );
}

const migrateLauncher = staging.slice(
  staging.indexOf('writeLauncher("Migrate-Database.cmd"'),
  staging.indexOf('writeLauncher("Migrate-Demo-Database.cmd"')
);
assert.doesNotMatch(
  migrateLauncher,
  /provision-initial-leader/,
  "Manual database migration must not create an account."
);
assert.doesNotMatch(migrateLauncher, /backup-before-migrate/i);
assert.match(migrateLauncher, /deploy-postgresql-migrations\.mjs %\*/);
assert.match(launcher, /EnsureServerRuntimeConfig/);
assert.match(launcher, /server-runtime\.json/);
assert.doesNotMatch(launcher, /EnvironmentVariables\["QUICKHACK_(?:ENV|DATA_DIR|WRITE_API_ENABLED|QHKEY_ROOT)"\]/);
assert.doesNotMatch(launcher, /EnvironmentVariables\["DATABASE_URL"\]/);

console.log("Initial leader installer source contract verified.");
