import assert from "node:assert/strict";
import { classifyLegacyWindowsInstall } from "../../packaging/windows/msix/legacy-install-detector.mjs";

const programFiles = "C:\\Program Files";
const programData = "C:\\ProgramData";
const installRoot = `${programFiles}\\QuickHack Demo Server`;
const stateRoot = `${programData}\\QuickHack\\demonstration-server`;
const packageRoot = "C:\\Program Files\\WindowsApps\\QuickHack.Demonstration.Server_1.0.0.0_x64";

function state(overrides = {}) {
  return {
    exists: true,
    root: stateRoot,
    reparsePoint: false,
    postgresqlMajor: "18",
    runtimeConfig: {
      schemaVersion: 3,
      packageFlavor: "DEMONSTRATION",
      dataDirectory: `${stateRoot}\\data`,
    },
    ...overrides,
  };
}

function registration(overrides = {}) {
  return {
    appId: "{5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82}",
    displayName: "QuickHack Demo Server",
    displayVersion: "1.0.0",
    installLocation: installRoot,
    uninstallString: `"${installRoot}\\unins000.exe"`,
    quietUninstallString: `"${installRoot}\\unins000.exe" /SILENT`,
    uninstallerRegularFile: true,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    programFiles,
    programData,
    packageRoot,
    registry: { own: registration(), opposite: null },
    packages: [{ identityName: "QuickHack.Demonstration.Server" }],
    services: [
      {
        name: "QuickHackDemoPostgreSQL",
        pathName: `"${installRoot}\\runtime\\postgresql\\bin\\pg_ctl.exe" runservice`,
      },
      {
        name: "QuickHackDemoServerConsole",
        pathName: `"${installRoot}\\QuickHack-Demo-Server.exe" --service`,
      },
    ],
    state: state(),
    ...overrides,
  };
}

const compatible = classifyLegacyWindowsInstall({
  target: "demo-server",
  observation: observation(),
});
assert.equal(compatible.classification, "COMPATIBLE");
assert.equal(compatible.mode, "INSTALLED_INNO");
assert.equal(compatible.legacyUninstaller, `${installRoot}\\unins000.exe`);
assert.deepEqual(compatible.legacyServices, [
  "QuickHackDemoPostgreSQL",
  "QuickHackDemoServerConsole",
]);
assert.equal(
  classifyLegacyWindowsInstall({
    artifactKind: "DEMONSTRATION_SERVER",
    observation: observation(),
  }).classification,
  "COMPATIBLE"
);

const preserved = classifyLegacyWindowsInstall({
  target: "demo-server",
  observation: observation({
    registry: { own: null, opposite: null },
    services: [
      {
        name: "QuickHackDemoPostgreSQL",
        pathName: `"${packageRoot}\\Services\\QuickHackPostgresqlServiceHost.exe"`,
      },
    ],
  }),
});
assert.equal(preserved.classification, "COMPATIBLE");
assert.equal(preserved.mode, "PRESERVED_STATE");

const none = classifyLegacyWindowsInstall({
  target: "demo-server",
  observation: observation({
    registry: { own: null, opposite: null },
    services: [],
    state: { exists: false, root: stateRoot },
  }),
});
assert.equal(none.classification, "NONE");

const pendingMsixState = classifyLegacyWindowsInstall({
  target: "demo-server",
  observation: observation({
    registry: { own: null, opposite: null },
    services: [{
      name: "QuickHackDemoPostgreSQL",
      pathName: `"${packageRoot}\\Services\\QuickHackPostgresqlServiceHost.exe"`,
    }],
    state: state({ runtimeConfig: null, postgresqlMajor: null }),
  }),
});
assert.equal(pendingMsixState.classification, "NONE");
assert.equal(pendingMsixState.reasonCode, "MSIX_STATE_PENDING_PROVISIONING");

for (const oppositeObservation of [
  { registry: { own: registration(), opposite: { appId: "opposite" } } },
  { services: [{ name: "QuickHackOperationalPostgreSQL", pathName: "C:\\opposite.exe" }] },
  { packages: [{ identityName: "QuickHack.Operational.Server" }] },
]) {
  const result = classifyLegacyWindowsInstall({
    target: "demo-server",
    observation: observation(oppositeObservation),
  });
  assert.equal(result.classification, "OPPOSITE");
  assert.equal(result.mutationAllowed, false);
}

for (const [overrides, expectedReason] of [
  [{ sharedLegacyService: true }, "LEGACY_SHARED_SERVICE_AMBIGUOUS"],
  [{ registry: { own: registration({ installLocation: "D:\\QuickHack" }), opposite: null } }, "LEGACY_REGISTRATION_AMBIGUOUS"],
  [{ registry: { own: registration({ uninstallString: "C:\\Windows\\evil.exe", quietUninstallString: "" }), opposite: null } }, "LEGACY_UNINSTALLER_AMBIGUOUS"],
  [{ state: state({ reparsePoint: true }) }, "LEGACY_STATE_ROOT_AMBIGUOUS"],
  [{ state: state({ runtimeConfig: null, postgresqlMajor: null }) }, "LEGACY_STATE_INCOMPLETE"],
]) {
  const result = classifyLegacyWindowsInstall({ target: "demo-server", observation: observation(overrides) });
  assert.equal(result.classification, "AMBIGUOUS");
  assert.equal(result.reasonCode, expectedReason);
}

for (const overrides of [
  { registry: { own: registration({ displayVersion: "2.0.0" }), opposite: null } },
  { state: state({ runtimeConfig: { schemaVersion: 2 } }) },
  { state: state({ postgresqlMajor: "17" }) },
]) {
  const result = classifyLegacyWindowsInstall({ target: "demo-server", observation: observation(overrides) });
  assert.equal(result.classification, "INCOMPATIBLE");
  assert.equal(result.mutationAllowed, false);
}

assert.equal(
  classifyLegacyWindowsInstall({
    target: "demo-server",
    observation: observation({
      registry: { own: null, opposite: null },
      state: { exists: false, root: stateRoot },
      services: [{ name: "QuickHackDemoPostgreSQL", pathName: `"${installRoot}\\pg_ctl.exe"` }],
    }),
  }).reasonCode,
  "LEGACY_PARTIAL_SERVICE_REGISTRATION"
);

console.log("Windows legacy Inno finite classification and mutation-zero decisions verified.");
