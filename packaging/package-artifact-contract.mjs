import { assertPackageFlavor } from "../quickhack_shared/core/package-flavor-contract.mjs";
import { createServerSecretIdentityManifest } from "../quickhack_server/platform/server-secret-identity.mjs";

export const QUICKHACK_ARTIFACT_KINDS = Object.freeze([
  "DEMONSTRATION_SERVER",
  "DEMONSTRATION_CLIENT",
  "OPERATIONAL_SERVER",
  "OPERATIONAL_CLIENT",
]);

export const QUICKHACK_PACKAGE_TARGETS = Object.freeze([
  "demo-server",
  "demo-client",
  "operational-server",
  "operational-client",
]);

const WINDOWS_IDENTITIES = Object.freeze({
  DEMONSTRATION_SERVER: Object.freeze({
    installedIdentity: "5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82",
    applicationName: "QuickHack Demo Server",
    applicationDirectoryName: "QuickHack Demo Server",
    mutableRootName: "demonstration-server",
    services: Object.freeze({
      postgresql: "QuickHackDemoPostgreSQL",
      console: "QuickHackDemoServerConsole",
    }),
  }),
  DEMONSTRATION_CLIENT: Object.freeze({
    installedIdentity: "7D88F75C-5D65-4B34-9DD6-EFB19332DD33",
    applicationName: "QuickHack Demo Client",
    applicationDirectoryName: "QuickHack Demo Client",
    mutableRootName: "demonstration-client",
    localRuntimePort: 3001,
    services: Object.freeze({}),
  }),
  OPERATIONAL_SERVER: Object.freeze({
    installedIdentity: "4AF4F2BB-CB9D-46F7-A8F6-1B585A2BEB17",
    applicationName: "QuickHack Operational Server",
    applicationDirectoryName: "QuickHack Operational Server",
    mutableRootName: "operational-server",
    services: Object.freeze({
      postgresql: "QuickHackOperationalPostgreSQL",
      console: "QuickHackOperationalServerConsole",
    }),
  }),
  OPERATIONAL_CLIENT: Object.freeze({
    installedIdentity: "121152E5-704B-4952-83FB-6ECEF4956895",
    applicationName: "QuickHack Operational Client",
    applicationDirectoryName: "QuickHack Operational Client",
    mutableRootName: "operational-client",
    localRuntimePort: 3002,
    services: Object.freeze({}),
  }),
});

const LINUX_IDENTITIES = Object.freeze({
  DEMONSTRATION_SERVER: Object.freeze({
    installedIdentity: "quickhack-demonstration-server",
    applicationRoot: "/usr/lib/quickhack/demonstration-server",
    configRoot: "/etc/quickhack/demonstration-server",
    dataRoot: "/var/lib/quickhack/demonstration-server",
    cacheRoot: "/var/cache/quickhack/demonstration-server",
    services: Object.freeze({
      postgresql: "quickhack-demonstration-postgresql.service",
      console: "quickhack-demonstration-console.service",
      migrate: "quickhack-demonstration-migrate.service",
      operator: "quickhack-demonstration-operator@.service",
    }),
    users: Object.freeze({ application: "quickhack-demo", postgresql: "quickhack-demo-pg" }),
  }),
  DEMONSTRATION_CLIENT: Object.freeze({
    installedIdentity: "quickhack-demonstration-client",
    applicationRoot: "/usr/lib/quickhack/demonstration-client",
    mutableRootName: "demonstration-client",
    localRuntimePort: 3001,
    services: Object.freeze({}),
    users: Object.freeze({}),
  }),
  OPERATIONAL_SERVER: Object.freeze({
    installedIdentity: "quickhack-operational-server",
    applicationRoot: "/usr/lib/quickhack/operational-server",
    configRoot: "/etc/quickhack/operational-server",
    dataRoot: "/var/lib/quickhack/operational-server",
    cacheRoot: "/var/cache/quickhack/operational-server",
    services: Object.freeze({
      postgresql: "quickhack-operational-postgresql.service",
      console: "quickhack-operational-console.service",
      migrate: "quickhack-operational-migrate.service",
      operator: "quickhack-operational-operator@.service",
    }),
    users: Object.freeze({ application: "quickhack-operational", postgresql: "quickhack-operational-pg" }),
  }),
  OPERATIONAL_CLIENT: Object.freeze({
    installedIdentity: "quickhack-operational-client",
    applicationRoot: "/usr/lib/quickhack/operational-client",
    mutableRootName: "operational-client",
    localRuntimePort: 3002,
    services: Object.freeze({}),
    users: Object.freeze({}),
  }),
});

const ARTIFACTS = Object.freeze({
  DEMONSTRATION_SERVER: Object.freeze({
    packageTarget: "demo-server",
    role: "server",
    packageFlavor: "DEMONSTRATION",
    entrypoint: "tools/server-console-demonstration.mjs",
    includesMockRuntime: true,
    includesPrivilegedCredentialOperator: true,
  }),
  DEMONSTRATION_CLIENT: Object.freeze({
    packageTarget: "demo-client",
    role: "client",
    packageFlavor: "DEMONSTRATION",
    entrypoint: "tools/client-runtime-launcher.mjs",
    includesMockRuntime: false,
    includesPrivilegedCredentialOperator: false,
  }),
  OPERATIONAL_SERVER: Object.freeze({
    packageTarget: "operational-server",
    role: "server",
    packageFlavor: "OPERATIONAL",
    entrypoint: "tools/server-console-operational.mjs",
    includesMockRuntime: false,
    includesPrivilegedCredentialOperator: true,
  }),
  OPERATIONAL_CLIENT: Object.freeze({
    packageTarget: "operational-client",
    role: "client",
    packageFlavor: "OPERATIONAL",
    entrypoint: "tools/client-runtime-launcher.mjs",
    includesMockRuntime: false,
    includesPrivilegedCredentialOperator: false,
  }),
});

const ARTIFACT_KIND_BY_TARGET = Object.freeze(
  Object.fromEntries(
    Object.entries(ARTIFACTS).map(([artifactKind, contract]) => [
      contract.packageTarget,
      artifactKind,
    ])
  )
);

function artifactKindFrom(value) {
  const source = String(value ?? "").trim();
  return ARTIFACT_KIND_BY_TARGET[source.toLowerCase()] ?? source.toUpperCase();
}

export function packageArtifactContract(value) {
  const artifactKind = artifactKindFrom(value);
  const contract = ARTIFACTS[artifactKind];
  if (!contract) {
    const error = new TypeError(`Unsupported QuickHack artifact kind: ${artifactKind || "empty"}.`);
    error.code = "PACKAGE_ARTIFACT_INVALID";
    throw error;
  }
  return Object.freeze({ artifactKind, ...contract });
}

export function packageArtifactContractForTarget(value) {
  const target = String(value ?? "").trim().toLowerCase();
  const artifactKind = ARTIFACT_KIND_BY_TARGET[target];
  if (!artifactKind) {
    const error = new TypeError(`Unsupported QuickHack package target: ${target || "empty"}.`);
    error.code = "PACKAGE_ARTIFACT_INVALID";
    throw error;
  }
  return packageArtifactContract(artifactKind);
}

export function packageArtifactPlatformIdentity(value, platform) {
  const artifact = packageArtifactContract(value);
  const normalizedPlatform = String(platform ?? "").trim().toLowerCase();
  const identities = normalizedPlatform === "win32"
    ? WINDOWS_IDENTITIES
    : normalizedPlatform === "linux"
      ? LINUX_IDENTITIES
      : null;
  if (!identities) {
    const error = new TypeError(`Unsupported QuickHack package platform: ${normalizedPlatform || "empty"}.`);
    error.code = "PACKAGE_ARTIFACT_INVALID";
    throw error;
  }
  return Object.freeze({
    artifactKind: artifact.artifactKind,
    packageTarget: artifact.packageTarget,
    platform: normalizedPlatform,
    ...identities[artifact.artifactKind],
  });
}

export function assertArtifactRuntimePair(artifactKind, runtimeConfig) {
  const artifact = packageArtifactContract(artifactKind);
  const packageFlavor = assertPackageFlavor(runtimeConfig?.packageFlavor);
  if (artifact.packageFlavor !== packageFlavor) {
    throw new Error(
      "The runtime configuration package flavor does not match the artifact kind."
    );
  }
  return artifact.role === "server"
    ? Object.freeze({
        ...artifact,
        serverSecrets: createServerSecretIdentityManifest(runtimeConfig),
      })
    : artifact;
}
