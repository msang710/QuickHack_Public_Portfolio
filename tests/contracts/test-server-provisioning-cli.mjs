import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cli = readFileSync(
  new URL("../../tools/server-provisioning-cli.mjs", import.meta.url),
  "utf8"
);
const adapter = readFileSync(
  new URL("../../tools/platform/windows/server-provisioning-adapter.mjs", import.meta.url),
  "utf8"
);
const artifactConfig = readFileSync(
  new URL("../../tools/platform/windows/server-provisioning-artifact-config.mjs", import.meta.url),
  "utf8"
);

for (const contract of [
  /QUICKHACK_SERVER_SETUP_HANDOFF_V1/u,
  /--handoff-stdio/u,
  /acknowledgeInitialLeader/u,
  /createWindowsServerProvisioningJournal/u,
  /createWindowsServerProvisioningAdapter/u,
  /createWindowsLegacyMsixMigration/u,
  /createWindowsLegacyMigrationJournal/u,
  /createServerRepairCore/u,
  /createWindowsServerRepairAdapter/u,
  /allowExistingLeaderAdoption: true/u,
  /errorCode=/u,
]) {
  assert.match(cli, contract);
}
assert.doesNotMatch(cli, /console\.(?:log|error)|JSON\.stringify\(result\)/u);

for (const contract of [
  /OPPOSITE_SERVER_FLAVOR_PRESENT/u,
  /LEGACY_INSTALL_MIGRATION_REQUIRED/u,
  /classifyLegacyWindowsInstall/u,
  /serviceOwnership: "PACKAGED"/u,
  /POSTGRES_CLUSTER_READY/u,
  /QUICKHACK_SERVICES_READY_V1/u,
  /QUICKHACK_SERVER_READY_V1/u,
  /provisionInitialLeaderHandoff/u,
  /coupangWriteApiEnabled: false/u,
  /logenWriteApiEnabled: false/u,
  /includeNetworkService: true/u,
  /RemoteAddress LocalSubnet/u,
  /bootstrapUsers/u,
  /credential_revision/u,
  /allowExistingLeaderAdoption/u,
  /adoptedExistingLeader/u,
  /Stop-Service -InputObject \$console -Force/u,
  /Stop-Service -InputObject \$postgres -Force/u,
  /Start-Service -InputObject \$postgres[\s\S]*Start-Service -InputObject \$console/u,
]) {
  assert.match(adapter, contract);
}
for (const contract of [
  /QuickHack HTTPS Server \(Local Subnet\)/u,
  /coupangMockName/u,
  /packageFlavor === "DEMONSTRATION"/u,
  /serviceName\(own, "postgresql"\)/u,
  /opposite\.services\.map/u,
]) {
  assert.match(artifactConfig, contract);
}
assert.doesNotMatch(adapter, /pg_ctl|registerService/u);

console.log("QuickHack Windows server provisioning CLI, adapter, and protected handoff contract verified.");
