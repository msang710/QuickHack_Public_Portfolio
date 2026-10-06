import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePostgresqlClusterParent, installLinuxPostgresqlService, postgresOfflineResetArguments, renderManagedPostgresqlConfig, waitForRunningPostgresql, waitForStoppedService } from "../../tools/platform/linux/postgresql-service-install.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const source = readFileSync(path.join(root, "tools/platform/linux/postgresql-service-install.mjs"), "utf8");
const controller = readFileSync(path.join(root, "quickhack_server/platform/linux/postgresql-service-controller.mjs"), "utf8");

await assert.rejects(
  () => installLinuxPostgresqlService({}, { getuid: () => 1000 }),
  (error) => error?.code === "POSTGRESQL_ROOT_REQUIRED"
);
assert.match(source, /POSTGRESQL_TOOL_CAPABILITIES\.service/);
assert.match(source, /createPostgresqlServiceCore\(adapter\)\.installOrRepair/);
assert.match(source, /listen_addresses = '127\.0\.0\.1'/);
assert.match(renderManagedPostgresqlConfig(5543), /unix_socket_directories = ''/);
assert.match(renderManagedPostgresqlConfig(5543), /port = 5543/);
assert.match(source, /password_encryption = 'scram-sha-256'/);
assert.match(source, /initdbSecretPipeCommand\(executable, args\)/);
assert.match(source, /--pwfile=\/dev\/stdin/);
assert.match(source, /resetOperatorPasswordOffline/);
assert.deepEqual(postgresOfflineResetArguments("/tmp/quickhack-cluster"), ["--single", "-D", "/tmp/quickhack-cluster", "postgres"]);
assert.throws(() => postgresOfflineResetArguments("relative"), /absolute/);
const directoryRoot = mkdtempSync(path.join(os.tmpdir(), "quickhack-postgresql-directories-"));
try {
  const identity = { uid: process.getuid(), gid: process.getgid() };
  const clusterParent = await ensurePostgresqlClusterParent(directoryRoot, identity);
  assert.equal(clusterParent, path.join(directoryRoot, "postgresql", "18"));
  assert.equal(statSync(clusterParent).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(directoryRoot, "postgresql")).mode & 0o777, 0o700);
  const preserved = path.join(clusterParent, "preserved");
  writeFileSync(preserved, "existing data");
  await ensurePostgresqlClusterParent(directoryRoot, identity);
  assert.equal(readFileSync(preserved, "utf8"), "existing data");
  const invalidRoot = path.join(directoryRoot, "invalid");
  mkdirSync(invalidRoot);
  symlinkSync(clusterParent, path.join(invalidRoot, "postgresql"));
  await assert.rejects(() => ensurePostgresqlClusterParent(invalidRoot, identity), (error) => error.code === "POSTGRESQL_DIRECTORY_INVALID");
} finally {
  rmSync(directoryRoot, { recursive: true, force: true });
}
let stopped = false;
await waitForStoppedService({
  status: async () => ({ state: stopped ? "INACTIVE" : "ACTIVE" }),
  stop: async () => { stopped = true; },
});
assert.equal(stopped, true);
await assert.rejects(() => waitForStoppedService({ status: async () => ({ state: "MISSING" }) }), /missing/);
let checks = 0;
await waitForRunningPostgresql(
  { status: async () => ({ state: ++checks > 1 ? "ACTIVE" : "ACTIVATING" }) },
  { execFileText: async () => ({ ok: true }) },
  5543,
  1_000
);
assert.equal(checks, 2);
await assert.rejects(
  () => waitForRunningPostgresql({ status: async () => ({ state: "FAILED" }) }, { execFileText: async () => ({ ok: false }) }, 5543, 1),
  (error) => error?.code === "POSTGRESQL_START_SERVICE_WAIT_RUNNING_FAILED"
);
assert.match(source, /stdio: \["ignore", "pipe", "pipe", "pipe"\]/);
assert.doesNotMatch(source, /operator-password|bootstrap-password|password.*writeFile/iu);
assert.doesNotMatch(source, /process\.platform|powershell|\.exe["']/iu);
assert.match(controller, /tools\/platform\/linux\/postgresql-service-install\.mjs/);

console.log("Linux PostgreSQL root gate, common orchestration, loopback, and secret-FD bootstrap verified.");
