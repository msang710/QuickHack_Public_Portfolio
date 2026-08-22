import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { QUICKHACK_MSIX_TARGETS, msixArtifactConfig } from "../../packaging/windows/msix/msix-artifact-config.mjs";
import {
  WINDOWS_RELEASE_NATIVE_CHECKS,
  createWindowsMsixReleaseCandidate,
  validateReleaseNativeEvidence,
} from "../../packaging/windows/msix/release-candidate.mjs";

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "quickhack-msix-release-"));
const repositoryRoot = path.join(temporaryRoot, "repository");
const distributionDirectory = path.join(repositoryRoot, "release", "distribution", "windows", "msix", "exact-four");
const outputDirectory = path.join(repositoryRoot, "release", "distribution", "windows", "msix", "release-metadata");
const evidenceDirectory = path.join(repositoryRoot, "release", "evidence");
const version = "2.0.0";
const sourceCommit = "a".repeat(40);
const publisher = "CN=QuickHack, O=QuickHack";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageHashes = {};

function writeTarget(target) {
  const config = msixArtifactConfig(target, { publisher });
  const directory = path.join(distributionDirectory, target);
  mkdirSync(directory, { recursive: true });
  const packageFile = `${config.installerFilePrefix}-${version}.msix`;
  const sidecarFile = `${config.installerFilePrefix}-msix-manifest-${version}.json`;
  const checksumFile = `${config.installerFilePrefix}-SHA256SUMS.txt`;
  const packageBytes = Buffer.from(`signed:${target}\n`, "utf8");
  const packageSha256 = digest(packageBytes);
  packageHashes[target] = packageSha256;
  writeFileSync(path.join(directory, packageFile), packageBytes);
  const sidecar = {
    schemaVersion: 2,
    packageTarget: target,
    artifactKind: config.artifactKind,
    semanticVersion: version,
    msixVersion: "2.0.0.0",
    identityName: config.identityName,
    publisher,
    signingMode: "PRODUCTION",
    signingProvider: "AZURE_ARTIFACT_SIGNING",
    sourceCommit,
    sourceDirty: false,
    packageFile,
    packageSha256,
    stagingInventorySha256: "1".repeat(64),
    packageContentInventorySha256: "2".repeat(64),
    brandingRevision: "windows-icon-2026-08-21",
    visualAssetManifestSha256: "3".repeat(64),
    canonicalIconSha256: "4".repeat(64),
    compiledIcon: {
      executableSha256: "5".repeat(64),
      width: 32,
      height: 32,
      pixelSha256: "6".repeat(64),
    },
    nodeRuntime: { version: "24.17.0", archiveSha256: "7".repeat(64) },
    postgresqlRuntime: target.endsWith("-server")
      ? { version: "18.4", archiveSha256: "8".repeat(64) }
      : null,
    signature: {
      status: "VALID",
      subject: publisher,
      thumbprint: "9".repeat(40),
      timestampVerified: true,
      timestampSubject: "CN=Timestamp",
      timestampThumbprint: "b".repeat(40),
    },
  };
  const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  writeFileSync(path.join(directory, sidecarFile), sidecarBytes);
  writeFileSync(
    path.join(directory, checksumFile),
    `${packageSha256}  ${packageFile}\n${digest(sidecarBytes)}  ${sidecarFile}\n`,
    "ascii"
  );
}

function nativeEvidence(osFamily, osBuild, overrides = {}) {
  return {
    schemaVersion: 1,
    status: "PASS",
    evidenceId: `quickhack-${osFamily.toLowerCase().replaceAll("_", "-")}-fixture`,
    osFamily,
    productType: "WORKSTATION",
    osBuild,
    sourceCommit,
    semanticVersion: version,
    publisher,
    packageHashes: { ...packageHashes },
    checks: Object.fromEntries(WINDOWS_RELEASE_NATIVE_CHECKS.map((name) => [name, true])),
    counts: { criticalFailure: 0, stateLoss: 0, duplicateLeader: 0, iconMismatch: 0, residue: 0 },
    externalOperations: {
      status: "NOT_APPLICABLE",
      reason: "EXTERNAL_OPERATION_ENVIRONMENT_UNAVAILABLE",
    },
    ...overrides,
  };
}

try {
  for (const target of QUICKHACK_MSIX_TARGETS) writeTarget(target);
  mkdirSync(evidenceDirectory, { recursive: true });
  const windows10Path = path.join(evidenceDirectory, "windows-10.json");
  const windows11Path = path.join(evidenceDirectory, "windows-11.json");
  writeFileSync(windows10Path, `${JSON.stringify(nativeEvidence("WINDOWS_10", 19045), null, 2)}\n`);
  writeFileSync(windows11Path, `${JSON.stringify(nativeEvidence("WINDOWS_11", 26200), null, 2)}\n`);

  const result = createWindowsMsixReleaseCandidate({
    repositoryRoot,
    distributionDirectory,
    outputDirectory,
    version,
    publisher,
    sourceCommit,
    nativeEvidenceFiles: [windows11Path, windows10Path],
  });
  assert.equal(result.publicAssetCount, 16);
  assert.equal(result.manifest.packages.length, 4);
  assert.deepEqual(result.manifest.nativeEvidence.map((entry) => entry.osFamily), ["WINDOWS_10", "WINDOWS_11"]);
  assert.equal(readdirSync(outputDirectory).length, 4);
  assert.equal(existsSync(path.join(outputDirectory, result.manifestName)), true);
  assert.equal(readFileSync(path.join(outputDirectory, result.checksumName), "ascii").split(/\r?\n/u).filter(Boolean).length, 15);

  assert.throws(
    () => createWindowsMsixReleaseCandidate({
      repositoryRoot,
      distributionDirectory,
      outputDirectory,
      version,
      publisher,
      sourceCommit,
      nativeEvidenceFiles: [windows11Path],
    }),
    (error) => error?.code === "MSIX_NATIVE_EVIDENCE_INCOMPLETE"
  );
  assert.throws(
    () => validateReleaseNativeEvidence(
      nativeEvidence("WINDOWS_10", 19045, {
        packageHashes: { ...packageHashes, "demo-client": "f".repeat(64) },
      }),
      { sourceCommit, version, publisher, packageHashes }
    ),
    (error) => error?.code === "MSIX_NATIVE_EVIDENCE_STALE"
  );
  assert.throws(
    () => validateReleaseNativeEvidence(
      nativeEvidence("WINDOWS_11", 26200, {
        checks: { ...nativeEvidence("WINDOWS_11", 26200).checks, shellIcon: false },
      }),
      { sourceCommit, version, publisher, packageHashes }
    ),
    (error) => error?.code === "MSIX_NATIVE_EVIDENCE_INCOMPLETE"
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("QuickHack production MSIX release candidate and dual-workstation evidence contract verified.");
