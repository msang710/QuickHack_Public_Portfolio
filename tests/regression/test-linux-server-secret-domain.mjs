import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBackupKeyProvider } from "../../quickhack_server/security/backup-key-provider-core.mjs";
import { TotpKeyProvider } from "../../quickhack_server/security/totp-key-provider.ts";
import { MobileSerialHmacKeyProvider } from "../../quickhack_server/security/mobile-serial-hmac-key-provider.ts";
import { resolvePostgresqlConnectionStringSync } from "../../quickhack_server/core/database/postgresql-credential.mjs";
import { createTestServerSecretProtector } from "../support/server-secret-protector-fixture.mjs";

function missingCredential() {
  const error = new Error("fixture credential missing");
  error.code = "SERVER_SECRET_PROVISIONING_REQUIRED";
  throw error;
}

const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-linux-domain-"));
try {
  const dataDir = path.join(root, "data");
  const backupDirectory = path.join(root, "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const key = Buffer.alloc(32, 3);
  const observedIdentities = [];
  const activationProtector = createTestServerSecretProtector({
    platform: "linux",
    ownerStage: "PR-06",
    protection: "SYSTEMD_CREDENTIAL_ENCRYPTED",
    lifecycle: "ACTIVATION_CREDENTIAL",
    async readProvisioned(identity) {
      observedIdentities.push(identity.id);
      return Buffer.from(key);
    },
    readProvisionedSync(identity) {
      observedIdentities.push(identity.id);
      return Buffer.from("role-password", "utf8");
    },
    async ensureDirectory() {
      throw new Error("activation provider must not create a directory");
    },
    transform() {
      throw new Error("activation provider must not protect a payload");
    },
  });

  const backup = createBackupKeyProvider({
    dataDir,
    backupDirectory,
    secretProtector: activationProtector,
    randomBytes() {
      throw new Error("activation provider must not generate a key");
    },
  });
  assert.equal((await backup.getStatus()).state, "READY");
  assert.equal(await backup.withKey((value) => value.equals(key)), true);

  const totp = new TotpKeyProvider({
    dataDir,
    credentialCount: async () => 0,
    secretProtector: activationProtector,
    randomBytes() {
      throw new Error("activation provider must not generate a key");
    },
  });
  assert.equal((await totp.getStatus()).state, "READY");
  assert.equal(await totp.withKey((value) => value.equals(key)), true);

  const mobile = new MobileSerialHmacKeyProvider({
    dataDir,
    production: true,
    liveRegistrationCount: async () => 0,
    secretProtector: activationProtector,
    randomBytes() {
      throw new Error("activation provider must not generate a key");
    },
  });
  assert.equal(await mobile.withKey((value) => value.equals(key)), true);

  const missingProtector = createTestServerSecretProtector({
    platform: "linux",
    protection: "SYSTEMD_CREDENTIAL_ENCRYPTED",
    lifecycle: "ACTIVATION_CREDENTIAL",
    readProvisioned: missingCredential,
    readProvisionedSync: missingCredential,
  });
  const missingBackup = createBackupKeyProvider({
    dataDir: path.join(root, "missing-data"),
    backupDirectory: path.join(root, "missing-backups"),
    secretProtector: missingProtector,
  });
  assert.equal((await missingBackup.getStatus()).state, "PROVISIONING_REQUIRED");
  const existingBackupDirectory = path.join(root, "existing-backups");
  mkdirSync(existingBackupDirectory, { recursive: true });
  writeFileSync(path.join(existingBackupDirectory, "existing.qhb"), "fixture");
  const recoveryRequired = createBackupKeyProvider({
    dataDir: path.join(root, "recovery-data"),
    backupDirectory: existingBackupDirectory,
    secretProtector: missingProtector,
  });
  assert.equal((await recoveryRequired.getStatus()).state, "RECOVERY_BUNDLE_REQUIRED");
  const missingTotp = new TotpKeyProvider({
    dataDir: path.join(root, "missing-totp"),
    credentialCount: async () => 0,
    secretProtector: missingProtector,
  });
  assert.equal((await missingTotp.getStatus()).state, "PROVISIONING_REQUIRED");
  const dependentTotp = new TotpKeyProvider({
    dataDir: path.join(root, "dependent-totp"),
    credentialCount: async () => 2,
    secretProtector: missingProtector,
  });
  assert.equal(
    (await dependentTotp.getStatus()).state,
    "CREDENTIALS_REQUIRE_EXISTING_KEY"
  );

  const operationalConfigPath = path.join(root, "operational.json");
  writeFileSync(
    operationalConfigPath,
    JSON.stringify({
      schemaVersion: 3,
      packageFlavor: "OPERATIONAL",
      environment: "production",
      coupangWriteApiEnabled: true,
      logenWriteApiEnabled: true,
      dataDirectory: dataDir,
      backupRetentionCount: 30,
      database: {
        host: "127.0.0.1",
        port: 5432,
        name: "quickhack",
        runtimeUser: "quickhack_runtime",
        migratorUser: "quickhack_migrator"
      }
    })
  );
  const runtimeUrl = new URL(
    resolvePostgresqlConnectionStringSync({
      role: "runtime",
      runtimeConfigPath: operationalConfigPath,
      secretProtector: activationProtector,
      env: { NODE_ENV: "production" },
    })
  );
  assert.equal(runtimeUrl.username, "quickhack_runtime");
  assert.equal(runtimeUrl.password, "role-password");
  assert.throws(
    () =>
      resolvePostgresqlConnectionStringSync({
        role: "coupangMock",
        runtimeConfigPath: operationalConfigPath,
        secretProtector: activationProtector,
        env: { NODE_ENV: "production" },
      }),
    (error) => error.code === "POSTGRESQL_ROLE_FLAVOR_MISMATCH"
  );

  assert.ok(observedIdentities.includes("quickhack.backup-master-key"));
  assert.ok(observedIdentities.includes("quickhack.otp-master-key"));
  assert.ok(observedIdentities.includes("quickhack.mobile-serial-hmac"));
  assert.ok(observedIdentities.includes("quickhack.postgresql.runtime"));
  assert.equal(
    [
      path.join(dataDir, "security", "backup-master.key"),
      path.join(dataDir, "security", "totp", "master.key"),
      path.join(dataDir, "security", "mobile-device", "serial-hmac.key"),
    ].some((filePath) => existsSync(filePath)),
    false,
    "Activation lifecycle must not leave app-owned key files."
  );
  key.fill(0);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Linux activation credentials are consumed by exact domain identities without app key generation.");
