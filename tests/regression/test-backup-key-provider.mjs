import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BACKUP_KEY_BYTES,
  createBackupKeyProvider,
} from "../../quickhack_server/security/backup-key-provider-core.mjs";
import { createTestServerSecretProtector } from "../support/server-secret-protector-fixture.mjs";

const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "quickhack-backup-key-provider-")
);

function testProtection(identity) {
  const prefix = Buffer.from(`TEST-DPAPI:${identity}:`, "utf8");

  return {
    transform(secret) {
      return Buffer.concat([prefix, secret]);
    },
    restore(payload) {
      if (
        payload.length <= prefix.length ||
        !payload.subarray(0, prefix.length).equals(prefix)
      ) {
        throw new Error("wrong test identity");
      }
      return Buffer.from(payload.subarray(prefix.length));
    },
  };
}

function providerFor(name, options = {}) {
  const dataDir = path.join(root, name, "data");
  const backupDirectory = path.join(dataDir, "backups");
  const protection = testProtection(options.identity ?? "operator");

  return {
    dataDir,
    backupDirectory,
    provider: createBackupKeyProvider({
      dataDir,
      backupDirectory,
      randomBytes: options.randomBytes,
      secretProtector:
        options.secretProtector ??
        createTestServerSecretProtector({
          state: options.state,
          transform: protection.transform,
          restore: protection.restore,
          ensureDirectory:
            options.ensureDirectory ??
            ((directoryPath) => fs.mkdir(directoryPath, { recursive: true })),
        }),
    }),
  };
}

try {
  let randomCallCount = 0;
  const normal = providerFor("normal", {
    randomBytes(size) {
      randomCallCount += 1;
      return Buffer.alloc(size, 0x41);
    },
  });
  const concurrentStatuses = await Promise.all([
    normal.provider.getStatus(),
    normal.provider.getStatus(),
    normal.provider.getStatus(),
  ]);
  assert.equal(randomCallCount, 1);
  assert.deepEqual(
    concurrentStatuses.map((item) => item.state),
    ["READY", "READY", "READY"]
  );
  assert.equal(concurrentStatuses[0].protection, "WINDOWS_DPAPI_CURRENT_USER");
  assert.equal(concurrentStatuses[0].encryptedBackupCount, 0);

  let retainedCallbackKey;
  const firstKeyHex = await normal.provider.withKey((key) => {
    retainedCallbackKey = key;
    return key.toString("hex");
  });
  assert.equal(firstKeyHex, Buffer.alloc(BACKUP_KEY_BYTES, 0x41).toString("hex"));
  assert(retainedCallbackKey.every((value) => value === 0));
  assert.equal(
    await normal.provider.withKey((key) => key.toString("hex")),
    firstKeyHex
  );

  const crossProcessName = "cross-provider-race";
  let raceSequence = 0;
  const firstRace = providerFor(crossProcessName, {
    randomBytes(size) {
      raceSequence += 1;
      return Buffer.alloc(size, 0x50 + raceSequence);
    },
  });
  const secondRace = providerFor(crossProcessName, {
    randomBytes(size) {
      raceSequence += 1;
      return Buffer.alloc(size, 0x50 + raceSequence);
    },
  });
  const [firstRaceStatus, secondRaceStatus] = await Promise.all([
    firstRace.provider.getStatus(),
    secondRace.provider.getStatus(),
  ]);
  assert.equal(firstRaceStatus.state, "READY");
  assert.equal(secondRaceStatus.state, "READY");
  const [firstPublishedKey, secondPublishedKey] = await Promise.all([
    firstRace.provider.withKey((key) => key.toString("hex")),
    secondRace.provider.withKey((key) => key.toString("hex")),
  ]);
  assert.equal(firstPublishedKey, secondPublishedKey);

  let collisionRandomCalls = 0;
  const collision = providerFor("existing-backup", {
    randomBytes(size) {
      collisionRandomCalls += 1;
      return Buffer.alloc(size, 0x61);
    },
  });
  await fs.mkdir(collision.backupDirectory, { recursive: true });
  await fs.writeFile(
    path.join(collision.backupDirectory, "quickhack_backup_20260805_010101.qhb"),
    "existing-encrypted-backup"
  );
  const collisionStatus = await collision.provider.getStatus();
  assert.equal(
    collisionStatus.state,
    "ENCRYPTED_BACKUPS_REQUIRE_EXISTING_KEY"
  );
  assert.equal(collisionStatus.encryptedBackupCount, 1);
  assert.equal(collisionRandomCalls, 0);
  await assert.rejects(
    () => collision.provider.withKey(() => undefined),
    (error) => error?.code === "ENCRYPTED_BACKUPS_REQUIRE_EXISTING_KEY"
  );

  const invalid = providerFor("invalid-file");
  await fs.mkdir(path.dirname(invalid.provider.keyFilePath()), {
    recursive: true,
  });
  await fs.writeFile(invalid.provider.keyFilePath(), "not-a-backup-key\n");
  assert.equal((await invalid.provider.getStatus()).state, "INVALID_KEY_FILE");

  const identityOwner = providerFor("wrong-identity", { identity: "owner" });
  assert.equal((await identityOwner.provider.getStatus()).state, "READY");
  const wrongIdentityProtection = testProtection("different-user");
  const wrongIdentity = createBackupKeyProvider({
    dataDir: identityOwner.dataDir,
    backupDirectory: identityOwner.backupDirectory,
    secretProtector: createTestServerSecretProtector({
      transform: wrongIdentityProtection.transform,
      restore: wrongIdentityProtection.restore,
      ensureDirectory: (directoryPath) =>
        fs.mkdir(directoryPath, { recursive: true }),
    }),
  });
  assert.equal(
    (await wrongIdentity.getStatus()).state,
    "INVALID_KEY_FILE"
  );

  const unsupported = providerFor("unsupported", { state: "UNAVAILABLE" });
  assert.equal(
    (await unsupported.provider.getStatus()).state,
    "UNSUPPORTED_PLATFORM"
  );

  const createFailure = providerFor("create-failure", {
    ensureDirectory: async () => {
      throw new Error("ACL failure");
    },
  });
  assert.equal((await createFailure.provider.getStatus()).state, "CREATE_FAILED");

  console.log(
    "Backup key provider creation, concurrency, collision, identity, fail-closed, and key lifetime checks passed."
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
