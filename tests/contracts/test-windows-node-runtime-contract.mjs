import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(
  readFileSync(new URL("../../packaging/windows/node-runtime.json", import.meta.url), "utf8")
);
const prepare = readFileSync(
  new URL("../../packaging/windows/prepare-node-runtime.ps1", import.meta.url),
  "utf8"
);
const staging = readFileSync(
  new URL("../../packaging/create-staging-package.mjs", import.meta.url),
  "utf8"
);
const launcher = readFileSync(
  new URL("../../packaging/windows-launcher/QuickHackLauncher.cs", import.meta.url),
  "utf8"
);
const nativeClientLifecycle = readFileSync(
  new URL("../integration/windows/msix/test-demo-client-msix.ps1", import.meta.url),
  "utf8"
);
const certificateGuardian = readFileSync(
  new URL(
    "../integration/windows/msix/quickhack-test-certificate-guardian.ps1",
    import.meta.url
  ),
  "utf8"
);

assert.equal(config.schemaVersion, 1);
assert.match(config.version, /^24\.[0-9]+\.[0-9]+$/u);
assert.equal(config.architecture, "win-x64");
assert.match(config.archiveSha256, /^[a-f0-9]{64}$/u);
assert.equal(
  config.downloadUrl,
  `https://nodejs.org/dist/v${config.version}/${config.archiveFile}`
);
assert.match(prepare, /Get-FileHash[\s\S]*archiveSha256/u);
assert.match(prepare, /nodejs\\\.org\/dist/u);
assert.match(prepare, /QuickHack Node runtime output must be a descendant/u);
assert.match(prepare, /quickhack-node-runtime\.json/u);
assert.match(staging, /runtimeTargetDir, "node", "LICENSE"/u);
assert.match(staging, /runtimeTargetDir, "node", "quickhack-node-runtime\.json"/u);
assert.match(launcher, /ConfigurePackagedClientEnvironment/u);
assert.match(launcher, /environment\["QUICKHACK_PACKAGE_MANIFEST"\] = manifest/u);
assert.match(launcher, /environment\["PATH"\] = String\.Join/u);
for (const forbiddenEnvironment of ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS"]) {
  assert.ok(launcher.includes(`"${forbiddenEnvironment}"`));
}
assert.match(launcher, /--no-open/u);
assert.match(launcher, /--quiet/u);
assert.match(launcher, /if \(quiet\)\s*\{\s*PersistLauncherError\(error\);/u);
assert.match(launcher, /File\.WriteAllText\(path, error\.ToString\(\), new UTF8Encoding\(false\)\)/u);
assert.match(nativeClientLifecycle, /launcher-error\.log/u);
assert.match(nativeClientLifecycle, /No quiet launcher error record was produced/u);
assert.match(nativeClientLifecycle, /-Verb RunAs/u);
assert.match(nativeClientLifecycle, /quickhack-test-certificate-guardian\.ps1/u);
assert.match(nativeClientLifecycle, /foreach \(\$storeName in @\("Root", "My"\)\)/u);
assert.doesNotMatch(nativeClientLifecycle, /@\("Root", "TrustedPeople", "My"\)/u);
assert.match(certificateGuardian, /Cert:\\LocalMachine\\TrustedPeople/u);
assert.match(certificateGuardian, /StoreLocation\]::LocalMachine/u);
assert.match(certificateGuardian, /"TrustedPeople"/u);

console.log("Pinned Windows Node runtime and package-owned client launcher contract verified.");
