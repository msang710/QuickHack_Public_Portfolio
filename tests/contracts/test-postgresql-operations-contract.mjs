import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const consoleSource = read("tools/server-console-core.mjs");
const operatorSource = read("tools/operator-direct-one-shot.mjs");
const serviceSource = read("tools/platform/windows/postgresql-service-install.mjs");
const serviceCoreSource = read("tools/postgresql-service-core.mjs");
const restoreSource = read("tools/postgresql-restore.mjs");
const backupSource = read("tools/postgresql-backup.mjs");
const initializeSource = read("packaging/initialize-install.ps1");
const stagingSource = read("packaging/create-staging-package.mjs");
const serviceSmokeSource = read("tests/integration/windows/test-postgresql-windows-service.ps1");
const workflowSource = read(".github/workflows/windows-release.yml");
const pullRequestWorkflowSource = read(".github/workflows/pull-request-checks.yml");
const installerSource = read("packaging/quickhack.iss");
const installerPreflightSource = read("packaging/windows/invoke-install-preflight.ps1");
const installerBuildSource = read("packaging/build-installer.ps1");
const migrationSource = read("tools/deploy-postgresql-migrations.mjs");
const asyncPowerShellSource = read("quickhack_server/platform/windows/security-process.mjs");
const protectedSecretSource = read("quickhack_server/platform/windows/server-secret-protector.mjs");
const postgresqlCredentialSource = read("quickhack_server/core/database/postgresql-credential.mjs");
const packageFlavorSource = read("quickhack_shared/core/package-flavor-contract.mjs");
const initializeClusterSource = serviceSource.slice(
  serviceSource.indexOf("async function initializeCluster"),
  serviceSource.indexOf("async function writeTextFileAtomic")
);

assert.doesNotMatch(consoleSource, /POSTGRESQL_OPERATIONS_NOT_READY/);
assert.doesNotMatch(consoleSource, /postgresql-restore\.mjs|deploy-postgresql-migrations\.mjs/);
assert.match(consoleSource, /migration, restore, 최초 책임자/);
assert.match(consoleSource, /RESTORE_RECOVERY_REQUIRED/);
assert.match(consoleSource, /completeRestoreBarrier\(restoreBarrier\)/);
assert.ok(
  consoleSource.indexOf("await completeRestoreBarrier(restoreBarrier)") <
    consoleSource.indexOf('spawnOwned("gateway"'),
  "The HTTPS gateway can start before the restored security state is verified."
);
assert.match(operatorSource, /deploy-postgresql-migrations\.mjs/);
assert.match(operatorSource, /postgresql-restore\.mjs/);
assert.match(operatorSource, /provision-initial-leader\.mjs/);
assert.match(operatorSource, /CREDENTIALS_DIRECTORY/);
assert.match(operatorSource, /defaultRestoreRequestHandoff/);
assert.match(operatorSource, /restoreHandoff\.claim\(runtimeConfig\)/);
assert.match(operatorSource, /restoreHandoff\.finalize\(restoreRequest, restoreTerminalState\)/);
assert.doesNotMatch(
  operatorSource,
  /writeFileSync\([^\n]*restore-request\.json/,
  "The direct operator must not bypass the durable restore handoff abstraction."
);
assert.match(serviceSource, /listen_addresses = '127\.0\.0\.1'/);
assert.match(serviceSource, /scram-sha-256/);
assert.match(serviceSource, /quickhack_operator/);
assert.match(packageFlavorSource, /user: "quickhack_backup"/);
assert.match(serviceSource, /NetworkService/);
assert.match(serviceSource, /Start-Service/);
assert.doesNotMatch(serviceSource, /executable\(binDirectory, "pg_ctl"\), \[\s*"start"/);
assert.match(
  serviceSource,
  /"register",\s*"-N", serviceName,\s*"-D", clusterDirectory,\s*"-S", "auto",\s*"-U", "NT AUTHORITY\\\\NetworkService"/
);
assert.match(serviceSource, /QuickHackDemoPostgreSQL/);
assert.match(serviceSource, /QuickHackOperationalPostgreSQL/);
assert.match(serviceSource, /assertPortAvailable/);
assert.match(serviceSource, /assertPostgresqlToolVersions/);
assert.match(serviceSource, /POSTGRESQL_TOOL_CAPABILITIES\.service/);
assert.match(
  asyncPowerShellSource,
  /WINDOWS_SECURITY_OPERATION_TIMEOUT_MS = 60_000/
);
assert.match(asyncPowerShellSource, /return `\$\{line\}\\r\\n`/);
assert.match(asyncPowerShellSource, /inputLine must contain exactly one line/);
assert.match(asyncPowerShellSource, /error\.code = "POWERSHELL_TIMEOUT"/);
assert.match(asyncPowerShellSource, /options\.timeoutAttempts/);
assert.equal(
  protectedSecretSource.match(/inputLine:/g)?.length,
  3,
  "Windows secret inputs, including synchronous bootstrap, must use explicit line framing."
);
assert.match(asyncPowerShellSource, /resolveWindowsSystemExecutable/);
assert.match(protectedSecretSource, /runCommand\(\s*"icacls"/);
assert.match(protectedSecretSource, /\/inheritance:r/);
assert.match(protectedSecretSource, /\/grant:r/);
assert.match(protectedSecretSource, /assertExactDirectoryAcl/);
assert.doesNotMatch(protectedSecretSource, /Set-Acl/);
assert.doesNotMatch(protectedSecretSource, /ReadToEnd/);
assert.doesNotMatch(serviceSource, /ReadToEnd/);
assert.doesNotMatch(postgresqlCredentialSource, /ReadToEnd/);
assert.match(
  serviceSource,
  /WINDOWS_SERVICE_QUERY_TIMEOUT_MS = 60_000/
);
assert.equal(
  protectedSecretSource.match(/timeoutMs: WINDOWS_SECURITY_OPERATION_TIMEOUT_MS/g)?.length,
  4,
  "Windows secret operations must share the hosted-runner-safe timeout."
);
assert.equal(
  protectedSecretSource.match(/timeoutAttempts: 2/g)?.length,
  3,
  "Idempotent Windows secret operations must absorb one transient hosted-runner timeout."
);
assert.match(
  protectedSecretSource,
  /unprotectSync\(kind, payload\)/
);
assert.match(
  serviceSource,
  /timeoutMs: WINDOWS_SERVICE_QUERY_TIMEOUT_MS/
);
assert.doesNotMatch(serviceSource, /--password/);
assert.match(serviceSource, /quickhack-initdb-/);
assert.match(serviceSource, /net\.createServer/);
assert.doesNotMatch(serviceSource, /bootstrap-password|operator-password/);
const parentAclIndex = initializeClusterSource.indexOf(
  "securePostgresqlClusterDirectory(path.dirname(clusterDirectory))"
);
const initdbIndex = initializeClusterSource.indexOf(
  'await runExecutable(executable(binDirectory, "initdb")'
);
const clusterAclIndex = initializeClusterSource.indexOf(
  "securePostgresqlClusterDirectory(clusterDirectory)"
);
assert.ok(parentAclIndex >= 0 && parentAclIndex < initdbIndex);
assert.ok(initdbIndex < clusterAclIndex);
assert.doesNotMatch(
  initializeClusterSource.slice(0, initdbIndex),
  /securePostgresqlClusterDirectory\(clusterDirectory\)/,
  "Windows initdb must create its own staging target inside the protected parent."
);
for (const code of [
  "POSTGRESQL_INITIALIZE_PARENT_ACL_FAILED",
  "POSTGRESQL_INITIALIZE_STAGING_EXISTS_FAILED",
  "POSTGRESQL_INITIALIZE_INITDB_TARGET_EXISTS_FAILED",
  "POSTGRESQL_INITIALIZE_INITDB_ACCESS_FAILED",
  "POSTGRESQL_INITIALIZE_INITDB_PROCESS_FAILED",
  "POSTGRESQL_INITIALIZE_TARGET_ACL_FAILED",
  "POSTGRESQL_INITIALIZE_ATOMIC_RENAME_FAILED",
]) {
  assert.ok(serviceSource.includes(code), `Windows PostgreSQL adapter is missing ${code}.`);
  assert.ok(serviceCoreSource.includes(code), `PostgreSQL core allowlist is missing ${code}.`);
}
assert.match(restoreSource, /DELETE FROM user_sessions/);
assert.match(restoreSource, /DELETE FROM mobile_registered_devices/);
assert.match(restoreSource, /DELETE FROM user_totp_credentials/);
assert.match(restoreSource, /UPDATE server_worker_jobs/);
assert.match(restoreSource, /lease_token = NULL/);
assert.match(restoreSource, /instance_epoch = instance_epoch \+ 1/);
assert.match(restoreSource, /recoverOperationalPostgresqlCutover/);
assert.match(restoreSource, /REVOKE UPDATE, DELETE ON TABLE/);
assert.match(migrationSource, /REVOKE UPDATE, DELETE ON TABLE/);
assert.match(migrationSource, /runPrismaMigrateDeploy\(runtimeConfigPath\)/);
assert.match(migrationSource, /QUICKHACK_PRISMA_RUNTIME_CONFIG_PATH/);
assert.match(migrationSource, /GRANT SELECT ON ALL SEQUENCES/);
assert.match(initializeSource, /schemaVersion = 3/);
assert.match(initializeSource, /packageFlavor = \$expectedFlavor/);
assert.match(initializeSource, /postgresql-service-install\.mjs/);
assert.match(stagingSource, /PostgreSQL \$\{POSTGRESQL_MAJOR_VERSION\} runtime was not found/);
assert.match(stagingSource, /assertPostgresqlToolVersions/);
assert.match(stagingSource, /copyInstalledPackageClosure\("prisma"\)/);
assert.match(stagingSource, /POSTGRESQL_TOOL_CAPABILITIES\.package/);
assert.match(stagingSource, /`\$\{tool\}\.exe`/);
assert.match(backupSource, /createPostgresqlBackup/);
assert.match(backupSource, /verifyPostgresqlBackupsAndApplyRetention/);
assert.doesNotMatch(workflowSource, /release-not-ready|POSTGRESQL_OPERATIONS_NOT_READY/);
assert.match(workflowSource, /matrix:[\s\S]*demo-server[\s\S]*operational-server/u);
assert.doesNotMatch(pullRequestWorkflowSource, /pull_request:/);
assert.match(pullRequestWorkflowSource, /workflow_dispatch:/);
assert.match(pullRequestWorkflowSource, /windows-package-matrix/);
assert.match(pullRequestWorkflowSource, /linux-package-matrix/);
assert.match(serviceSmokeSource, /Join-Path \$env:ProgramData "QuickHack-CI"/);
assert.doesNotMatch(serviceSmokeSource, /RUNNER_TEMP/);
assert.match(installerSource, /function PrepareToInstall/);
assert.match(installerSource, /invoke-install-preflight\.ps1/);
assert.match(installerPreflightSource, /Stop-Service -InputObject \$Service -Force/);
assert.match(installerPreflightSource, /OwnPostgresqlServiceName/);
assert.match(installerPreflightSource, /StopTimeout = 35/);
assert.match(installerSource, /sc\.exe delete \{#PostgresqlServiceName\}/);
assert.match(installerBuildSource, /System\.Security\.Cryptography\.SHA256/);
assert.match(installerBuildSource, /System\.IO\.File]::OpenRead/);
assert.doesNotMatch(installerBuildSource, /Get-FileHash/);

console.log("PostgreSQL Windows service, restore barrier, console, and release source contracts verified.");
