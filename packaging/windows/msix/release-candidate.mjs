import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QUICKHACK_MSIX_TARGETS, msixArtifactConfig } from "./msix-artifact-config.mjs";
import { verifyFourMsixDistribution } from "./four-artifact-distribution.mjs";

export const WINDOWS_RELEASE_NATIVE_CHECKS = Object.freeze([
  "cleanInstall",
  "provisioning",
  "interruptionRecovery",
  "update",
  "reboot",
  "migration",
  "repair",
  "serverConflict",
  "dualClients",
  "uninstallPreserved",
  "purge",
  "shellIcon",
]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filename) {
  return sha256Bytes(readFileSync(filename));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8").replace(/^\uFEFF/u, ""));
}

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...expected].sort());
}

function packageFiles(distributionDirectory, version) {
  return QUICKHACK_MSIX_TARGETS.map((target) => {
    const prefix = msixArtifactConfig(target).installerFilePrefix;
    const directory = path.join(distributionDirectory, target);
    return Object.freeze({
      target,
      packagePath: path.join(directory, `${prefix}-${version}.msix`),
      sidecarPath: path.join(directory, `${prefix}-msix-manifest-${version}.json`),
      checksumPath: path.join(directory, `${prefix}-SHA256SUMS.txt`),
    });
  });
}

export function validateReleaseNativeEvidence(value, expected) {
  const topLevelKeys = [
    "schemaVersion",
    "status",
    "evidenceId",
    "osFamily",
    "productType",
    "osBuild",
    "sourceCommit",
    "semanticVersion",
    "publisher",
    "packageHashes",
    "checks",
    "counts",
    "externalOperations",
  ];
  if (!value || typeof value !== "object" || !exactKeys(value, topLevelKeys)) {
    throw failure("MSIX_NATIVE_EVIDENCE_INVALID", "Native evidence fields are not exact.");
  }
  if (
    value.schemaVersion !== 1 ||
    value.status !== "PASS" ||
    !/^[A-Za-z0-9._-]{8,128}$/u.test(value.evidenceId) ||
    !["WINDOWS_10", "WINDOWS_11"].includes(value.osFamily) ||
    value.productType !== "WORKSTATION" ||
    !Number.isSafeInteger(value.osBuild) ||
    value.osBuild < 19041 ||
    (value.osFamily === "WINDOWS_10" && value.osBuild >= 22000) ||
    (value.osFamily === "WINDOWS_11" && value.osBuild < 22000) ||
    value.sourceCommit !== expected.sourceCommit ||
    value.semanticVersion !== expected.version ||
    value.publisher !== expected.publisher
  ) {
    throw failure("MSIX_NATIVE_EVIDENCE_INVALID", "Native evidence identity or supported OS lane is invalid.");
  }
  if (!exactKeys(value.packageHashes, QUICKHACK_MSIX_TARGETS)) {
    throw failure("MSIX_NATIVE_EVIDENCE_INVALID", "Native evidence package hash set is not exact.");
  }
  for (const target of QUICKHACK_MSIX_TARGETS) {
    if (value.packageHashes[target] !== expected.packageHashes[target]) {
      throw failure("MSIX_NATIVE_EVIDENCE_STALE", `Native evidence package hash is stale for ${target}.`);
    }
  }
  if (!exactKeys(value.checks, WINDOWS_RELEASE_NATIVE_CHECKS)) {
    throw failure("MSIX_NATIVE_EVIDENCE_INVALID", "Native evidence check set is not exact.");
  }
  for (const check of WINDOWS_RELEASE_NATIVE_CHECKS) {
    if (value.checks[check] !== true) {
      throw failure("MSIX_NATIVE_EVIDENCE_INCOMPLETE", `Native release check did not pass: ${check}.`);
    }
  }
  const countKeys = ["criticalFailure", "stateLoss", "duplicateLeader", "iconMismatch", "residue"];
  if (!exactKeys(value.counts, countKeys) || countKeys.some((key) => value.counts[key] !== 0)) {
    throw failure("MSIX_NATIVE_EVIDENCE_FAILED", "Native evidence contains a failure or residue count.");
  }
  if (
    !exactKeys(value.externalOperations, ["status", "reason"]) ||
    value.externalOperations.status !== "NOT_APPLICABLE" ||
    value.externalOperations.reason !== "EXTERNAL_OPERATION_ENVIRONMENT_UNAVAILABLE"
  ) {
    throw failure("MSIX_NATIVE_EVIDENCE_INVALID", "External operation boundary is not explicit.");
  }
  return Object.freeze(value);
}

function assertSafeOutput(outputDirectory, repositoryRoot) {
  const releaseRoot = path.join(repositoryRoot, "release");
  const output = path.resolve(outputDirectory);
  if (output === releaseRoot || !output.startsWith(`${releaseRoot}${path.sep}`)) {
    throw failure("MSIX_RELEASE_OUTPUT_UNSAFE", "Release metadata output must be below repository release/.");
  }
  return output;
}

export function createWindowsMsixReleaseCandidate(input) {
  const repositoryRoot = path.resolve(String(input?.repositoryRoot ?? process.cwd()));
  const distributionDirectory = path.resolve(String(input?.distributionDirectory ?? ""));
  const outputDirectory = assertSafeOutput(input?.outputDirectory, repositoryRoot);
  const version = String(input?.version ?? "").trim();
  const publisher = String(input?.publisher ?? "").trim();
  const sourceCommit = String(input?.sourceCommit ?? "").trim().toLowerCase();
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw failure("MSIX_RELEASE_IDENTITY_INVALID", "Release version and source commit are required.");
  }
  const distribution = verifyFourMsixDistribution({
    directory: distributionDirectory,
    version,
    publisher,
    requireProduction: true,
  });
  if (distribution.sourceCommit !== sourceCommit) {
    throw failure("MSIX_RELEASE_SOURCE_MISMATCH", "Production packages do not match the requested source commit.");
  }

  const packageEntries = [];
  const packageHashes = {};
  const assets = [];
  for (const files of packageFiles(distributionDirectory, version)) {
    const sidecar = readJson(files.sidecarPath);
    packageHashes[files.target] = sidecar.packageSha256;
    for (const filename of [files.packagePath, files.sidecarPath, files.checksumPath]) {
      if (!existsSync(filename) || !lstatSync(filename).isFile()) {
        throw failure("MSIX_RELEASE_ASSET_MISSING", `Release asset is missing for ${files.target}.`);
      }
      const name = path.basename(filename);
      if (/\.exe$|\.appinstaller$/iu.test(name)) {
        throw failure("MSIX_RELEASE_ASSET_FORBIDDEN", `Forbidden Windows release asset: ${name}`);
      }
      assets.push(Object.freeze({ name, sha256: sha256File(filename) }));
    }
    packageEntries.push(Object.freeze({
      target: files.target,
      artifactKind: sidecar.artifactKind,
      identityName: sidecar.identityName,
      msixVersion: sidecar.msixVersion,
      packageFile: sidecar.packageFile,
      packageSha256: sidecar.packageSha256,
      stagingInventorySha256: sidecar.stagingInventorySha256,
      packageContentInventorySha256: sidecar.packageContentInventorySha256,
      brandingRevision: sidecar.brandingRevision,
      canonicalIconSha256: sidecar.canonicalIconSha256,
      nodeRuntime: sidecar.nodeRuntime,
      postgresqlRuntime: sidecar.postgresqlRuntime,
      signature: sidecar.signature,
    }));
  }
  if (
    new Set(packageEntries.map((entry) => entry.brandingRevision)).size !== 1 ||
    new Set(packageEntries.map((entry) => entry.canonicalIconSha256)).size !== 1 ||
    new Set(packageEntries.map((entry) => JSON.stringify(entry.nodeRuntime))).size !== 1
  ) {
    throw failure("MSIX_RELEASE_PROVENANCE_MISMATCH", "Production packages do not share branding or Node provenance.");
  }
  const serverPostgresql = packageEntries
    .filter((entry) => entry.target.endsWith("-server"))
    .map((entry) => JSON.stringify(entry.postgresqlRuntime));
  if (
    new Set(serverPostgresql).size !== 1 ||
    packageEntries.some((entry) => entry.target.endsWith("-client") && entry.postgresqlRuntime !== null)
  ) {
    throw failure("MSIX_RELEASE_PROVENANCE_MISMATCH", "Production packages do not share the server-only PostgreSQL provenance.");
  }

  const evidenceFiles = Array.isArray(input?.nativeEvidenceFiles) ? input.nativeEvidenceFiles : [];
  if (evidenceFiles.length !== 2) {
    throw failure("MSIX_NATIVE_EVIDENCE_INCOMPLETE", "Windows 10 and Windows 11 native evidence are both required.");
  }
  const nativeEvidence = evidenceFiles.map((filename) => {
    const bytes = readFileSync(filename);
    const value = validateReleaseNativeEvidence(
      JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")),
      { sourceCommit, version, publisher, packageHashes }
    );
    return Object.freeze({ filename, bytes, value, sha256: sha256Bytes(bytes) });
  });
  if (new Set(nativeEvidence.map((entry) => entry.value.osFamily)).size !== 2) {
    throw failure("MSIX_NATIVE_EVIDENCE_INCOMPLETE", "Native evidence must cover Windows 10 and Windows 11 exactly once.");
  }

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const evidenceAssets = nativeEvidence
    .sort((left, right) => left.value.osFamily.localeCompare(right.value.osFamily))
    .map((entry) => {
      const family = entry.value.osFamily === "WINDOWS_10" ? "Windows-10" : "Windows-11";
      const name = `QuickHack-${family}-Native-Evidence-${version}.json`;
      copyFileSync(entry.filename, path.join(outputDirectory, name));
      assets.push(Object.freeze({ name, sha256: entry.sha256 }));
      return Object.freeze({
        evidenceId: entry.value.evidenceId,
        osFamily: entry.value.osFamily,
        osBuild: entry.value.osBuild,
        file: name,
        sha256: entry.sha256,
      });
    });

  const manifestName = `QuickHack-Windows-MSIX-Release-${version}.json`;
  const checksumName = `QuickHack-Windows-MSIX-Release-${version}-SHA256SUMS.txt`;
  const manifest = Object.freeze({
    schemaVersion: 1,
    releaseVersion: version,
    tag: `windows-v${version}`,
    sourceCommit,
    sourceDirty: false,
    publisher,
    signingMode: "PRODUCTION",
    signingProvider: distribution.signingProvider,
    brandingRevision: packageEntries[0].brandingRevision,
    packages: Object.freeze(packageEntries),
    nativeEvidence: Object.freeze(evidenceAssets),
    assets: Object.freeze([...assets].sort((left, right) => left.name.localeCompare(right.name))),
    externalOperations: Object.freeze({
      status: "NOT_APPLICABLE",
      reason: "EXTERNAL_OPERATION_ENVIRONMENT_UNAVAILABLE",
    }),
    publicAssetCount: 16,
  });
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  writeFileSync(path.join(outputDirectory, manifestName), manifestBytes);
  assets.push(Object.freeze({ name: manifestName, sha256: sha256Bytes(manifestBytes) }));
  if (assets.length !== 15 || new Set(assets.map((entry) => entry.name)).size !== 15) {
    throw failure("MSIX_RELEASE_ASSET_SET_INVALID", "Release candidate must contain 15 pre-checksum assets.");
  }
  writeFileSync(
    path.join(outputDirectory, checksumName),
    `${assets.sort((left, right) => left.name.localeCompare(right.name)).map((entry) => `${entry.sha256}  ${entry.name}`).join("\n")}\n`,
    "ascii"
  );
  return Object.freeze({ manifest, manifestName, checksumName, publicAssetCount: 16 });
}

function parseArguments(argv) {
  const result = { nativeEvidenceFiles: [] };
  for (const argument of argv) {
    if (argument.startsWith("--native-evidence=")) {
      result.nativeEvidenceFiles.push(argument.slice("--native-evidence=".length));
    } else if (argument.startsWith("--") && argument.includes("=")) {
      const [name, ...parts] = argument.slice(2).split("=");
      result[name.replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = parts.join("=");
    } else throw failure("MSIX_RELEASE_ARGUMENT_INVALID", `Unsupported argument: ${argument}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = createWindowsMsixReleaseCandidate(parseArguments(process.argv.slice(2)));
  console.log(`QuickHack Windows MSIX release candidate verified: ${JSON.stringify(result)}`);
}
