import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "quickhack-qhkey-single-pass-")
);
const qhkeyRoot = path.join(temporaryDirectory, "qhkey");
const qhkeyFile = path.join(qhkeyRoot, "quickhack-keys", "coupang.qhkey");
const masterKeyFile = path.join(temporaryDirectory, "security", "qhkey-master.key");
const runtimeConfigPath = path.join(temporaryDirectory, "server-runtime.json");

process.env.NODE_ENV = "test";
fs.writeFileSync(
  runtimeConfigPath,
  `${JSON.stringify(
    {
      schemaVersion: 3,
      packageFlavor: "DEMONSTRATION",
      environment: "development",
      coupangWriteApiEnabled: true,
      logenWriteApiEnabled: true,
      dataDirectory: temporaryDirectory,
      backupRetentionCount: 30,
      database: {
        host: "127.0.0.1",
        port: 5432,
        name: "quickhack",
        runtimeUser: "quickhack_runtime",
        migratorUser: "quickhack_migrator",
        coupangMockName: "quickhack_mock_coupang",
        coupangMockUser: "quickhack_mock_coupang",
        logenMockName: "quickhack_mock_logen",
        logenMockUser: "quickhack_mock_logen",
      },
    },
    null,
    2
  )}\n`,
  "utf8"
);
process.argv.push("--runtime-config", runtimeConfigPath);

const {
  createEncryptedQhkey,
  writeQhkeyFile,
} = await import("@/quickhack_server/security/qhkey");
const {
  readQhkeyMasterKeyFile,
  writeQhkeyMasterKeyFile,
} = await import("@/quickhack_server/security/qhkey-master-key-provider.mjs");
const { openCoupangRequestAuthSession } = await import(
  "@/quickhack_server/security/channel-auth"
);
const {
  clearQhkeyCredentialStateCacheForTest,
  getCoupangUsbQhkeyCredentialStatus,
} = await import(
  "@/quickhack_server/security/usb-qhkey-provider"
);
const { runOperationTrace } = await import(
  "@/quickhack_server/observability/operation-trace"
);

function assertSinglePass(snapshot, label) {
  assert(snapshot, `${label} trace snapshot was not produced.`);
  assert.equal(
    snapshot.spans.QHKEY_ROOT_VALIDATE?.count,
    1,
    `${label} repeated the QHKey root validation.`
  );
  assert.equal(
    snapshot.spans.QHKEY_METADATA_VALIDATE?.count,
    1,
    `${label} repeated the QHKey metadata validation.`
  );
  assert.equal(
    snapshot.spans.QHKEY_MASTER_KEY_VALIDATE?.count,
    1,
    `${label} repeated the QHKey master key validation.`
  );
  assert.equal(
    snapshot.spans.QHKEY_MASTER_KEY_OPEN?.count,
    1,
    `${label} reopened the QHKey master key.`
  );
  assert.equal(
    snapshot.spans.QHKEY_PAYLOAD_DECRYPT?.count,
    1,
    `${label} decrypted the QHKey payload more than once.`
  );
}

try {
  fs.mkdirSync(path.dirname(qhkeyFile), { recursive: true });
  fs.mkdirSync(path.dirname(masterKeyFile), { recursive: true });
  writeQhkeyMasterKeyFile(masterKeyFile, false, { protection: "RAW" });
  const masterKey = readQhkeyMasterKeyFile(masterKeyFile);

  try {
    const encryptedQhkey = createEncryptedQhkey({
      credentialKind: "COUPANG_OPEN_API",
      environment: "mock",
      keyAlias: "single-pass-test",
      credential: {
        vendorId: "TEST-VENDOR",
        accessKey: "TEST-ACCESS-KEY",
        secretKey: "TEST-SECRET-KEY",
      },
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2036-01-01T00:00:00.000Z",
      masterKey,
    });
    writeQhkeyFile(qhkeyFile, encryptedQhkey.buffer, false);
  } finally {
    masterKey.fill(0);
  }

  let sessionTrace = null;
  const session = await runOperationTrace(
    {
      operationName: "test.qhkey.single-pass.session",
      persist: false,
      onComplete(snapshot) {
        sessionTrace = snapshot;
      },
    },
    async () => {
      const openedSession = await openCoupangRequestAuthSession();

      openedSession.sign({
        method: "GET",
        path: "/v2/providers/openapi/apis/api/v4/vendors/TEST/ordersheets",
        query: "status=ACCEPT",
        operationType: "READ",
      });
      assert.throws(
        () =>
          openedSession.sign({
            method: "POST",
            path: "/v2/providers/openapi/apis/api/v4/vendors/TEST/ordersheets/acknowledgement",
            query: "",
            operationType: "WRITE",
          }),
        /force-fresh credential session/
      );

      return openedSession;
    }
  );

  assertSinglePass(sessionTrace, "Credential session");
  assert.equal(session.context.vendorId, "TEST-VENDOR");
  assert.equal(session.context.keyAlias, "single-pass-test");
  assert.equal(session.context.readEnabled, true);
  assert.equal(session.context.writeEnabled, true);
  assert.equal(session.freshness, "CACHED_READ");

  const writeSession = await openCoupangRequestAuthSession(
    "FORCE_FRESH_WRITE"
  );
  const writeSignature = writeSession.sign({
    method: "POST",
    path: "/v2/providers/openapi/apis/api/v4/vendors/TEST/ordersheets/acknowledgement",
    query: "",
    operationType: "WRITE",
  });
  assert.equal(writeSession.freshness, "FORCE_FRESH_WRITE");
  assert.match(writeSignature.authorization, /^CEA algorithm=HmacSHA256,/);

  clearQhkeyCredentialStateCacheForTest();
  let statusTrace = null;
  const status = await runOperationTrace(
    {
      operationName: "test.qhkey.single-pass.status",
      persist: false,
      onComplete(snapshot) {
        statusTrace = snapshot;
      },
    },
    () => getCoupangUsbQhkeyCredentialStatus()
  );

  assertSinglePass(statusTrace, "Credential status");
  assert(["ACTIVE", "WARNING"].includes(status.status));
  assert.equal(status.keyAlias, "single-pass-test");
  assert.equal(status.keyFingerprint, session.context.keyFingerprint);

  fs.rmSync(masterKeyFile, { force: true });
  const missingMasterKeyStatus =
    await getCoupangUsbQhkeyCredentialStatus();

  assert.equal(missingMasterKeyStatus.status, "MISSING");
  assert.match(
    missingMasterKeyStatus.errorMessage ?? "",
    /QHKEY master key file was not found/
  );

  const logenQhkey = createEncryptedQhkey({
    masterKey: Buffer.alloc(32, 0x55),
    credentialKind: "LOGEN_OPEN_API",
    environment: "mock",
    keyAlias: "wrong-provider-test",
    credential: {
      userId: "LOGEN-USER",
      customerCode: "LOGEN-CUSTOMER",
      secretKey: "LOGEN-SECRET",
    },
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2036-01-01T00:00:00.000Z",
  });
  writeQhkeyFile(qhkeyFile, logenQhkey.buffer, true);
  clearQhkeyCredentialStateCacheForTest();

  let wrongProviderTrace = null;
  const wrongProviderStatus = await runOperationTrace(
    {
      operationName: "test.qhkey.wrong-provider",
      persist: false,
      onComplete(snapshot) {
        wrongProviderTrace = snapshot;
      },
    },
    () => getCoupangUsbQhkeyCredentialStatus()
  );
  assert.equal(wrongProviderStatus.status, "DISABLED");
  assert.equal(
    wrongProviderStatus.errorMessage,
    "QHKEY_CREDENTIAL_KIND_MISMATCH"
  );
  assert.equal(wrongProviderTrace?.spans.QHKEY_MASTER_KEY_OPEN, undefined);
  assert.equal(wrongProviderTrace?.spans.QHKEY_PAYLOAD_DECRYPT, undefined);

  console.log("QHKey single-pass credential loading checks passed.");
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
