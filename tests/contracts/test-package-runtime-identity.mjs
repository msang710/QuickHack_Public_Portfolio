import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPackageManifest } from "../../packaging/common/package-manifest.mjs";
import {
  QUICKHACK_RUNTIME_CONTRACT_VERSION,
  readPackageRuntimeIdentitySync,
} from "../../quickhack_shared/core/package-runtime-identity.mjs";

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "quickhack-package-identity-"));
try {
  const manifestPath = path.join(temporaryRoot, "quickhack-package.json");
  const manifest = createPackageManifest({
    artifactKind: "OPERATIONAL_SERVER",
    platform: "win32",
    version: "1.2.3-test",
    contentInventorySha256: "a".repeat(64),
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const identity = readPackageRuntimeIdentitySync({
    manifestPath,
    artifactKind: "OPERATIONAL_SERVER",
    runtimeRole: "SERVER",
    deploymentFlavor: "OPERATIONAL",
    required: true,
  });
  assert.equal(identity.runtimeContractVersion, QUICKHACK_RUNTIME_CONTRACT_VERSION);
  assert.equal(identity.artifactKind, "OPERATIONAL_SERVER");
  assert.equal(identity.manifestPath, manifestPath);
  assert.equal(Object.isFrozen(identity), true);

  assert.throws(
    () => readPackageRuntimeIdentitySync({ manifestPath, artifactKind: "DEMONSTRATION_SERVER" }),
    (error) => error?.code === "PACKAGE_FLAVOR_MISMATCH"
  );
  assert.equal(readPackageRuntimeIdentitySync({ manifestPath: "", required: false }), null);
  assert.throws(
    () => readPackageRuntimeIdentitySync({ manifestPath: "", required: true }),
    (error) => error?.code === "PACKAGE_ARTIFACT_INVALID"
  );

  writeFileSync(manifestPath, JSON.stringify({ ...manifest, unexpected: true }), "utf8");
  assert.throws(
    () => readPackageRuntimeIdentitySync({ manifestPath }),
    (error) => error?.code === "PACKAGE_ARTIFACT_INVALID"
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("Package runtime identity manifest reader verified.");
