import assert from "node:assert/strict";
import { createLinuxPackageLifecycle, linuxPackageDependencies } from "../../tools/platform/linux/package-lifecycle.mjs";

function runtimeFixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      getuid: () => 0,
      assertExecutable: async (filename) => calls.push(["executable", filename]),
      postgresqlVersion: async () => "postgres (PostgreSQL) 18.4",
      unitExists: async () => false,
      ensureRuntimeConfig: async (config) => calls.push(["config", config.runtimeConfig]),
      runOperator: async (config, operation) => calls.push(["operator", operation, config.artifactKind]),
      enableAndStart: async (units) => calls.push(["enable", ...units]),
      disableAndStop: async (units) => calls.push(["disable", ...units]),
      removeOwnedPaths: async (paths) => calls.push(["remove", ...paths]),
      ...overrides,
    },
  };
}

assert.ok(linuxPackageDependencies("DEMONSTRATION_SERVER").includes("/usr/bin/postgres"));
assert.deepEqual(linuxPackageDependencies("OPERATIONAL_CLIENT"), ["/usr/bin/node", "/usr/bin/adb", "/usr/bin/lp", "/usr/bin/lpstat"]);

const setupFixture = runtimeFixture();
const lifecycle = createLinuxPackageLifecycle({ runtime: setupFixture.runtime });
assert.deepEqual(await lifecycle.setup({ artifactKind: "DEMONSTRATION_SERVER" }), {
  operation: "INSTALL",
  artifactKind: "DEMONSTRATION_SERVER",
  state: "ACTIVE",
});
assert.ok(setupFixture.calls.some((call) => call[0] === "operator" && call[1] === "INSTALL"));
assert.ok(setupFixture.calls.some((call) => call[0] === "enable" && call.includes("quickhack-demonstration-console.service")));

const repairFixture = runtimeFixture();
await createLinuxPackageLifecycle({ runtime: repairFixture.runtime }).repair({ artifactKind: "OPERATIONAL_SERVER" });
assert.ok(repairFixture.calls.some((call) => call[0] === "operator" && call[1] === "REPAIR"));

const conflictFixture = runtimeFixture({ unitExists: async () => true });
await assert.rejects(
  () => createLinuxPackageLifecycle({ runtime: conflictFixture.runtime }).setup({ artifactKind: "DEMONSTRATION_SERVER" }),
  (error) => error?.code === "SERVER_FLAVOR_CONFLICT"
);
assert.equal(conflictFixture.calls.length, 0);

const wrongVersion = runtimeFixture({ postgresqlVersion: async () => "postgres (PostgreSQL) 17.9" });
await assert.rejects(
  () => createLinuxPackageLifecycle({ runtime: wrongVersion.runtime }).setup({ artifactKind: "OPERATIONAL_SERVER" }),
  (error) => error?.code === "POSTGRESQL_MAJOR_UNSUPPORTED"
);
assert.equal(wrongVersion.calls.some((call) => call[0] === "operator"), false);

const purgeFixture = runtimeFixture();
const purge = await createLinuxPackageLifecycle({ runtime: purgeFixture.runtime }).purge({
  artifactKind: "OPERATIONAL_SERVER",
  backupVerified: true,
  confirmation: {
    artifactKind: "OPERATIONAL_SERVER",
    irreversible: true,
    noRecoveryAcknowledged: false,
  },
});
assert.equal(purge.preserveMutableState, false);
assert.ok(purgeFixture.calls.some((call) => call[0] === "remove" && call.includes("/var/lib/quickhack/operational-server")));

const uninstall = lifecycle.uninstall({ artifactKind: "DEMONSTRATION_SERVER" });
assert.equal(uninstall.preserveMutableState, true);
assert.deepEqual(uninstall.removeMutablePaths, []);

console.log("Linux setup, repair, conflict, dependency, preserve, and purge lifecycle verified.");
