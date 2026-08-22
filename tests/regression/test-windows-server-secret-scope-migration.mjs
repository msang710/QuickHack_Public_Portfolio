import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serverSecretFilePrefix } from "../../quickhack_server/platform/server-secret-file-format.mjs";
import {
  inspectWindowsServerSecretScopes,
  migrateWindowsServerSecretScope,
} from "../../tools/platform/windows/server-secret-scope-migration.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "quickhack-secret-scope-migration-"));
const dataDir = path.join(temporary, "data");
const credentialPath = path.join(dataDir, "security", "postgresql-runtime.credential");
await fs.mkdir(path.dirname(credentialPath), { recursive: true });

function protector(label, mask) {
  const metadata = {
    protection: `WINDOWS_DPAPI_${label}`,
    identityScope: label === "CURRENT_USER" ? "CURRENT_WINDOWS_USER" : "LOCAL_WINDOWS_MACHINE",
    portable: false,
    formatVersion: 1,
    lifecycle: "OPAQUE_PAYLOAD",
  };
  return {
    metadata,
    async protect(_kind, value) { return Buffer.from(value.map((byte) => byte ^ mask)); },
    async unprotect(_kind, value) { return Buffer.from(value.map((byte) => byte ^ mask)); },
    async ensureDirectory(directory) { await fs.mkdir(directory, { recursive: true }); },
  };
}
const currentUser = protector("CURRENT_USER", 0x31);
const localMachine = protector("LOCAL_MACHINE", 0x52);
const plaintext = Buffer.from("fixture-password", "utf8");
const legacyPayload = await currentUser.protect("POSTGRESQL_CREDENTIAL", plaintext);
await fs.writeFile(
  credentialPath,
  `${serverSecretFilePrefix("POSTGRESQL_CREDENTIAL", currentUser.metadata)}${legacyPayload.toString("base64")}\n`,
  { encoding: "utf8", mode: 0o600 }
);
plaintext.fill(0);
legacyPayload.fill(0);

const before = await inspectWindowsServerSecretScopes({
  dataDir,
  sourceProtector: currentUser,
  targetProtector: localMachine,
});
assert.equal(before[0].scope, "CURRENT_USER");
const migrated = await migrateWindowsServerSecretScope({
  dataDir,
  sourceProtector: currentUser,
  targetProtector: localMachine,
});
assert.equal(migrated.migrated.length, 1);
assert.match(await fs.readFile(credentialPath, "utf8"), /^QHPG1\nDPAPI_LOCAL_MACHINE\n/u);
const idempotent = await migrateWindowsServerSecretScope({
  dataDir,
  sourceProtector: currentUser,
  targetProtector: localMachine,
});
assert.equal(idempotent.migrated.length, 0);

await fs.writeFile(path.join(dataDir, "security", "backup-master.key"), "QHBKEY1\nUNKNOWN\nAAAA\n");
await assert.rejects(
  () => inspectWindowsServerSecretScopes({
    dataDir,
    sourceProtector: currentUser,
    targetProtector: localMachine,
  }),
  (error) => error.code === "LEGACY_CREDENTIAL_FORMAT_INVALID"
);

await fs.rm(temporary, { recursive: true, force: true });
console.log("Windows legacy CURRENT_USER credentials are atomically reprotected for LOCAL_MACHINE.");
