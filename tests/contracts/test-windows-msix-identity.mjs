import assert from "node:assert/strict";
import {
  QUICKHACK_MSIX_DEVELOPMENT_PUBLISHER,
  QUICKHACK_MSIX_MINIMUM_OS_VERSION,
  QUICKHACK_MSIX_TARGETS,
  assertProductionMsixPublisher,
  msixArtifactConfig,
} from "../../packaging/windows/msix/msix-artifact-config.mjs";
import {
  assertMsixVersion,
  msixVersionFromSemver,
} from "../../packaging/windows/msix/msix-version.mjs";

const configs = QUICKHACK_MSIX_TARGETS.map((target) => msixArtifactConfig(target));
assert.equal(configs.length, 4);
assert.equal(new Set(configs.map((config) => config.identityName)).size, 4);
assert.equal(new Set(configs.map((config) => config.applicationId)).size, 4);
assert.equal(new Set(configs.map((config) => config.legacyInstalledIdentity)).size, 4);
assert.deepEqual(configs.map((config) => config.packageTarget), [
  "demo-server",
  "demo-client",
  "operational-server",
  "operational-client",
]);
for (const config of configs) {
  assert.equal(config.minimumOsVersion, QUICKHACK_MSIX_MINIMUM_OS_VERSION);
  assert.equal(config.architecture, "x64");
  assert.equal(config.runtime.node, true);
  assert.equal(config.runtime.postgresql, config.role === "server");
  assert.equal(config.services.length, config.role === "server" ? 2 : 0);
  assert.match(config.legacyAppId, /^\{[A-F0-9-]{36}\}$/u);
  assert.equal(
    config.serviceHostsReady,
    config.packageTarget === "demo-server"
  );
}
assert.equal(msixArtifactConfig("demo-server").oppositeServerIdentity, "QuickHack.Operational.Server");
assert.equal(msixArtifactConfig("operational-server").oppositeServerIdentity, "QuickHack.Demonstration.Server");
assert.equal(msixArtifactConfig("demo-client").oppositeServerIdentity, null);
const preview = msixArtifactConfig("demo-server", { preview: true });
assert.equal(preview.identityName, "QuickHack.Preview.Demonstration.Server");
assert.equal(preview.applicationId, "QuickHackPreviewDemoServer");
assert.deepEqual(preview.services.map((service) => service.name), [
  "QuickHackPreviewDemoPostgreSQL",
  "QuickHackPreviewDemoServerConsole",
]);
assert.equal(preview.serviceHostsReady, true);
assert.equal(preview.oppositeServerIdentity, null);
assert.throws(
  () => msixArtifactConfig("demo-client", { preview: true }),
  (error) => error.code === "MSIX_PREVIEW_TARGET_INVALID"
);

assert.equal(msixVersionFromSemver("1.2.3"), "1.2.3.0");
assert.equal(msixVersionFromSemver("1.2.3-beta.4"), "1.2.3.4");
assert.equal(msixVersionFromSemver("1.2.3-preview"), msixVersionFromSemver("1.2.3-preview"));
assert.equal(msixVersionFromSemver("1.2.3", { revision: 9 }), "1.2.3.9");
assert.equal(assertMsixVersion("65535.0.1.2"), "65535.0.1.2");
assert.throws(() => msixVersionFromSemver("65536.0.0"), /65535/u);
assert.throws(() => assertMsixVersion("1.2.3"), /four/u);
assert.throws(
  () => assertProductionMsixPublisher(QUICKHACK_MSIX_DEVELOPMENT_PUBLISHER),
  (error) => error.code === "MSIX_PRODUCTION_PUBLISHER_REQUIRED"
);
assert.equal(assertProductionMsixPublisher("CN=QuickHack, O=QuickHack"), "CN=QuickHack, O=QuickHack");

console.log("QuickHack exact-four MSIX identity, runtime, and version contracts verified.");
