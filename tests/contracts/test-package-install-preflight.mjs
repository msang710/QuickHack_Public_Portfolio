import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertPackageInstallPreflight } from "../../packaging/common/package-install-preflight.mjs";

const installer = readFileSync(new URL("../../packaging/quickhack.iss", import.meta.url), "utf8");
const windowsPreflight = readFileSync(
  new URL("../../packaging/windows/invoke-install-preflight.ps1", import.meta.url),
  "utf8"
);

assert.equal(
  assertPackageInstallPreflight({
    artifactKind: "DEMONSTRATION_SERVER",
    preservedStateKinds: ["OPERATIONAL_SERVER"],
  }).mutationAllowed,
  true,
  "Preserved opposite-flavor state alone must not block installation."
);
assert.throws(
  () => assertPackageInstallPreflight({
    artifactKind: "DEMONSTRATION_SERVER",
    installedPackageKinds: ["OPERATIONAL_SERVER"],
  }),
  (error) => error.code === "SERVER_FLAVOR_CONFLICT" && error.details.conflictingArtifactKind === "OPERATIONAL_SERVER"
);
assert.throws(
  () => assertPackageInstallPreflight({
    artifactKind: "OPERATIONAL_SERVER",
    installedServiceKinds: ["DEMONSTRATION_SERVER"],
  }),
  (error) => error.code === "SERVER_FLAVOR_CONFLICT"
);
assert.throws(
  () => assertPackageInstallPreflight({ artifactKind: "OPERATIONAL_SERVER", legacyLayoutDetected: true }),
  (error) => error.code === "LEGACY_LAYOUT_DETECTED"
);
assert.equal(
  assertPackageInstallPreflight({
    artifactKind: "OPERATIONAL_CLIENT",
    installedPackageKinds: ["DEMONSTRATION_CLIENT"],
  }).mutationAllowed,
  true
);

assert.match(installer, /Source: "windows\\invoke-install-preflight\.ps1"; Flags: dontcopy/);
assert.match(installer, /ExtractTemporaryFile\('invoke-install-preflight\.ps1'\)/);
assert.match(installer, /-File \"' \+\s*ScriptPath/);
assert.match(installer, /-ArtifactKind \"{#ArtifactKind}\"/);
assert.match(installer, /InstallPreflightErrorMessage\(ResultCode\)/);
assert.doesNotMatch(
  installer.slice(
    installer.indexOf("function PrepareToInstall"),
    installer.indexOf("procedure DeleteProvisionResult")
  ),
  /-Command|Get-Service|Stop-Service/,
  "The Inno preflight must delegate native inspection to the typed helper."
);
for (const [name, code] of Object.entries({
  Ready: 0,
  OppositePackage: 30,
  OppositeService: 31,
  LegacyLayout: 32,
  InspectionFailed: 33,
  StopFailed: 34,
  StopTimeout: 35,
  InvalidConfiguration: 36,
})) {
  assert.match(
    windowsPreflight,
    new RegExp(`${name}\\s*=\\s*${code}`),
    `Missing Windows install preflight result: ${name}`
  );
}
assert.match(windowsPreflight, /NoServiceFoundForGivenName/);
assert.match(windowsPreflight, /exit \$preflightResult\.Code/);
assert.match(windowsPreflight, /Reason = "READY"|Reason "READY"/);

console.log("QuickHack package and Windows installer preflight behavior verified.");
