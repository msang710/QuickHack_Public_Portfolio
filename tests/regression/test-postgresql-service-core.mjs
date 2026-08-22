import assert from "node:assert/strict";
import { createPostgresqlServiceCore } from "../../tools/postgresql-service-core.mjs";

const runtimeConfig = {
  packageFlavor: "OPERATIONAL",
  database: {
    name: "quickhack",
    migratorUser: "quickhack_migrator",
    runtimeUser: "quickhack_runtime",
    host: "127.0.0.1",
    port: 5432,
  },
};

function fixture({ fresh = true, failAt = "", failureCode = "" } = {}) {
  const order = [];
  const call = (name, result) => async () => {
    order.push(name);
    if (failAt === name) {
      const error = new Error("fixture failure");
      if (failureCode) error.code = failureCode;
      throw error;
    }
    return result;
  };
  return {
    order,
    adapter: {
      inspect: call("inspect", { fresh, serviceName: "fixture", clusterDirectory: "/data" }),
      validateToolchain: call("validateToolchain"),
      assertPortAvailable: call("assertPortAvailable"),
      prepareCredentials: call("prepareCredentials", { state: "PREPARED", secret: "must-not-leak" }),
      initializeCluster: call("initializeCluster"),
      configureCluster: call("configureCluster"),
      registerService: call("registerService"),
      startService: call("startService"),
      provisionCatalog: call("provisionCatalog"),
      commitCredentials: call("commitCredentials", { state: "COMMITTED" }),
      activateCredentials: call("activateCredentials"),
      rollbackCredentials: call("rollbackCredentials"),
      rollbackFreshCluster: call("rollbackFreshCluster"),
      disposeCredentials: call("disposeCredentials"),
    },
  };
}

const fresh = fixture();
const result = await createPostgresqlServiceCore(fresh.adapter).installOrRepair({ runtimeConfig });
assert.equal(result.fresh, true);
assert.equal(result.roles, 4);
assert.equal(result.databases, 1);
assert.ok(fresh.order.indexOf("validateToolchain") < fresh.order.indexOf("prepareCredentials"));
assert.ok(fresh.order.indexOf("provisionCatalog") < fresh.order.indexOf("commitCredentials"));
assert.equal(JSON.stringify(result).includes("must-not-leak"), false);

const repair = fixture({ fresh: false });
await createPostgresqlServiceCore(repair.adapter).installOrRepair({ runtimeConfig });
assert.equal(repair.order.includes("assertPortAvailable"), false);
assert.equal(repair.order.includes("initializeCluster"), false);

const failureSteps = new Map([
  ["inspect", "INSPECT"],
  ["validateToolchain", "VALIDATE_TOOLCHAIN"],
  ["assertPortAvailable", "VALIDATE_PORT"],
  ["prepareCredentials", "PREPARE_CREDENTIALS"],
  ["initializeCluster", "INITIALIZE_CLUSTER"],
  ["configureCluster", "CONFIGURE_CLUSTER"],
  ["registerService", "REGISTER_SERVICE"],
  ["startService", "START_SERVICE"],
  ["provisionCatalog", "PROVISION_CATALOG"],
  ["commitCredentials", "COMMIT_CREDENTIALS"],
  ["activateCredentials", "ACTIVATE_CREDENTIALS"],
]);
for (const [failAt, failedStep] of failureSteps) {
  const stageFailure = fixture({ failAt });
  await assert.rejects(
    () => createPostgresqlServiceCore(stageFailure.adapter).installOrRepair({ runtimeConfig }),
    (error) =>
      error.code === `POSTGRESQL_${failedStep}_FAILED` &&
      error.categoryCode === "POSTGRESQL_SERVICE_SETUP_FAILED" &&
      error.failedStep === failedStep &&
      !JSON.stringify(error).includes("must-not-leak")
  );
}

const initializationDetailCodes = [
  "POSTGRESQL_INITIALIZE_PARENT_ACL_FAILED",
  "POSTGRESQL_INITIALIZE_STAGING_EXISTS_FAILED",
  "POSTGRESQL_INITIALIZE_INITDB_TARGET_EXISTS_FAILED",
  "POSTGRESQL_INITIALIZE_INITDB_ACCESS_FAILED",
  "POSTGRESQL_INITIALIZE_INITDB_PROCESS_FAILED",
  "POSTGRESQL_INITIALIZE_TARGET_ACL_FAILED",
  "POSTGRESQL_INITIALIZE_ATOMIC_RENAME_FAILED",
];
for (const failureCode of initializationDetailCodes) {
  const detailFailure = fixture({ failAt: "initializeCluster", failureCode });
  await assert.rejects(
    () => createPostgresqlServiceCore(detailFailure.adapter).installOrRepair({ runtimeConfig }),
    (error) =>
      error.code === failureCode &&
      error.categoryCode === "POSTGRESQL_SERVICE_SETUP_FAILED" &&
      error.failedStep === "INITIALIZE_CLUSTER" &&
      !JSON.stringify(error).includes("must-not-leak")
  );
}
const unlistedDetail = fixture({
  failAt: "initializeCluster",
  failureCode: "POSTGRESQL_INITIALIZE_MUST_NOT_LEAK_FAILED",
});
await assert.rejects(
  () => createPostgresqlServiceCore(unlistedDetail.adapter).installOrRepair({ runtimeConfig }),
  (error) => error.code === "POSTGRESQL_INITIALIZE_CLUSTER_FAILED"
);

const failed = fixture({ failAt: "activateCredentials" });
await assert.rejects(
  () => createPostgresqlServiceCore(failed.adapter).installOrRepair({ runtimeConfig }),
  (error) => error.journal.some((entry) => entry.step === "ROLLBACK_CREDENTIALS")
);
assert.ok(failed.order.indexOf("rollbackCredentials") > failed.order.indexOf("activateCredentials"));

console.log("PostgreSQL install/repair orchestration, transaction order, and rollback verified.");
