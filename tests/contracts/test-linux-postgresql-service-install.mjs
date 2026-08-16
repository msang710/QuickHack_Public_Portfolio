import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { installLinuxPostgresqlService } from "../../tools/platform/linux/postgresql-service-install.mjs";

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
assert.match(source, /password_encryption = 'scram-sha-256'/);
assert.match(source, /--pwfile=\/proc\/self\/fd\/3/);
assert.match(source, /stdio: \["ignore", "pipe", "pipe", "pipe"\]/);
assert.doesNotMatch(source, /operator-password|bootstrap-password|password.*writeFile/iu);
assert.doesNotMatch(source, /process\.platform|powershell|\.exe["']/iu);
assert.match(controller, /tools\/platform\/linux\/postgresql-service-install\.mjs/);

console.log("Linux PostgreSQL root gate, common orchestration, loopback, and secret-FD bootstrap verified.");
