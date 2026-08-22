import path from "node:path";

export const QUICKHACK_POSTGRESQL_SERVICE_OWNERSHIP = Object.freeze([
  "COMPATIBILITY",
  "PACKAGED",
]);

const SERVICE_OWNERSHIP = new Set(QUICKHACK_POSTGRESQL_SERVICE_OWNERSHIP);
const SERVICE_NAMES = new Set([
  "QuickHackPostgreSQL",
  "QuickHackDemoPostgreSQL",
  "QuickHackOperationalPostgreSQL",
]);

export function assertPostgresqlServiceOwnership(value) {
  const ownership = String(value ?? "COMPATIBILITY").trim().toUpperCase();
  if (!SERVICE_OWNERSHIP.has(ownership)) {
    throw new TypeError("Unsupported QuickHack PostgreSQL service ownership mode.");
  }
  return ownership;
}

function serviceName(value) {
  const result = String(value ?? "QuickHackPostgreSQL").trim();
  if (!SERVICE_NAMES.has(result)) {
    throw new TypeError("Unsupported QuickHack PostgreSQL service identity.");
  }
  return result;
}

export function postgresqlServiceRegistrationPlan(input) {
  const ownership = assertPostgresqlServiceOwnership(input?.serviceOwnership);
  const resolvedServiceName = serviceName(input?.serviceName);
  const installDir = path.resolve(String(input?.installDir ?? ""));
  const dataDir = path.resolve(String(input?.dataDir ?? ""));
  if (ownership === "PACKAGED") {
    if (path.basename(dataDir).toLowerCase() !== "data") {
      throw new TypeError("QuickHack packaged PostgreSQL data directory must use the owned data root.");
    }
    return Object.freeze({
      ownership,
      serviceName: resolvedServiceName,
      expectedHostPath: path.join(
        installDir,
        "Services",
        "QuickHackPostgresqlServiceHost.exe"
      ),
      readinessMarkerPath: path.join(
        path.dirname(dataDir),
        "provisioning",
        "POSTGRES_CLUSTER_READY"
      ),
      registrationMutation: false,
    });
  }
  return Object.freeze({
    ownership,
    serviceName: resolvedServiceName,
    expectedHostPath: null,
    readinessMarkerPath: null,
    registrationMutation: true,
  });
}
