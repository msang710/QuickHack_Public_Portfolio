import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSystemdServiceProcess } from "../../tools/platform/linux/systemd-service-process.mjs";
import { createLinuxPostgresqlServiceController } from "../../quickhack_server/platform/linux/postgresql-service-controller.mjs";

const calls = [];
const run = async (args, options) => {
  calls.push({ args: [...args], options });
  if (args[0] === "show") {
    return {
      stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=120\nResult=success\n",
      stderr: "",
    };
  }
  return { stdout: "", stderr: "" };
};
const serviceProcess = createSystemdServiceProcess({ run });
const controller = createLinuxPostgresqlServiceController({ serviceProcess });
assert.equal(controller.descriptor.state, "READY");
assert.equal((await controller.status({ timeoutMs: 2000 })).state, "ACTIVE");
assert.equal(calls[0].options.timeoutMs, 2000);
assert.equal((await controller.restart()).operation, "RESTART");
assert.deepEqual(calls[1].args, ["restart", "quickhack-postgresql.service"]);
assert.throws(
  () => createSystemdServiceProcess({ units: { POSTGRESQL: "../../evil.service" } }),
  (error) => error.code === "SERVICE_UNIT_INVALID"
);
const injectedController = createLinuxPostgresqlServiceController({ serviceProcess, install: async () => ({ ok: true }) });
assert.deepEqual(await injectedController.install({}), { ok: true });

const root = path.resolve(import.meta.dirname, "..", "..");
const unit = readFileSync(path.join(root, "packaging/linux/systemd/quickhack-postgresql.service.in"), "utf8");
assert.match(unit, /QuickHack PostgreSQL 18/);
assert.match(unit, /ExecStart=@QUICKHACK_POSTGRES_EXECUTABLE@/);
assert.match(unit, /ConditionPathIsDirectory=@QUICKHACK_PGDATA@/);
assert.match(unit, /^ReadWritePaths=@QUICKHACK_PGDATA@$/m);
assert.doesNotMatch(unit, /@QUICKHACK_POSTGRESQL_LOG_DIR@/);
assert.match(unit, /listen|config_file=/);
assert.doesNotMatch(unit, /\/usr\/bin\/postgres\b/);

console.log("Linux systemd PostgreSQL service controller and unit template verified.");
