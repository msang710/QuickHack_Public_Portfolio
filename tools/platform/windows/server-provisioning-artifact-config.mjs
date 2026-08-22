import { packageArtifactContract } from "../../../packaging/package-artifact-contract.mjs";
import { msixArtifactConfig } from "../../../packaging/windows/msix/msix-artifact-config.mjs";

const FIREWALL_RULE_NAME = "QuickHack HTTPS Server (Local Subnet)";

function failure(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function serviceName(config, role) {
  const service = config.services.find((item) => item.role === role);
  if (!service) {
    throw failure(
      "PROVISIONING_ARTIFACT_INVALID",
      `Server artifact is missing its ${role} service contract.`
    );
  }
  return service.name;
}

function runtimeDatabase(packageFlavor) {
  const common = {
    host: "127.0.0.1",
    port: 5432,
    name: "quickhack",
    runtimeUser: "quickhack_runtime",
    migratorUser: "quickhack_migrator",
  };
  return Object.freeze(packageFlavor === "DEMONSTRATION"
    ? {
        ...common,
        coupangMockName: "quickhack_mock_coupang",
        coupangMockUser: "quickhack_mock_coupang",
        logenMockName: "quickhack_mock_logen",
        logenMockUser: "quickhack_mock_logen",
      }
    : common);
}

export function windowsServerProvisioningArtifactConfig(value) {
  const artifact = packageArtifactContract(value);
  const own = msixArtifactConfig(artifact.packageTarget);
  if (own.role !== "server") {
    throw failure(
      "PROVISIONING_ARTIFACT_INVALID",
      "Windows server provisioning requires an exact server artifact kind."
    );
  }
  const oppositeTarget = own.packageTarget === "demo-server"
    ? "operational-server"
    : "demo-server";
  const opposite = msixArtifactConfig(oppositeTarget);
  return Object.freeze({
    artifactKind: own.artifactKind,
    packageTarget: own.packageTarget,
    expectedFlavor: own.packageFlavor,
    identityName: own.identityName,
    mutableRootName: own.mutableRootName,
    firewallRuleName: FIREWALL_RULE_NAME,
    services: Object.freeze({
      postgresql: serviceName(own, "postgresql"),
      console: serviceName(own, "console"),
    }),
    opposite: Object.freeze({
      artifactKind: opposite.artifactKind,
      packageTarget: opposite.packageTarget,
      identityName: opposite.identityName,
      services: Object.freeze(opposite.services.map((item) => item.name)),
    }),
    runtimeDatabase: runtimeDatabase(own.packageFlavor),
  });
}

export const QUICKHACK_SERVER_FIREWALL_RULE_NAME = FIREWALL_RULE_NAME;
