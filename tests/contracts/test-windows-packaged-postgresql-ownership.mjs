import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  QUICKHACK_POSTGRESQL_SERVICE_OWNERSHIP,
  postgresqlServiceRegistrationPlan,
} from "../../tools/platform/windows/postgresql-service-ownership.mjs";

assert.deepEqual(QUICKHACK_POSTGRESQL_SERVICE_OWNERSHIP, ["COMPATIBILITY", "PACKAGED"]);

const packageRoot = path.resolve("C:/Program Files/WindowsApps/QuickHack.Demonstration.Server_1.0.0.0_x64");
const mutableData = path.resolve("C:/ProgramData/QuickHack/demonstration-server/data");
const packaged = postgresqlServiceRegistrationPlan({
  serviceOwnership: "PACKAGED",
  serviceName: "QuickHackDemoPostgreSQL",
  installDir: packageRoot,
  dataDir: mutableData,
});
assert.equal(packaged.ownership, "PACKAGED");
assert.equal(packaged.registrationMutation, false);
assert.equal(
  packaged.expectedHostPath,
  path.join(packageRoot, "Services", "QuickHackPostgresqlServiceHost.exe")
);
assert.equal(
  packaged.readinessMarkerPath,
  path.join(path.dirname(mutableData), "provisioning", "POSTGRES_CLUSTER_READY")
);

const compatibility = postgresqlServiceRegistrationPlan({
  serviceOwnership: "COMPATIBILITY",
  serviceName: "QuickHackDemoPostgreSQL",
  installDir: packageRoot,
  dataDir: mutableData,
});
assert.equal(compatibility.registrationMutation, true);
assert.equal(compatibility.expectedHostPath, null);
assert.equal(
  postgresqlServiceRegistrationPlan({
    serviceOwnership: "COMPATIBILITY",
    serviceName: "QuickHackDemoPostgreSQL",
    installDir: packageRoot,
    dataDir: path.dirname(mutableData),
  }).registrationMutation,
  true
);
assert.throws(
  () => postgresqlServiceRegistrationPlan({
    serviceOwnership: "PACKAGED",
    serviceName: "QuickHackDemoPostgreSQL",
    installDir: packageRoot,
    dataDir: path.dirname(mutableData),
  }),
  /owned data root/u
);
assert.throws(
  () => postgresqlServiceRegistrationPlan({
    serviceOwnership: "UNKNOWN",
    serviceName: "QuickHackDemoPostgreSQL",
    installDir: packageRoot,
    dataDir: mutableData,
  }),
  /ownership mode/u
);

const source = readFileSync(
  new URL("../../tools/platform/windows/postgresql-service-install.mjs", import.meta.url),
  "utf8"
);
const packagedBranch = source.slice(
  source.indexOf('if (plan.ownership === "PACKAGED")'),
  source.indexOf("async startService", source.indexOf('if (plan.ownership === "PACKAGED")'))
);
const packagedOnly = packagedBranch.slice(0, packagedBranch.indexOf("} else"));
assert.match(packagedOnly, /ensurePackagedServiceRegistered/u);
assert.match(packagedOnly, /publishPostgresqlReadinessMarker/u);
assert.doesNotMatch(packagedOnly, /pg_ctl|ensureServiceRegistered/u);
assert.match(source, /PACKAGED_POSTGRESQL_SERVICE_MISSING/u);
assert.match(source, /PACKAGED_POSTGRESQL_SERVICE_MISMATCH/u);
assert.match(source, /QUICKHACK_POSTGRES_CLUSTER_READY_V1/u);

const ownershipSource = readFileSync(
  new URL("../../tools/platform/windows/postgresql-service-ownership.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(ownershipSource, /from "pg"|child_process|async-powershell/u);

console.log("QuickHack package-owned PostgreSQL service registration and readiness contract verified.");
