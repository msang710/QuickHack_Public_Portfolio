import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SERVER_REPAIR_STATE_SECURITY_SCRIPT } from "../../tools/platform/windows/server-repair-adapter.mjs";

const source = readFileSync(
  new URL("../../tools/platform/windows/server-repair-adapter.mjs", import.meta.url),
  "utf8"
);
for (const contract of [
  /verifyMsixPackage/u,
  /signatureMode: "SIGNED"/u,
  /classifyLegacyWindowsInstall/u,
  /inspectWindowsServerSecretScopes/u,
  /server-provisioning-v1\.json/u,
  /INITIAL_LEADER_ACK_REQUIRED/u,
]) {
  assert.match(source, contract);
}
assert.match(SERVER_REPAIR_STATE_SECURITY_SCRIPT, /AreAccessRulesProtected/u);
assert.match(SERVER_REPAIR_STATE_SECURITY_SCRIPT, /S-1-5-20/u);
assert.match(SERVER_REPAIR_STATE_SECURITY_SCRIPT, /Get-NetFirewallRule/u);
assert.doesNotMatch(SERVER_REPAIR_STATE_SECURITY_SCRIPT, /Remove-|Set-Acl|Stop-Service|Start-Service/u);

console.log("Windows server repair diagnosis is read-only and package/product separated.");
