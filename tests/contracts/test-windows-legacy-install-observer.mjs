import assert from "node:assert/strict";
import {
  LEGACY_INSTALL_OBSERVE_SCRIPT,
  observeLegacyWindowsInstall,
} from "../../tools/platform/windows/legacy-install-observer.mjs";

for (const required of [
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "Get-CimInstance -ClassName Win32_Service",
  "Get-AppxPackage -Name $request.ownIdentity",
  "Test-Path -LiteralPath $uninstaller -PathType Leaf",
  "FileAttributes]::ReparsePoint",
  "server-runtime.json",
  "PG_VERSION",
]) {
  assert.ok(LEGACY_INSTALL_OBSERVE_SCRIPT.includes(required));
}
assert.doesNotMatch(LEGACY_INSTALL_OBSERVE_SCRIPT, /Remove-|Stop-Service|Start-Service|Set-Item|New-Item/u);

let invocation;
const observed = await observeLegacyWindowsInstall({
  target: "demo-server",
  packageRoot: "C:\\Program Files\\WindowsApps\\QuickHack.Demonstration.Server_1.0.0.0_x64",
  programData: "C:\\ProgramData",
  allowNonWindows: true,
  async runPowerShellScript(script, options) {
    invocation = { script, options };
    return JSON.stringify({ programFiles: "C:\\Program Files", services: [] });
  },
});
assert.equal(observed.programFiles, "C:\\Program Files");
assert.equal(invocation.options.timeoutMs, 60_000);
const request = JSON.parse(Buffer.from(invocation.options.inputLine, "base64").toString("utf8"));
assert.equal(request.ownAppId, "{5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82}");
assert.equal(request.oppositeIdentity, "QuickHack.Operational.Server");
assert.deepEqual(request.ownServices, [
  "QuickHackDemoPostgreSQL",
  "QuickHackDemoServerConsole",
]);
assert.doesNotMatch(invocation.script, /QuickHackDemoPostgreSQL|5E9CD754/u);

console.log("Windows legacy observation is exact, read-only, and data-driven.");
