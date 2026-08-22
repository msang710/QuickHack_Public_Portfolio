import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { QUICKHACK_MSIX_TARGETS, msixArtifactConfig } from "../../packaging/windows/msix/msix-artifact-config.mjs";
import { verifyFourMsixDistribution } from "../../packaging/windows/msix/four-artifact-distribution.mjs";

const version = "1.2.3-pr07.7";
const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-four-msix-"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function writeTarget(target, overrides = {}) {
  const config = msixArtifactConfig(target);
  const directory = path.join(root, target);
  mkdirSync(directory, { recursive: true });
  const packageFile = `${config.installerFilePrefix}-${version}.msix`;
  const manifestFile = `${config.installerFilePrefix}-msix-manifest-${version}.json`;
  const checksumFile = `${config.installerFilePrefix}-SHA256SUMS.txt`;
  const packageBytes = Buffer.from(`fixture:${target}\n`, "utf8");
  writeFileSync(path.join(directory, packageFile), packageBytes);
  const manifest = {
    schemaVersion: 1,
    packageTarget: target,
    semanticVersion: version,
    publisher: "CN=QuickHack Development",
    signingMode: "TESTCERTIFICATE",
    sourceCommit: "a".repeat(40),
    sourceDirty: false,
    packageFile,
    packageSha256: digest(packageBytes),
    ...overrides,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(path.join(directory, manifestFile), manifestBytes);
  writeFileSync(
    path.join(directory, checksumFile),
    `${manifest.packageSha256}  ${packageFile}\n${digest(manifestBytes)}  ${manifestFile}\n`,
    "ascii"
  );
}

try {
  for (const target of QUICKHACK_MSIX_TARGETS) writeTarget(target);
  assert.deepEqual(verifyFourMsixDistribution({ directory: root, version }), {
    schemaVersion: 1,
    packageCount: 4,
    sidecarCount: 8,
    sourceCommit: "a".repeat(40),
    publisher: "CN=QuickHack Development",
    signingMode: "TESTCERTIFICATE",
  });

  writeFileSync(path.join(root, "stale.msix"), "stale", "utf8");
  assert.throws(
    () => verifyFourMsixDistribution({ directory: root, version }),
    (error) => error?.code === "MSIX_FOUR_ARTIFACT_INVENTORY_INVALID"
  );
  rmSync(path.join(root, "stale.msix"));

  writeTarget("operational-client", { sourceCommit: "b".repeat(40) });
  assert.throws(
    () => verifyFourMsixDistribution({ directory: root, version }),
    (error) => error?.code === "MSIX_FOUR_ARTIFACT_PROVENANCE_MISMATCH"
  );
  writeTarget("operational-client", { sourceDirty: true });
  assert.throws(
    () => verifyFourMsixDistribution({ directory: root, version }),
    (error) => error?.code === "MSIX_FOUR_ARTIFACT_SOURCE_DIRTY"
  );
  assert.equal(
    verifyFourMsixDistribution({ directory: root, version, allowDirtySource: true }).packageCount,
    4
  );

  const checksum = readFileSync(
    path.join(root, "demo-client", `QuickHack-Demo-Client-SHA256SUMS.txt`),
    "utf8"
  );
  assert.match(checksum, new RegExp(`QuickHack-Demo-Client-${version}\\.msix`, "u"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("QuickHack exact-four MSIX inventory, provenance, and checksum contract verified.");
