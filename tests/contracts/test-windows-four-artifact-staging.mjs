import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WINDOWS_PACKAGE_TARGETS, windowsArtifactConfig } from "../../packaging/windows/windows-artifact-config.mjs";

assert.deepEqual(WINDOWS_PACKAGE_TARGETS, [
  "demo-server",
  "demo-client",
  "operational-server",
  "operational-client",
]);

const configs = WINDOWS_PACKAGE_TARGETS.map(windowsArtifactConfig);
assert.equal(new Set(configs.map((item) => item.installedIdentity)).size, 4);
assert.equal(new Set(configs.map((item) => item.launcherFileName)).size, 4);
assert.equal(new Set(configs.map((item) => item.stagingRoot)).size, 4);
assert.deepEqual(
  configs.filter((item) => item.role === "server").map((item) => item.services.postgresql),
  ["QuickHackDemoPostgreSQL", "QuickHackOperationalPostgreSQL"]
);
assert.deepEqual(
  configs.filter((item) => item.role === "client").map((item) => item.localRuntimePort),
  [3001, 3002]
);

const stagingSource = readFileSync(new URL("../../packaging/create-staging-package.mjs", import.meta.url), "utf8");
const launcherBuild = readFileSync(new URL("../../packaging/build-windows-launchers.ps1", import.meta.url), "utf8");
const installerBuild = readFileSync(new URL("../../packaging/build-installer.ps1", import.meta.url), "utf8");
const serverInstaller = readFileSync(new URL("../../packaging/quickhack.iss", import.meta.url), "utf8");
const clientInstaller = readFileSync(new URL("../../packaging/quickhack-demo-client.iss", import.meta.url), "utf8");
const launcherSource = readFileSync(new URL("../../packaging/windows-launcher/QuickHackLauncher.cs", import.meta.url), "utf8");
const clientRuntimeLauncher = readFileSync(new URL("../../tools/client-runtime-launcher.mjs", import.meta.url), "utf8");
const clientRuntimeBootstrap = readFileSync(new URL("../../tools/client-runtime-bootstrap.mjs", import.meta.url), "utf8");

assert.match(stagingSource, /createPackageManifest/);
assert.match(stagingSource, /collectServerRuntimeClosure/);
assert.match(stagingSource, /isDemonstrationPackage/);
assert.match(stagingSource, /tools\/server-provisioning-cli\.mjs/u);
assert.match(stagingSource, /QuickHackPostgresqlServiceHost\.exe/u);
assert.match(stagingSource, /QuickHackServerServiceHost\.exe/u);
assert.match(stagingSource, /QuickHack-\$\{productQualifier\}-Server-Setup\.exe/u);
assert.match(stagingSource, /isServerPackage \? \["tools\/server-provisioning-cli\.mjs"\] : \[\]/u);
assert.match(stagingSource, /runtimeTargetDir, "node", "quickhack-node-runtime\.json"/u);
assert.doesNotMatch(installerBuild, /Compress-Archive|Portable-/);
assert.match(installerBuild, /ConvertTo-InnoEscapedAppId/);
assert.match(installerBuild, /\/DArtifactAppId=\$\(ConvertTo-InnoEscapedAppId/);
assert.match(serverInstaller, /#define ArtifactAppId "\{\{5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82\}"/);
assert.match(clientInstaller, /#define ArtifactAppId "\{\{7D88F75C-5D65-4B34-9DD6-EFB19332DD33\}"/);
assert.match(clientRuntimeLauncher, /composeProcessExecution/);
assert.doesNotMatch(clientRuntimeLauncher, /composeOperatorPlatform/);
assert.match(clientRuntimeBootstrap, /composeProcessExecution/);
assert.doesNotMatch(clientRuntimeBootstrap, /composeOperatorPlatform/);
assert.match(launcherSource, /GetCurrentPackageFullName/u);
assert.match(launcherSource, /StartPackagedServer/u);
assert.match(launcherSource, /ServerSetupExecutable/u);
assert.match(launcherSource, /OppositeServerServiceName/u);
assert.match(launcherSource, /NativeErrorCode == 1060/u);
assert.match(launcherSource, /provisioning",[\s\S]*"READY"/u);
assert.match(launcherSource, /QuickHack-Demo-Server-Setup\.exe/u);
for (const config of configs) {
  assert.ok(launcherBuild.includes(config.launcherFileName));
  assert.ok(installerBuild.includes(config.installedIdentity));
  assert.ok(installerBuild.includes(config.mutableRootName));
  assert.ok(launcherSource.includes(config.artifactKind));
}
assert.match(
  JSON.stringify(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts),
  /prestage:windows:operational-server[\s\S]*build:windows-msix-service-hosts[\s\S]*operational-server[\s\S]*build:windows-msix-server-setup/u
);

console.log("Windows four-artifact staging, launcher, and installer identities verified.");
