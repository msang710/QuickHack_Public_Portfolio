import {
  WINDOWS_PACKAGE_TARGETS,
  windowsArtifactConfig,
} from "../windows-artifact-config.mjs";

export const QUICKHACK_MSIX_MINIMUM_OS_VERSION = "10.0.19041.0";
export const QUICKHACK_MSIX_MAX_VERSION_TESTED = "10.0.26100.0";
export const QUICKHACK_MSIX_ARCHITECTURE = "x64";
export const QUICKHACK_MSIX_DEVELOPMENT_PUBLISHER = "CN=QuickHack Development";

const MSIX_IDENTITIES = Object.freeze({
  "demo-server": Object.freeze({
    identityName: "QuickHack.Demonstration.Server",
    applicationId: "QuickHackDemoServer",
  }),
  "demo-client": Object.freeze({
    identityName: "QuickHack.Demonstration.Client",
    applicationId: "QuickHackDemoClient",
  }),
  "operational-server": Object.freeze({
    identityName: "QuickHack.Operational.Server",
    applicationId: "QuickHackOperationalServer",
  }),
  "operational-client": Object.freeze({
    identityName: "QuickHack.Operational.Client",
    applicationId: "QuickHackOperationalClient",
  }),
});

const SERVER_HOSTS = Object.freeze({
  postgresql: "Services\\QuickHackPostgresqlServiceHost.exe",
  console: "Services\\QuickHackServerServiceHost.exe",
});

const DEMO_SERVER_PREVIEW = Object.freeze({
  identityName: "QuickHack.Preview.Demonstration.Server",
  applicationId: "QuickHackPreviewDemoServer",
  applicationName: "QuickHack Preview Demo Server",
  mutableRootName: "msix-preview-demonstration-server",
  services: Object.freeze({
    postgresql: "QuickHackPreviewDemoPostgreSQL",
    console: "QuickHackPreviewDemoServerConsole",
  }),
});

function requiredPublisher(value) {
  const publisher = String(value ?? "").trim();
  if (!/^CN=[^,=][^,]*(?:,\s*[A-Z][A-Z0-9.]*=[^,=][^,]*)*$/u.test(publisher)) {
    const error = new TypeError("MSIX Publisher must be a non-empty X.500 subject beginning with CN=.");
    error.code = "MSIX_PUBLISHER_INVALID";
    throw error;
  }
  return publisher;
}

function serverServiceConfig(artifact) {
  if (artifact.role !== "server") return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      role: "postgresql",
      name: artifact.services.postgresql,
      executable: SERVER_HOSTS.postgresql,
      startupType: "auto",
      startAccount: "networkService",
      dependencies: Object.freeze([]),
    }),
    Object.freeze({
      role: "console",
      name: artifact.services.console,
      executable: SERVER_HOSTS.console,
      startupType: "auto",
      startAccount: "networkService",
      dependencies: Object.freeze([artifact.services.postgresql]),
    }),
  ]);
}

export const QUICKHACK_MSIX_TARGETS = WINDOWS_PACKAGE_TARGETS;

export function msixArtifactConfig(target, options = {}) {
  const baseArtifact = windowsArtifactConfig(target);
  const preview = options.preview === true;
  if (preview && baseArtifact.packageTarget !== "demo-server") {
    const error = new TypeError("The packaged-service preview identity is only valid for demo-server.");
    error.code = "MSIX_PREVIEW_TARGET_INVALID";
    throw error;
  }
  const artifact = preview
    ? Object.freeze({ ...baseArtifact, ...DEMO_SERVER_PREVIEW })
    : baseArtifact;
  const identity = preview
    ? DEMO_SERVER_PREVIEW
    : MSIX_IDENTITIES[artifact.packageTarget];
  const publisher = requiredPublisher(
    options.publisher ?? QUICKHACK_MSIX_DEVELOPMENT_PUBLISHER
  );
  const services = serverServiceConfig(artifact);
  const oppositeServerTarget = !preview && artifact.role === "server"
    ? artifact.packageTarget === "demo-server"
      ? "operational-server"
      : "demo-server"
    : null;

  return Object.freeze({
    ...artifact,
    ...identity,
    preview,
    publisher,
    architecture: QUICKHACK_MSIX_ARCHITECTURE,
    minimumOsVersion: QUICKHACK_MSIX_MINIMUM_OS_VERSION,
    maxVersionTested: QUICKHACK_MSIX_MAX_VERSION_TESTED,
    description: `${artifact.applicationName} self-contained Windows package`,
    legacyInstalledIdentity: artifact.installedIdentity,
    legacyAppId: `{${artifact.installedIdentity}}`,
    oppositeServerIdentity: oppositeServerTarget
      ? MSIX_IDENTITIES[oppositeServerTarget].identityName
      : null,
    runtime: Object.freeze({
      node: true,
      postgresql: artifact.role === "server",
    }),
    services,
    serviceHostsReady: preview,
    msixDistributionRoot: preview
      ? "release/distribution/windows/msix/preview-demo-server"
      : `release/distribution/windows/msix/${artifact.packageTarget}`,
  });
}

export function assertProductionMsixPublisher(value) {
  const publisher = requiredPublisher(value);
  if (publisher === QUICKHACK_MSIX_DEVELOPMENT_PUBLISHER) {
    const error = new Error("The development MSIX Publisher is forbidden for production output.");
    error.code = "MSIX_PRODUCTION_PUBLISHER_REQUIRED";
    throw error;
  }
  return publisher;
}

const allConfigs = QUICKHACK_MSIX_TARGETS.map((target) => msixArtifactConfig(target));
for (const fieldName of ["identityName", "applicationId"]) {
  if (new Set(allConfigs.map((config) => config[fieldName])).size !== allConfigs.length) {
    throw new Error(`QuickHack MSIX ${fieldName} values must be unique.`);
  }
}
