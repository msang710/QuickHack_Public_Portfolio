import path from "node:path";
import { POSTGRESQL_MAJOR_VERSION } from "../../../quickhack_shared/platform/native-runtime-contract.mjs";
import { packageArtifactContract } from "../../package-artifact-contract.mjs";
import { msixArtifactConfig } from "./msix-artifact-config.mjs";

export const QUICKHACK_LEGACY_INSTALL_CLASSIFICATIONS = Object.freeze([
  "COMPATIBLE",
  "OPPOSITE",
  "AMBIGUOUS",
  "INCOMPATIBLE",
  "NONE",
]);

const CURRENT_PRODUCT_MAJOR = 1;
const CURRENT_RUNTIME_CONFIG_SCHEMA = 3;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serverConfig(value) {
  const config = msixArtifactConfig(packageArtifactContract(value).packageTarget);
  if (config.role !== "server") {
    throw failure("LEGACY_INSTALL_TARGET_INVALID", "Legacy migration requires a server artifact.");
  }
  const oppositeTarget = config.packageTarget === "demo-server"
    ? "operational-server"
    : "demo-server";
  return Object.freeze({ own: config, opposite: msixArtifactConfig(oppositeTarget) });
}

function normalizedWindowsPath(value) {
  const source = String(value ?? "").trim().replace(/^"|"$/gu, "");
  if (!path.win32.isAbsolute(source) || source.split(/[\\/]+/u).includes("..")) return "";
  return path.win32.normalize(source).replace(/[\\/]+$/u, "");
}

function samePath(left, right) {
  const a = normalizedWindowsPath(left);
  const b = normalizedWindowsPath(right);
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function containedBy(root, candidate) {
  const normalizedRoot = normalizedWindowsPath(root);
  const normalizedCandidate = normalizedWindowsPath(candidate);
  if (!normalizedRoot || !normalizedCandidate) return false;
  const relative = path.win32.relative(normalizedRoot, normalizedCandidate);
  return Boolean(relative && !relative.startsWith("..") && !path.win32.isAbsolute(relative));
}

function executableFromCommandLine(value) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  if (source.startsWith('"')) {
    const end = source.indexOf('"', 1);
    return end > 1 ? normalizedWindowsPath(source.slice(1, end)) : "";
  }
  const match = /^(.*?\.exe)(?:\s|$)/iu.exec(source);
  return normalizedWindowsPath(match?.[1]);
}

function semverMajor(value) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(
    String(value ?? "").trim()
  );
  return match ? Number(match[1]) : null;
}

function classification(name, reasonCode, details = {}) {
  return Object.freeze({
    classification: name,
    reasonCode,
    mutationAllowed: name === "COMPATIBLE",
    ...details,
  });
}

function packageObserved(packages, name) {
  return [...(packages ?? [])].some((value) =>
    String(typeof value === "string" ? value : value?.identityName).toLowerCase() === name.toLowerCase()
  );
}

function serviceMap(services) {
  const result = new Map();
  for (const service of services ?? []) {
    const name = String(service?.name ?? "").trim();
    if (!name || result.has(name.toLowerCase())) {
      return null;
    }
    result.set(name.toLowerCase(), Object.freeze({
      name,
      pathName: String(service?.pathName ?? ""),
      status: String(service?.status ?? "").toUpperCase(),
      startName: String(service?.startName ?? ""),
    }));
  }
  return result;
}

function serviceNames(config) {
  return (config.services ?? []).map((service) => String(service?.name ?? service));
}

function validateState(observation, config, expectedRoot) {
  const state = observation?.state ?? {};
  if (state.exists !== true) return { exists: false, valid: true };
  if (state.reparsePoint === true || !samePath(state.root, expectedRoot)) {
    return { exists: true, valid: false, ambiguous: true, reasonCode: "LEGACY_STATE_ROOT_AMBIGUOUS" };
  }
  const runtime = state.runtimeConfig;
  if (!runtime || state.postgresqlMajor === null || state.postgresqlMajor === undefined) {
    return { exists: true, valid: false, incomplete: true, reasonCode: "STATE_PROVISIONING_INCOMPLETE" };
  }
  if (
    runtime?.schemaVersion !== CURRENT_RUNTIME_CONFIG_SCHEMA ||
    runtime?.packageFlavor !== config.packageFlavor ||
    !samePath(runtime?.dataDirectory, path.win32.join(expectedRoot, "data")) ||
    String(state.postgresqlMajor ?? "") !== String(POSTGRESQL_MAJOR_VERSION)
  ) {
    return { exists: true, valid: false, ambiguous: false, incomplete: false, reasonCode: "STATE_SCHEMA_INCOMPATIBLE" };
  }
  return { exists: true, valid: true };
}

export function classifyLegacyWindowsInstall(input) {
  const { own, opposite } = serverConfig(input?.target ?? input?.artifactKind);
  const observation = input?.observation ?? {};
  const programFiles = normalizedWindowsPath(observation.programFiles);
  const programData = normalizedWindowsPath(observation.programData);
  const packageRoot = normalizedWindowsPath(observation.packageRoot);
  if (!programFiles || !programData) {
    throw failure("LEGACY_INSTALL_OBSERVATION_INVALID", "Program Files and ProgramData observations are required.");
  }
  const expectedInstallRoot = path.win32.join(programFiles, own.applicationDirectoryName);
  const expectedStateRoot = path.win32.join(programData, "QuickHack", own.mutableRootName);
  const ownRegistration = observation.registry?.own ?? null;
  const oppositeRegistration = observation.registry?.opposite ?? null;
  const services = serviceMap(observation.services);
  if (!services) {
    return classification("AMBIGUOUS", "LEGACY_SERVICE_OBSERVATION_AMBIGUOUS");
  }

  const oppositeEvidence = Boolean(
    oppositeRegistration ||
    packageObserved(observation.packages, opposite.identityName) ||
    serviceNames(opposite).some((name) => services.has(name.toLowerCase()))
  );
  if (oppositeEvidence) {
    return classification("OPPOSITE", "OPPOSITE_SERVER_FLAVOR_PRESENT", {
      expectedArtifactKind: own.artifactKind,
      conflictingArtifactKind: opposite.artifactKind,
    });
  }
  if (services.has("quickhackpostgresql") || observation.sharedLegacyService === true) {
    return classification("AMBIGUOUS", "LEGACY_SHARED_SERVICE_AMBIGUOUS");
  }

  const state = validateState(observation, own, expectedStateRoot);
  const ownPackageObserved = packageObserved(observation.packages, own.identityName);
  if (!state.valid && !state.incomplete) {
    return classification(
      state.ambiguous ? "AMBIGUOUS" : "INCOMPATIBLE",
      state.reasonCode,
      { expectedArtifactKind: own.artifactKind }
    );
  }

  const ownServiceNames = serviceNames(own);
  const observedOwnServices = ownServiceNames
    .map((name) => services.get(name.toLowerCase()))
    .filter(Boolean);
  const packageServiceOnly = packageObserved(observation.packages, own.identityName) &&
    packageRoot &&
    observedOwnServices.every((service) => containedBy(packageRoot, executableFromCommandLine(service.pathName)));

  if (!ownRegistration) {
    if (observedOwnServices.length > 0 && !packageServiceOnly) {
      return classification("AMBIGUOUS", "LEGACY_PARTIAL_SERVICE_REGISTRATION");
    }
    if (state.incomplete && ownPackageObserved) {
      return classification("NONE", "MSIX_STATE_PENDING_PROVISIONING", {
        expectedArtifactKind: own.artifactKind,
      });
    }
    if (state.exists) {
      return classification("COMPATIBLE", "LEGACY_PRESERVED_STATE_COMPATIBLE", {
        mode: "PRESERVED_STATE",
        expectedArtifactKind: own.artifactKind,
        stateRoot: expectedStateRoot,
        legacyInstallRoot: null,
        legacyUninstaller: null,
      });
    }
    return classification("NONE", "LEGACY_INSTALL_NOT_FOUND", {
      expectedArtifactKind: own.artifactKind,
    });
  }

  if (state.incomplete) {
    return classification("AMBIGUOUS", "LEGACY_STATE_INCOMPLETE");
  }

  if (
    String(ownRegistration.appId ?? "").toUpperCase() !== own.legacyAppId.toUpperCase() ||
    String(ownRegistration.displayName ?? "") !== own.applicationName ||
    !samePath(ownRegistration.installLocation, expectedInstallRoot)
  ) {
    return classification("AMBIGUOUS", "LEGACY_REGISTRATION_AMBIGUOUS");
  }
  if (semverMajor(ownRegistration.displayVersion) !== CURRENT_PRODUCT_MAJOR) {
    return classification("INCOMPATIBLE", "LEGACY_VERSION_INCOMPATIBLE", {
      expectedArtifactKind: own.artifactKind,
    });
  }
  const uninstaller = executableFromCommandLine(
    ownRegistration.quietUninstallString || ownRegistration.uninstallString
  );
  if (
    !containedBy(expectedInstallRoot, uninstaller) ||
    !/^unins[0-9]*\.exe$/iu.test(path.win32.basename(uninstaller)) ||
    ownRegistration.uninstallerRegularFile !== true
  ) {
    return classification("AMBIGUOUS", "LEGACY_UNINSTALLER_AMBIGUOUS");
  }
  for (const service of observedOwnServices) {
    const executable = executableFromCommandLine(service.pathName);
    if (!containedBy(expectedInstallRoot, executable) && !containedBy(packageRoot, executable)) {
      return classification("AMBIGUOUS", "LEGACY_SERVICE_PATH_AMBIGUOUS");
    }
  }
  return classification("COMPATIBLE", "LEGACY_INNO_INSTALL_COMPATIBLE", {
    mode: "INSTALLED_INNO",
    expectedArtifactKind: own.artifactKind,
    stateRoot: state.exists ? expectedStateRoot : null,
    legacyInstallRoot: expectedInstallRoot,
    legacyUninstaller: uninstaller,
    legacyServices: Object.freeze(
      observedOwnServices
        .filter((service) => containedBy(expectedInstallRoot, executableFromCommandLine(service.pathName)))
        .map((service) => service.name)
        .sort()
    ),
  });
}
