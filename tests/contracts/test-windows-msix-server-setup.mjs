import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { msixArtifactConfig } from "../../packaging/windows/msix/msix-artifact-config.mjs";
import { renderAppxManifest } from "../../packaging/windows/msix/render-appx-manifest.mjs";

const setupSource = readFileSync(
  new URL("../../packaging/windows/msix/server-setup/QuickHackServerSetup.cs", import.meta.url),
  "utf8"
);
const executableManifest = readFileSync(
  new URL("../../packaging/windows/msix/server-setup/QuickHackServerSetup.exe.manifest", import.meta.url),
  "utf8"
);
const buildScript = readFileSync(
  new URL("../../packaging/build-msix-server-setup.ps1", import.meta.url),
  "utf8"
);
const buildMsix = readFileSync(
  new URL("../../packaging/build-msix.ps1", import.meta.url),
  "utf8"
);

const demoServer = msixArtifactConfig("demo-server");
assert.equal(demoServer.setup.applicationId, "QuickHackDemoServerSetup");
assert.equal(demoServer.setup.executable, "QuickHack-Demo-Server-Setup.exe");
assert.equal(msixArtifactConfig("demo-client").setup, null);

const serverManifest = renderAppxManifest({
  target: "demo-server",
  version: "1.0.0",
  includeServerSetup: true,
});
assert.match(serverManifest, /Id="QuickHackDemoServerSetup"/u);
assert.match(serverManifest, /Executable="QuickHack-Demo-Server-Setup\.exe"/u);
assert.match(serverManifest, /Name="allowElevation"/u);
assert.equal((serverManifest.match(/<Application\b/gu) ?? []).length, 2);
assert.throws(
  () => renderAppxManifest({
    target: "demo-client",
    version: "1.0.0",
    includeServerSetup: true,
  }),
  (error) => error.code === "MSIX_SETUP_TARGET_INVALID"
);
const clientManifest = renderAppxManifest({ target: "demo-client", version: "1.0.0" });
assert.doesNotMatch(clientManifest, /allowElevation|ServerSetup/u);

assert.match(executableManifest, /requestedExecutionLevel level="requireAdministrator"/u);
assert.match(buildScript, /\/win32manifest:\$manifestPath/u);
assert.match(buildScript, /\/platform:x64/u);
assert.match(buildScript, /\/target:winexe/u);
assert.match(buildMsix, /IncludeServerSetup/u);
assert.match(buildMsix, /--include-server-setup/u);

for (const contract of [
  /runtime", "node", "node\.exe/u,
  /server-provisioning-cli\.mjs/u,
  /RedirectStandardOutput = true/u,
  /RedirectStandardError = true/u,
  /QUICKHACK_SERVER_SETUP_HANDOFF_V1/u,
  /--acknowledge/u,
  /--generation/u,
  /AppendAuditEvent/u,
  /passwordBox\.Clear\(\)/u,
]) {
  assert.match(setupSource, contract);
}
assert.doesNotMatch(setupSource, /File\.(?:WriteAllText|AppendAllText)\([^\n]*(?:Password|TemporaryPassword)/u);
assert.doesNotMatch(setupSource, /arguments\.Add\([^\n]*(?:Password|TemporaryPassword)/u);
assert.doesNotMatch(setupSource, /AppendAuditEvent\([^\n]*\.Message/u);

console.log("QuickHack elevated MSIX Server Setup manifest, build, and pipe handoff contract verified.");
