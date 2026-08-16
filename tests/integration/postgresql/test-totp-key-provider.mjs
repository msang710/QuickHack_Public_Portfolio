import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { createTestServerSecretProtector } from "../../support/server-secret-protector-fixture.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-totp-key-provider-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
const TEST_PROTECTION_PREFIX = Buffer.from("QHTESTPROTECT1\0", "utf8");

function childDataDir(name) {
  return path.join(temporaryDatabase.directory, name);
}

async function keySnapshot(provider) {
  return provider.withKey((key) => Buffer.from(key));
}

async function protectForTest(secret) {
  const transformed = Buffer.alloc(secret.length);

  for (let index = 0; index < secret.length; index += 1) {
    transformed[index] = secret[index] ^ 0xa5;
  }

  return Buffer.concat([TEST_PROTECTION_PREFIX, transformed]);
}

async function unprotectForTest(payload) {
  const prefix = payload.subarray(0, TEST_PROTECTION_PREFIX.length);

  if (!prefix.equals(TEST_PROTECTION_PREFIX)) {
    throw new Error("The test protection payload prefix is invalid.");
  }

  const protectedSecret = payload.subarray(TEST_PROTECTION_PREFIX.length);
  const secret = Buffer.alloc(protectedSecret.length);

  for (let index = 0; index < protectedSecret.length; index += 1) {
    secret[index] = protectedSecret[index] ^ 0xa5;
  }

  return secret;
}

async function ensureTestDirectory(directoryPath) {
  mkdirSync(directoryPath, { recursive: true });
}

function createTestProvider(TotpKeyProvider, input = {}) {
  const {
    protect = protectForTest,
    unprotect = unprotectForTest,
    ensureDirectory = ensureTestDirectory,
    ...providerInput
  } = input;
  return new TotpKeyProvider({
    ...providerInput,
    secretProtector: createTestServerSecretProtector({
      transform: protect,
      restore: unprotect,
      ensureDirectory,
    }),
  });
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    TotpKeyProvider,
    defaultTotpKeyFilePath,
  } = await import("@/quickhack_server/security/totp-key-provider");

  const firstDataDir = childDataDir("first-use");
  const firstProvider = createTestProvider(TotpKeyProvider, {
    dataDir: firstDataDir,
    credentialCount: async () => 0,
  });
  assert.deepEqual(await firstProvider.getStatus(), {
    state: "READY",
    configured: true,
    protection: "WINDOWS_DPAPI_CURRENT_USER",
  });
  const firstKey = await keySnapshot(firstProvider);
  const firstKeyPath = defaultTotpKeyFilePath(firstDataDir);
  const firstFile = readFileSync(firstKeyPath, "utf8");
  assert.equal(firstKey.length, 32);
  assert.match(firstFile, /^QHTOTPKEY1\nDPAPI_CURRENT_USER\n/);
  assert.equal(firstFile.includes(firstKey.toString("base64")), false);
  assert.equal(firstFile.includes(firstKey.toString("hex")), false);

  const restartedProvider = createTestProvider(TotpKeyProvider, {
    dataDir: firstDataDir,
    credentialCount: async () => {
      throw new Error("An existing key must be read before querying credentials.");
    },
  });
  const restartedKey = await keySnapshot(restartedProvider);
  assert.equal(restartedKey.equals(firstKey), true);
  firstKey.fill(0);
  restartedKey.fill(0);

  const concurrentDataDir = childDataDir("concurrent-first-use");
  const concurrentProviders = Array.from(
    { length: 4 },
    () =>
      createTestProvider(TotpKeyProvider, {
        dataDir: concurrentDataDir,
        credentialCount: async () => 0,
      })
  );
  const concurrentKeys = await Promise.all(
    concurrentProviders.map((provider) => keySnapshot(provider))
  );
  assert.equal(
    concurrentKeys.every((key) => key.equals(concurrentKeys[0])),
    true,
    "Concurrent server requests published different OTP keys."
  );
  concurrentKeys.forEach((key) => key.fill(0));

  const guardedDataDir = childDataDir("existing-credentials");
  const guardedProvider = createTestProvider(TotpKeyProvider, {
    dataDir: guardedDataDir,
    credentialCount: async () => 1,
  });
  assert.deepEqual(await guardedProvider.getStatus(), {
    state: "CREDENTIALS_REQUIRE_EXISTING_KEY",
    configured: false,
    protection: null,
  });
  assert.equal(existsSync(defaultTotpKeyFilePath(guardedDataDir)), false);
  await assert.rejects(
    () => guardedProvider.withKey(() => undefined),
    (error) =>
      error?.status === 503 && error?.code === "TOTP_SERVICE_UNAVAILABLE"
  );

  const invalidDataDir = childDataDir("invalid-key-file");
  const invalidKeyPath = defaultTotpKeyFilePath(invalidDataDir);
  mkdirSync(path.dirname(invalidKeyPath), { recursive: true });
  writeFileSync(invalidKeyPath, "not-a-valid-key\n", "utf8");
  const invalidProvider = createTestProvider(TotpKeyProvider, {
    dataDir: invalidDataDir,
    credentialCount: async () => 0,
  });
  assert.equal((await invalidProvider.getStatus()).state, "INVALID_KEY_FILE");
  assert.equal(readFileSync(invalidKeyPath, "utf8"), "not-a-valid-key\n");

  const recoverableDataDir = childDataDir("recoverable-invalid-key");
  const recoverableKeyPath = defaultTotpKeyFilePath(recoverableDataDir);
  mkdirSync(path.dirname(recoverableKeyPath), { recursive: true });
  writeFileSync(recoverableKeyPath, "not-a-valid-key\n", "utf8");
  let remainingCredentialCount = 1;
  const recoverableProvider = createTestProvider(TotpKeyProvider, {
    dataDir: recoverableDataDir,
    credentialCount: async () => remainingCredentialCount,
  });
  assert.equal(
    (await recoverableProvider.getStatus()).state,
    "INVALID_KEY_FILE"
  );
  await assert.rejects(
    () => recoverableProvider.recoverAfterCredentialsCleared(),
    (error) => error?.code === "TOTP_CREDENTIALS_REMAIN"
  );
  assert.equal(
    readFileSync(recoverableKeyPath, "utf8"),
    "not-a-valid-key\n",
    "A key file was replaced while encrypted OTP credentials remained."
  );
  remainingCredentialCount = 0;
  assert.equal(
    (await recoverableProvider.recoverAfterCredentialsCleared()).state,
    "READY"
  );
  assert.match(
    readFileSync(recoverableKeyPath, "utf8"),
    /^QHTOTPKEY1\nDPAPI_CURRENT_USER\n/
  );
  assert.equal(
    readdirSync(path.dirname(recoverableKeyPath)).some((name) =>
      name.startsWith("master.key.unusable.")
    ),
    true,
    "The unusable key file was not quarantined before replacement."
  );

  const directoryFailureDataDir = childDataDir("directory-protection-failure");
  const directoryFailureProvider = createTestProvider(TotpKeyProvider, {
    dataDir: directoryFailureDataDir,
    credentialCount: async () => 0,
    ensureDirectory: async () => {
      throw new Error("simulated directory protection failure");
    },
  });
  assert.equal(
    (await directoryFailureProvider.getStatus()).state,
    "CREATE_FAILED"
  );
  assert.equal(
    existsSync(defaultTotpKeyFilePath(directoryFailureDataDir)),
    false,
    "A key file was published after directory protection failed."
  );

  const protectionFailureDataDir = childDataDir("key-protection-failure");
  const protectionFailureProvider = createTestProvider(TotpKeyProvider, {
    dataDir: protectionFailureDataDir,
    credentialCount: async () => 0,
    protect: async () => {
      throw new Error("simulated key protection failure");
    },
  });
  assert.equal(
    (await protectionFailureProvider.getStatus()).state,
    "CREATE_FAILED"
  );
  assert.equal(
    existsSync(defaultTotpKeyFilePath(protectionFailureDataDir)),
    false,
    "A key file was published after key protection failed."
  );

  const unprotectableDataDir = childDataDir("key-unprotection-failure");
  const unprotectableKeyPath = defaultTotpKeyFilePath(unprotectableDataDir);
  const unprotectableFile =
    `QHTOTPKEY1\nDPAPI_CURRENT_USER\n${Buffer.from("not-test-protected").toString("base64")}\n`;
  mkdirSync(path.dirname(unprotectableKeyPath), { recursive: true });
  writeFileSync(unprotectableKeyPath, unprotectableFile, "utf8");
  const unprotectableProvider = createTestProvider(TotpKeyProvider, {
    dataDir: unprotectableDataDir,
    credentialCount: async () => 0,
  });
  assert.equal(
    (await unprotectableProvider.getStatus()).state,
    "INVALID_KEY_FILE"
  );
  assert.equal(
    readFileSync(unprotectableKeyPath, "utf8"),
    unprotectableFile,
    "An unprotectable key file was overwritten during initialization."
  );

  const unsupportedProvider = new TotpKeyProvider({
    dataDir: childDataDir("unsupported"),
    credentialCount: async () => 0,
    secretProtector: createTestServerSecretProtector({
      state: "UNAVAILABLE",
    }),
  });
  assert.equal((await unsupportedProvider.getStatus()).state, "UNSUPPORTED_PLATFORM");

  const timestamp = new Date("2026-08-04T12:00:00+09:00");
  const unavailableUser = await prisma.users.create({
    data: {
      username: "totp-key-unavailable-user",
      password_hash: "not-used-by-this-test",
      role: "LEADER",
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const recoveryCode = "RECOVERY-CODE-1234";
  const recoveryCodeHash = crypto
    .createHash("sha256")
    .update(recoveryCode.replace(/[^A-Z0-9]/g, ""), "utf8")
    .digest("base64url");
  await prisma.user_totp_credentials.create({
    data: {
      user_id: unavailableUser.user_id,
      secret_ciphertext: "unavailable",
      secret_iv: "unavailable",
      secret_auth_tag: "unavailable",
      enabled: 1,
      verified_at: timestamp,
      failed_count: 0,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.user_totp_recovery_codes.create({
    data: {
      user_id: unavailableUser.user_id,
      code_hash: recoveryCodeHash,
      created_at: timestamp,
    },
  });

  const { verifyUserTotpCode } = await import(
    "@/quickhack_server/auth/totp-service"
  );
  await assert.rejects(
    () => verifyUserTotpCode(unavailableUser.user_id, recoveryCode),
    (error) =>
      error?.status === 503 && error?.code === "TOTP_SERVICE_UNAVAILABLE"
  );
  const unchangedRecoveryCode =
    await prisma.user_totp_recovery_codes.findUniqueOrThrow({
      where: { code_hash: recoveryCodeHash },
    });
  const unchangedCredential =
    await prisma.user_totp_credentials.findUniqueOrThrow({
      where: { user_id: unavailableUser.user_id },
    });
  assert.equal(unchangedRecoveryCode.used_at, null);
  assert.equal(unchangedCredential.failed_count, 0);
  assert.equal(unchangedCredential.locked_until, null);
  assert.equal(
    existsSync(defaultTotpKeyFilePath(temporaryDatabase.directory)),
    false,
    "A missing key was regenerated despite existing OTP credentials."
  );

  const repositoryFiles = [
    "quickhack_server/auth/totp-service.ts",
    "quickhack_server/api/admin/security-status.ts",
    "quickhack_server/api/developer/diagnostics.ts",
    "tools/server-console.mjs",
  ];
  assert.equal(existsSync(path.resolve(".env.example")), false);
  for (const fileName of repositoryFiles) {
    assert.equal(
      readFileSync(path.resolve(fileName), "utf8").includes(
        "QUICKHACK_TOTP_ENCRYPTION_KEY"
      ),
      false,
      `${fileName} still depends on the legacy OTP environment key.`
    );
  }

  console.log(
    "Server-owned OTP key creation, restart, concurrency, and fail-closed protection contracts verified."
  );
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
