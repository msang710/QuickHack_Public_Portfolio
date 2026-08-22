import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEGACY_MIGRATION_STOP_SERVICES_SCRIPT,
} from "../../tools/platform/windows/legacy-msix-migration-adapter.mjs";

const source = readFileSync(
  new URL("../../tools/platform/windows/legacy-msix-migration-adapter.mjs", import.meta.url),
  "utf8"
);
for (const contract of [
  /classifyLegacyWindowsInstall/u,
  /boundedSnapshot/u,
  /inventorySha256/u,
  /\/VERYSILENT/u,
  /\/SUPPRESSMSGBOXES/u,
  /\/NORESTART/u,
  /shell: false/u,
  /REMOVE_LEGACY_BINARY/u,
  /PROVE_MSIX/u,
  /REPROTECT_CREDENTIALS/u,
  /migrateWindowsServerSecretScope/u,
  /CONVERGE_PROVISIONING/u,
]) {
  assert.match(source, contract);
}
assert.match(LEGACY_MIGRATION_STOP_SERVICES_SCRIPT, /Stop-Service -InputObject/u);
assert.match(LEGACY_MIGRATION_STOP_SERVICES_SCRIPT, /WaitForStatus/u);
assert.doesNotMatch(LEGACY_MIGRATION_STOP_SERVICES_SCRIPT, /Remove-|sc\.exe|rm\s/u);
assert.doesNotMatch(source, /exec\(|shell:\s*true/u);

console.log("Windows legacy migration adapter uses bounded snapshot, exact argv, and postconditions.");
