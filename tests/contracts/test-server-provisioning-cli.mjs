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

for (const contract of [
  /QUICKHACK_SERVER_SETUP_HANDOFF_V1/u,
  /--handoff-stdio/u,
  /acknowledgeInitialLeader/u,
  /createWindowsServerProvisioningJournal/u,
  /createWindowsServerProvisioningAdapter/u,
  /errorCode=/u,
]) {
  assert.match(cli, contract);
}
assert.doesNotMatch(cli, /console\.(?:log|error)|JSON\.stringify\(result\)/u);

for (const contract of [
  /OPPOSITE_SERVER_FLAVOR_PRESENT/u,
  /serviceOwnership: "PACKAGED"/u,
  /POSTGRES_CLUSTER_READY/u,
  /QUICKHACK_SERVICES_READY_V1/u,
  /QUICKHACK_SERVER_READY_V1/u,
  /provisionInitialLeaderHandoff/u,
  /coupangWriteApiEnabled: false/u,
  /logenWriteApiEnabled: false/u,
  /includeNetworkService: true/u,
  /QuickHack HTTPS Server \(Local Subnet\)/u,
  /RemoteAddress LocalSubnet/u,
  /bootstrapUsers/u,
  /credential_revision/u,
]) {
  assert.match(adapter, contract);
}
assert.doesNotMatch(adapter, /pg_ctl|registerService/u);

console.log("QuickHack Windows server provisioning CLI, adapter, and protected handoff contract verified.");
