import fs from "node:fs";
import path from "node:path";

export const QUICKHACK_RUNTIME_CONTRACT_VERSION = 1;
export const QUICKHACK_PACKAGE_MANIFEST_FILENAME = "quickhack-package.json";

const CONTRACTS = Object.freeze({
  DEMONSTRATION_SERVER: Object.freeze({
    artifactKind: "DEMONSTRATION_SERVER",
    deploymentFlavor: "DEMONSTRATION",
    runtimeRole: "SERVER",
    packageTarget: "demo-server",
    expectedPeerArtifactKind: "DEMONSTRATION_CLIENT",
  }),
  DEMONSTRATION_CLIENT: Object.freeze({
    artifactKind: "DEMONSTRATION_CLIENT",
    deploymentFlavor: "DEMONSTRATION",
    runtimeRole: "CLIENT",
    packageTarget: "demo-client",
    expectedPeerArtifactKind: "DEMONSTRATION_SERVER",
    localRuntimePort: 3001,
    mutableRootName: "demonstration-client",
  }),
  OPERATIONAL_SERVER: Object.freeze({
    artifactKind: "OPERATIONAL_SERVER",
    deploymentFlavor: "OPERATIONAL",
    runtimeRole: "SERVER",
    packageTarget: "operational-server",
    expectedPeerArtifactKind: "OPERATIONAL_CLIENT",
  }),
  OPERATIONAL_CLIENT: Object.freeze({
    artifactKind: "OPERATIONAL_CLIENT",
    deploymentFlavor: "OPERATIONAL",
    runtimeRole: "CLIENT",
    packageTarget: "operational-client",
    expectedPeerArtifactKind: "OPERATIONAL_SERVER",
    localRuntimePort: 3002,
    mutableRootName: "operational-client",
  }),
});

const EXPECTED_MANIFEST_KEYS = Object.freeze([
  "architecture",
  "artifactKind",
  "contentInventorySha256",
  "deploymentFlavor",
  "entrypoint",
  "installedIdentity",
  "packageTarget",
  "platform",
  "runtimeRole",
  "schemaVersion",
  "version",
]);

function invalid(message) {
  const error = new TypeError(message);
  error.code = "PACKAGE_ARTIFACT_INVALID";
  return error;
}

function mismatch(message) {
  const error = new Error(message);
  error.code = "PACKAGE_FLAVOR_MISMATCH";
  return error;
}

function requiredString(value, fieldName) {
  const result = String(value ?? "").trim();
  if (!result) throw invalid(`${fieldName} is required.`);
  return result;
}

export function packageRuntimeIdentityContract(value) {
  const artifactKind = String(value ?? "").trim().toUpperCase();
  const contract = CONTRACTS[artifactKind];
  if (!contract) {
    throw invalid(`Unsupported QuickHack artifact kind: ${artifactKind || "empty"}.`);
  }
  return contract;
}

export function packageManifestArgument(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--package-manifest");
  if (index < 0) return "";
  const value = String(argv[index + 1] ?? "").trim();
  if (!value || value.startsWith("--")) {
    throw invalid("--package-manifest requires a file path.");
  }
  return path.resolve(value);
}

export function assertPackageRuntimeIdentity(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("QuickHack package manifest must be an object.");
  }
  if (value.schemaVersion !== QUICKHACK_RUNTIME_CONTRACT_VERSION) {
    throw invalid("QuickHack package manifest schema version is unsupported.");
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EXPECTED_MANIFEST_KEYS)) {
    throw invalid("QuickHack package manifest has unknown or missing fields.");
  }

  const contract = packageRuntimeIdentityContract(value.artifactKind);
  const platform = requiredString(value.platform, "platform").toLowerCase();
  const architecture = requiredString(value.architecture, "architecture");
  const expectedArchitecture = platform === "win32" ? "x64" : platform === "linux" ? "x86_64" : "";
  if (!expectedArchitecture || architecture !== expectedArchitecture) {
    throw invalid("QuickHack package manifest platform or architecture is unsupported.");
  }
  if (
    value.packageTarget !== contract.packageTarget ||
    value.deploymentFlavor !== contract.deploymentFlavor ||
    value.runtimeRole !== contract.runtimeRole
  ) {
    throw invalid("QuickHack package manifest fields do not match its artifact kind.");
  }
  const entrypoint = requiredString(value.entrypoint, "entrypoint").replaceAll("\\", "/");
  if (entrypoint.startsWith("/") || entrypoint.split("/").includes("..")) {
    throw invalid("QuickHack package manifest entrypoint must be package-relative.");
  }
  if (!/^[a-f0-9]{64}$/u.test(requiredString(value.contentInventorySha256, "contentInventorySha256"))) {
    throw invalid("QuickHack package manifest inventory digest is invalid.");
  }
  requiredString(value.version, "version");
  requiredString(value.installedIdentity, "installedIdentity");

  if (expected.artifactKind && contract.artifactKind !== String(expected.artifactKind).toUpperCase()) {
    throw mismatch("The package manifest artifact kind does not match the launcher.");
  }
  if (expected.runtimeRole && contract.runtimeRole !== String(expected.runtimeRole).toUpperCase()) {
    throw mismatch("The package manifest runtime role does not match the launcher.");
  }
  if (expected.deploymentFlavor && contract.deploymentFlavor !== String(expected.deploymentFlavor).toUpperCase()) {
    throw mismatch("The package manifest deployment flavor does not match the runtime configuration.");
  }

  return Object.freeze({
    runtimeContractVersion: QUICKHACK_RUNTIME_CONTRACT_VERSION,
    artifactKind: contract.artifactKind,
    deploymentFlavor: contract.deploymentFlavor,
    runtimeRole: contract.runtimeRole,
    packageTarget: contract.packageTarget,
    platform,
    architecture,
    version: value.version,
    entrypoint,
    installedIdentity: value.installedIdentity,
    manifestPath: expected.manifestPath ? path.resolve(expected.manifestPath) : "",
    ...(contract.localRuntimePort ? { localRuntimePort: contract.localRuntimePort } : {}),
    ...(contract.mutableRootName ? { mutableRootName: contract.mutableRootName } : {}),
  });
}

export function readPackageRuntimeIdentitySync(input = {}) {
  const configuredPath = String(
    input.manifestPath ?? process.env.QUICKHACK_PACKAGE_MANIFEST ?? ""
  ).trim();
  if (!configuredPath) {
    if (input.required) throw invalid("QuickHack package manifest path is required.");
    return null;
  }
  const manifestPath = path.resolve(configuredPath);
  let stat;
  try {
    stat = fs.lstatSync(manifestPath);
  } catch {
    throw invalid(`QuickHack package manifest was not found: ${manifestPath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw invalid("QuickHack package manifest must be a small regular file, not a link.");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw invalid(`QuickHack package manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return assertPackageRuntimeIdentity(parsed, { ...input, manifestPath });
}

export function activatePackageRuntimeIdentity(input = {}) {
  const argumentPath = packageManifestArgument(input.argv ?? process.argv.slice(2));
  const manifestPath = argumentPath || String(
    input.manifestPath ?? process.env.QUICKHACK_PACKAGE_MANIFEST ?? ""
  ).trim();
  const identity = readPackageRuntimeIdentitySync({ ...input, manifestPath, required: Boolean(manifestPath) || input.required });
  if (identity) process.env.QUICKHACK_PACKAGE_MANIFEST = identity.manifestPath;
  return identity;
}

export function assertClientServerPackagePair(clientIdentity, serverRuntime) {
  const client = packageRuntimeIdentityContract(clientIdentity?.artifactKind);
  if (client.runtimeRole !== "CLIENT") {
    throw mismatch("The local package identity is not a client artifact.");
  }
  if (
    serverRuntime?.runtimeContractVersion !== QUICKHACK_RUNTIME_CONTRACT_VERSION ||
    String(serverRuntime?.role ?? "").toLowerCase() !== "server" ||
    serverRuntime?.deploymentFlavor !== client.deploymentFlavor ||
    serverRuntime?.artifactKind !== client.expectedPeerArtifactKind
  ) {
    throw mismatch("The central server package does not match this QuickHack client.");
  }
  return Object.freeze({
    clientArtifactKind: client.artifactKind,
    serverArtifactKind: client.expectedPeerArtifactKind,
    deploymentFlavor: client.deploymentFlavor,
  });
}
