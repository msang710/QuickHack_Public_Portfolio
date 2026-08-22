import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createPostgresqlPackageManifest,
  postgresqlRoleKindsForFlavor,
} from "../../quickhack_shared/core/package-flavor-contract.mjs";
import { validateServerRuntimeConfig } from "../../quickhack_shared/core/server-runtime-config.mjs";
import {
  QUICKHACK_ARTIFACT_KINDS,
  assertArtifactRuntimePair,
  packageArtifactContract,
} from "../../packaging/package-artifact-contract.mjs";

const common = {
  schemaVersion: 3,
  environment: "production",
  coupangWriteApiEnabled: true,
  logenWriteApiEnabled: true,
  dataDirectory: path.resolve(".tmp", "package-flavor-contract"),
  backupRetentionCount: 30,
  database: {
    host: "127.0.0.1",
    port: 5432,
    name: "quickhack",
    runtimeUser: "quickhack_runtime",
    migratorUser: "quickhack_migrator",
  },
};
const operational = validateServerRuntimeConfig({
  ...common,
  packageFlavor: "OPERATIONAL",
});
const demonstration = validateServerRuntimeConfig({
  ...common,
  packageFlavor: "DEMONSTRATION",
  database: {
    ...common.database,
    coupangMockName: "quickhack_mock_coupang",
    coupangMockUser: "quickhack_mock_coupang",
    logenMockName: "quickhack_mock_logen",
    logenMockUser: "quickhack_mock_logen",
  },
});

assert.deepEqual(postgresqlRoleKindsForFlavor("OPERATIONAL"), [
  "operator",
  "migrator",
  "runtime",
  "backup",
]);
assert.deepEqual(postgresqlRoleKindsForFlavor("DEMONSTRATION"), [
  "operator",
  "migrator",
  "runtime",
  "backup",
  "coupangMock",
  "logenMock",
]);
const operationalManifest = createPostgresqlPackageManifest(operational);
assert.equal(operationalManifest.roles.length, 4);
assert.equal(operationalManifest.databases.length, 1);
const demonstrationManifest = createPostgresqlPackageManifest(demonstration);
assert.equal(demonstrationManifest.roles.length, 6);
assert.equal(demonstrationManifest.databases.length, 3);
assert.equal(
  new Set(demonstrationManifest.roles.map((role) => role.user)).size,
  6,
  "Every demonstration PostgreSQL identity must use an independent login role."
);
assert.throws(
  () =>
    validateServerRuntimeConfig({
      ...common,
      packageFlavor: "OPERATIONAL",
      database: {
        ...common.database,
        coupangMockName: "quickhack_mock_coupang",
      },
    }),
  (error) => error.code === "SERVER_RUNTIME_CONFIG_INVALID"
);

assert.deepEqual([...QUICKHACK_ARTIFACT_KINDS], [
  "DEMONSTRATION_SERVER",
  "DEMONSTRATION_CLIENT",
  "OPERATIONAL_SERVER",
  "OPERATIONAL_CLIENT",
]);
for (const artifactKind of QUICKHACK_ARTIFACT_KINDS) {
  const artifact = packageArtifactContract(artifactKind);
  const config = artifact.packageFlavor === "OPERATIONAL"
    ? operational
    : demonstration;
  const paired = assertArtifactRuntimePair(artifactKind, config);
  assert.equal(paired.packageFlavor, config.packageFlavor);
  assert.equal(
    artifact.role === "client",
    !artifact.includesPrivilegedCredentialOperator
  );
  if (artifact.role === "server") {
    const identityIds = paired.serverSecrets.identities.map((identity) => identity.id);
    assert.equal(
      identityIds.filter((identityId) => identityId === "quickhack.qhkey-master-key").length,
      1
    );
    for (const commonIdentity of [
      "quickhack.otp-master-key",
      "quickhack.backup-master-key",
      "quickhack.mobile-serial-hmac",
      "quickhack.qhkey-master-key",
    ]) {
      assert(identityIds.includes(commonIdentity));
    }
    assert.equal(
      identityIds.includes("quickhack.postgresql.coupang-mock"),
      artifact.packageFlavor === "DEMONSTRATION"
    );
    assert.equal(
      identityIds.includes("quickhack.postgresql.logen-mock"),
      artifact.packageFlavor === "DEMONSTRATION"
    );
  }
}
assert.throws(
  () => assertArtifactRuntimePair("OPERATIONAL_SERVER", demonstration),
  /does not match/u
);

const installerCore = readFileSync(
  new URL("../../tools/postgresql-service-core.mjs", import.meta.url),
  "utf8"
);
const installerAdapters = [
  "../../tools/platform/windows/postgresql-service-install.mjs",
  "../../tools/platform/linux/postgresql-service-install.mjs",
].map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8"));
const installer = installerAdapters.join("\n");
assert.match(installerCore, /createPostgresqlPackageManifest\(input\.runtimeConfig\)/u);
for (const adapter of installerAdapters) {
  assert.match(adapter, /manifest\.roles\.filter/u);
  assert.match(adapter, /manifest\.flavor === "OPERATIONAL"/u);
  assert.match(adapter, /GRANT CONNECT ON DATABASE/u);
  assert.match(adapter, /role\.kind === "migrator"/u);
  assert.equal(adapter.match(/GRANT CONNECT, CREATE ON DATABASE/gu)?.length, 1);
  assert.ok(
    adapter.indexOf("REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE") <
      adapter.indexOf("GRANT CONNECT, CREATE ON DATABASE"),
    "The migrator database grant must restore privileges after the role-wide revoke."
  );
}
assert.doesNotMatch(
  installer,
  /\[config\.database\.coupangMockName,\s*runtimeUser\]/u,
  "Mock databases must never reuse the main runtime login role."
);

console.log("Four artifact kinds and flavor-specific PostgreSQL manifests are fixed and isolated.");
