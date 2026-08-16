import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBackupMasterRecoveryEnvelope,
  openBackupMasterRecoveryEnvelope,
} from "../../quickhack_server/security/backup-master-recovery-envelope.mjs";
import {
  exportBackupMasterRecoveryBundle,
  importBackupMasterRecoveryBundle,
} from "../../tools/backup-master-recovery.mjs";

const key = Buffer.alloc(32, 0x5a);
const passphrase = "correct horse battery staple";
const envelope = createBackupMasterRecoveryEnvelope(key, passphrase, {
  randomBytes(size) {
    return Buffer.alloc(size, size);
  },
  scrypt: { N: 16_384, r: 8, p: 1 },
});
assert.match(
  envelope.toString("utf8"),
  /^QUICKHACK_BACKUP_MASTER_RECOVERY_V1\n/u
);
const restored = openBackupMasterRecoveryEnvelope(envelope, passphrase);
assert.equal(restored.equals(key), true);
restored.fill(0);
assert.throws(
  () => openBackupMasterRecoveryEnvelope(envelope, "incorrect passphrase"),
  (error) => error.code === "BACKUP_RECOVERY_AUTHENTICATION_FAILED"
);
const tampered = Buffer.from(envelope);
tampered[tampered.length - 10] ^= 1;
assert.throws(
  () => openBackupMasterRecoveryEnvelope(tampered, passphrase),
  (error) =>
    error.code === "BACKUP_RECOVERY_AUTHENTICATION_FAILED" ||
    error.code === "BACKUP_RECOVERY_ENVELOPE_INVALID"
);
assert.throws(
  () =>
    createBackupMasterRecoveryEnvelope(key, passphrase, {
      scrypt: { N: 1024, r: 8, p: 1 },
    }),
  (error) => error.code === "BACKUP_RECOVERY_KDF_INVALID"
);
const directory = mkdtempSync(path.join(os.tmpdir(), "quickhack-recovery-"));
try {
  const destinationPath = path.join(directory, "backup-master-recovery.qhr");
  const sourceProvider = {
    async withKey(operation) {
      return operation(Buffer.from(key));
    },
  };
  assert.deepEqual(
    await exportBackupMasterRecoveryBundle({
      sourceProvider,
      passphrase,
      destinationPath,
      scrypt: { N: 16_384, r: 8, p: 1 },
    }),
    { state: "RECOVERY_BUNDLE_CREATED", destinationPath }
  );
  await assert.rejects(
    () =>
      exportBackupMasterRecoveryBundle({
        sourceProvider,
        passphrase,
        destinationPath,
        scrypt: { N: 16_384, r: 8, p: 1 },
      }),
    (error) => error.code === "BACKUP_RECOVERY_DESTINATION_EXISTS"
  );
  let imported = null;
  assert.deepEqual(
    await importBackupMasterRecoveryBundle({
      sourcePath: destinationPath,
      passphrase,
      operator: {
        async provision(value) {
          imported = Buffer.from(value);
          return { state: "ACTIVE" };
        },
      },
    }),
    { state: "ACTIVE" }
  );
  assert.equal(imported.equals(key), true);
  imported.fill(0);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
key.fill(0);
envelope.fill(0);
tampered.fill(0);
console.log("Backup master recovery envelope roundtrip, authentication, and KDF bounds verified.");
