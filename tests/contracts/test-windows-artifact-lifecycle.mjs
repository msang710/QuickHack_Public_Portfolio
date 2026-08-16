import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertPackageInstallPreflight } from "../../packaging/common/package-install-preflight.mjs";
import { createPackageLifecyclePlan } from "../../packaging/common/package-state-lifecycle.mjs";
import { windowsArtifactConfig } from "../../packaging/windows/windows-artifact-config.mjs";

const demo = windowsArtifactConfig("demo-server");
const operational = windowsArtifactConfig("operational-server");
assert.throws(
  () => assertPackageInstallPreflight({
    artifactKind: demo.artifactKind,
    installedPackageKinds: [operational.artifactKind],
    installedServiceKinds: [operational.artifactKind],
  }),
  (error) => error?.code === "SERVER_FLAVOR_CONFLICT"
);

const uninstall = createPackageLifecyclePlan({
  operation: "UNINSTALL",
  artifactKind: demo.artifactKind,
  mutablePaths: ["C:\\ProgramData\\QuickHack\\demonstration-server"],
});
assert.equal(uninstall.preserveMutableState, true);
assert.deepEqual(uninstall.removeMutablePaths, []);

const purgeSource = readFileSync(new URL("../../packaging/windows/purge-installation.ps1", import.meta.url), "utf8");
assert.match(purgeSource, /ConfirmArtifactKind -cne \$ArtifactKind/);
assert.match(purgeSource, /AcknowledgeNoRecovery/);
assert.match(purgeSource, /FileAttributes\]::ReparsePoint/);
assert.match(purgeSource, /PURGE_PARTIAL/);
for (const serviceName of [...Object.values(demo.services), ...Object.values(operational.services)]) {
  assert.ok(purgeSource.includes(serviceName));
}

const installer = readFileSync(new URL("../../packaging/quickhack.iss", import.meta.url), "utf8");
assert.match(installer, /Mutable state .* intentionally retained/);
assert.doesNotMatch(installer, /\[UninstallDelete\][\s\S]*Type:\s*filesandordirs/u);

console.log("Windows server conflict, uninstall preservation, and explicit purge contract verified.");
