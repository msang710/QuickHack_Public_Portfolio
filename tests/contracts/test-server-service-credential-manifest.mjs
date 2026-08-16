import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createServerServiceCredentialManifest, renderSystemdCredentialDirectives } from "../../tools/platform/linux/server-service-credential-manifest.mjs";

function runtimeConfig(packageFlavor) {
  return {
    packageFlavor,
    database: {
      name: "quickhack",
      migratorUser: "quickhack_migrator",
      runtimeUser: "quickhack_runtime",
      coupangMockName: "quickhack_mock_coupang",
      coupangMockUser: "quickhack_mock_coupang",
      logenMockName: "quickhack_mock_logen",
      logenMockUser: "quickhack_mock_logen",
    },
  };
}

const operational = createServerServiceCredentialManifest(runtimeConfig("OPERATIONAL"), "APPLICATION");
assert.equal(operational.credentials.length, 6);
assert.deepEqual(
  operational.credentials.filter((item) => item.identity.postgresqlRole).map((item) => item.identity.postgresqlRole).sort(),
  ["backup", "runtime"]
);
assert.equal(operational.credentials.some((item) => item.name.includes("mock")), false);

const demonstration = createServerServiceCredentialManifest(runtimeConfig("DEMONSTRATION"), "APPLICATION");
assert.equal(demonstration.credentials.length, 8);
assert.deepEqual(
  demonstration.credentials.filter((item) => item.identity.consumerClass === "DEMONSTRATION_MOCK").map((item) => item.identity.postgresqlRole).sort(),
  ["coupangMock", "logenMock"]
);
for (const consumer of ["MIGRATE", "INITIAL_LEADER"]) {
  const manifest = createServerServiceCredentialManifest(runtimeConfig("OPERATIONAL"), consumer);
  assert.deepEqual(manifest.credentials.map((item) => item.identity.postgresqlRole), ["migrator"]);
}
for (const consumer of ["INSTALL", "REPAIR", "RESTORE"]) {
  const manifest = createServerServiceCredentialManifest(runtimeConfig("OPERATIONAL"), consumer);
  assert.deepEqual(manifest.credentials.map((item) => item.identity.postgresqlRole), ["operator"]);
}
assert.equal(createServerServiceCredentialManifest(runtimeConfig("OPERATIONAL"), "QHKEY_PUBLISH").credentials.length, 0);
assert.doesNotMatch(renderSystemdCredentialDirectives(operational), /migrator|operator|plaintext/u);

const root = path.resolve(import.meta.dirname, "..", "..");
const migrateUnit = readFileSync(path.join(root, "packaging/linux/systemd/quickhack-migrate.service.in"), "utf8");
const operatorUnit = readFileSync(path.join(root, "packaging/linux/systemd/quickhack-operator@.service.in"), "utf8");
assert.match(migrateUnit, /Type=oneshot/);
assert.match(migrateUnit, /@QUICKHACK_MIGRATOR_CREDENTIAL_DIRECTIVES@/);
assert.match(operatorUnit, /run-one-shot --operation=%i/);
assert.doesNotMatch(`${migrateUnit}\n${operatorUnit}`, /Environment=.*(?:PASSWORD|SECRET|CREDENTIAL)/i);

console.log("Flavor-specific long-lived and one-shot systemd credential manifests verified.");
