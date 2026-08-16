import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPostgresqlPackageManifest } from "../../quickhack_shared/core/package-flavor-contract.mjs";
import { serverSecretFilePrefix } from "../../quickhack_server/platform/server-secret-file-format.mjs";
import {
  assertServerSecretIdentity,
  createServerSecretIdentityManifest,
  serverSecretIdentity,
} from "../../quickhack_server/platform/server-secret-identity.mjs";
import { createLinuxServiceCredentialReader } from "../../quickhack_server/platform/linux/service-credential-reader.mjs";
import { createLinuxServerSecretProtector } from "../../quickhack_server/platform/linux/server-secret-protector.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/linux-server-secret-cases.json", import.meta.url),
    "utf8"
  )
);
const database = {
  host: "127.0.0.1",
  port: 5432,
  name: "quickhack",
  runtimeUser: "quickhack_runtime",
  migratorUser: "quickhack_migrator",
};
const operational = { packageFlavor: "OPERATIONAL", database };
const demonstration = {
  packageFlavor: "DEMONSTRATION",
  database: {
    ...database,
    coupangMockName: "quickhack_mock_coupang",
    coupangMockUser: "quickhack_mock_coupang",
    logenMockName: "quickhack_mock_logen",
    logenMockUser: "quickhack_mock_logen",
  },
};

const operationalManifest = createServerSecretIdentityManifest(operational);
const demonstrationManifest = createServerSecretIdentityManifest(demonstration);
assert.deepEqual(operationalManifest.identities.slice(0, 4), fixture.common);
assert.deepEqual(
  operationalManifest.identities.filter((item) => item.kind === "POSTGRESQL_CREDENTIAL").map((item) => item.postgresqlRole),
  fixture.operationalPostgresqlRoles
);
assert.deepEqual(
  demonstrationManifest.identities.filter((item) => item.kind === "POSTGRESQL_CREDENTIAL").map((item) => item.postgresqlRole),
  fixture.demonstrationPostgresqlRoles
);
assert.deepEqual(
  demonstrationManifest.identities.filter((item) => item.kind === "POSTGRESQL_CREDENTIAL").map((item) => item.id),
  fixture.demonstrationPostgresqlIdentityIds
);
for (const identity of demonstrationManifest.identities) {
  assert.deepEqual(assertServerSecretIdentity(identity), identity);
}
assert.equal(
  new Set(demonstrationManifest.identities.map((item) => item.id)).size,
  demonstrationManifest.identities.length
);
assert.equal(
  operationalManifest.identities.some((item) => item.id === "quickhack.qhkey-master-key"),
  true
);
assert.equal(
  demonstrationManifest.identities.some((item) => item.id === "quickhack.qhkey-master-key"),
  true
);
assert.deepEqual(
  createPostgresqlPackageManifest(operational).databases.map((item) => item.kind),
  ["main"]
);
assert.deepEqual(
  createPostgresqlPackageManifest(demonstration).databases.map((item) => item.kind),
  ["main", "coupangMock", "logenMock"]
);
assert.throws(
  () =>
    serverSecretIdentity({
      kind: "POSTGRESQL_CREDENTIAL",
      runtimeConfig: operational,
      postgresqlRole: "coupangMock",
    }),
  (error) => error.code === "SERVER_SECRET_IDENTITY_NOT_IN_PACKAGE"
);
assert.throws(
  () =>
    assertServerSecretIdentity({
      ...fixture.common[0],
      id: "quickhack.otp-master-key.substituted",
    }),
  (error) => error.code === "SERVER_SECRET_IDENTITY_INVALID"
);
assert.equal(
  serverSecretFilePrefix("OTP_MASTER_KEY", {
    protection: "WINDOWS_DPAPI_CURRENT_USER",
  }),
  "QHTOTPKEY1\nDPAPI_CURRENT_USER\n"
);

const directory = mkdtempSync(path.join(os.tmpdir(), "quickhack-systemd-reader-"));
try {
  const identity = serverSecretIdentity({ kind: "BACKUP_MASTER_KEY" });
  const key = Buffer.alloc(32, 7);
  writeFileSync(path.join(directory, identity.id), key, { mode: 0o400 });
  const reader = createLinuxServiceCredentialReader({
    platform: "win32",
    environment: { CREDENTIALS_DIRECTORY: directory },
  });
  assert.equal((await reader.read(identity)).equals(key), true);
  assert.equal(reader.readSync(identity).equals(key), true);
  const protector = createLinuxServerSecretProtector({
    platform: "linux",
    reader,
  });
  assert.equal(protector.descriptor.state, "READY");
  assert.equal(protector.metadata.lifecycle, "ACTIVATION_CREDENTIAL");
  assert.equal((await protector.readProvisioned(identity)).equals(key), true);
  await assert.rejects(
    () => protector.protect("BACKUP_MASTER_KEY", key),
    (error) => error.code === "SERVER_SECRET_PRIVILEGED_PROVISIONING_REQUIRED"
  );
  await assert.rejects(
    () =>
      reader.read(
        serverSecretIdentity({ kind: "MOBILE_SERIAL_HMAC" })
      ),
    (error) =>
      error.code === "SERVER_SECRET_PROVISIONING_REQUIRED" &&
      !error.message.includes(directory)
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const fakeSymlinkReader = createLinuxServiceCredentialReader({
  environment: { CREDENTIALS_DIRECTORY: "/run/credentials/quickhack.service" },
  async lstat() {
    return { isFile: () => true, isSymbolicLink: () => true, size: 32 };
  },
  async readFile() {
    return Buffer.alloc(32);
  },
});
await assert.rejects(
  () => fakeSymlinkReader.read(serverSecretIdentity({ kind: "OTP_MASTER_KEY" })),
  (error) => error.code === "SERVER_SECRET_PROVISIONED_INVALID"
);
const insecureModeReader = createLinuxServiceCredentialReader({
  platform: "linux",
  environment: { CREDENTIALS_DIRECTORY: "/run/credentials/quickhack.service" },
  async lstat() {
    return {
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 32,
      mode: 0o100440,
    };
  },
  async readFile() {
    return Buffer.alloc(32, 1);
  },
});
await assert.rejects(
  () => insecureModeReader.read(serverSecretIdentity({ kind: "OTP_MASTER_KEY" })),
  (error) => error.code === "SERVER_SECRET_PROVISIONED_INVALID"
);

console.log("Linux server package flavor, exact secret identities, and activation reader verified.");
