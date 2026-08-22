import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";
import { openPostgresqlTestDatabase } from "../../support/postgresql-database.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-logen-qhkey-session-"
);
const temporaryDirectory = temporaryDatabase.directory;
const runtimeConfigPath = path.join(temporaryDirectory, "server-runtime.json");
const qhkeyFile = path.join(
  temporaryDirectory,
  "qhkey",
  "quickhack-keys",
  "logen.qhkey"
);
const masterKeyFile = path.join(
  temporaryDirectory,
  "security",
  "qhkey-master.key"
);
const originalCredentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
if (process.platform === "linux") {
  const credentialDirectory = path.join(temporaryDirectory, "credentials");
  fs.mkdirSync(credentialDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(credentialDirectory, "quickhack.qhkey-master-key"),
    Buffer.alloc(32, 0x5a),
    { mode: 0o600 }
  );
  process.env.CREDENTIALS_DIRECTORY = credentialDirectory;
}
const originalFetch = globalThis.fetch;

function writeRuntimeConfig(environment) {
  fs.writeFileSync(
    runtimeConfigPath,
    `${JSON.stringify(
      {
        schemaVersion: 3,
        packageFlavor: "DEMONSTRATION",
        environment,
        coupangWriteApiEnabled: true,
        logenWriteApiEnabled: true,
        dataDirectory: temporaryDirectory,
        backupRetentionCount: 30,
        database: {
          host: "127.0.0.1",
          port: 5432,
          name: "quickhack_test",
          runtimeUser: "quickhack_test_runtime",
          migratorUser: "quickhack_test_migrator",
          coupangMockName: "quickhack_test_coupang",
          coupangMockUser: "quickhack_test_coupang",
          logenMockName: "quickhack_test_logen",
          logenMockUser: "quickhack_test_logen",
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

writeRuntimeConfig("development");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
process.env.LOGEN_API_MODE = "mock";
process.env.LOGEN_LIVE_WRITE_ENABLED = "false";
process.env.QUICKHACK_LOGEN_QHKEY_FILE = "C:\\attacker\\logen.qhkey";
process.env.QUICKHACK_QHKEY_MASTER_KEY_FILE = "C:\\attacker\\master.key";

const database = openPostgresqlTestDatabase(temporaryDatabase.databaseUrl);
try {
  await database
    .prepare(
      `INSERT INTO carrier_integration_settings (
         carrier_code, sender_name, sender_tel, sender_address_1,
         sender_address_2, default_box_type_code, revision
       ) VALUES ('LOGEN', 'QuickHack', '0200000000', '서울시 테스트로 1',
                 '물류센터', 'AS080', 1)`
    )
    .run();
} finally {
  await database.close();
}

const {
  createEncryptedQhkey,
  writeQhkeyFile,
} = await import("@/quickhack_server/security/qhkey");
const {
  readQhkeyMasterKeyFile,
  writeQhkeyMasterKeyFile,
} = await import("@/quickhack_server/security/qhkey-master-key-provider.mjs");
const {
  clearLogenQhkeyCredentialStateCacheForTest,
  getLogenCredentialStatus,
  getLogenRuntimeCredentials,
} = await import("@/quickhack_server/security/logen-usb-qhkey-provider");
const {
  assertLogenPreparedCredentialMatchesWriteSession,
  assertLogenSessionForOperation,
  openLogenRequestCredentialSession,
} = await import(
  "@/quickhack_server/shipment/carrier-integration/logen/credential-session"
);
const { logenCarrierClient } = await import(
  "@/quickhack_server/shipment/carrier-integration/logen/api-client"
);
const { prisma } = await import("@/quickhack_server/core/prisma");
const { runtimeConfigService } = await import(
  "@/quickhack_shared/core/runtime"
);
const originalRuntimeRead = runtimeConfigService.read.bind(runtimeConfigService);
runtimeConfigService.read = (...args) => {
  const runtime = originalRuntimeRead(...args);
  return {
    ...runtime,
    endpoints: {
      ...runtime.endpoints,
      logen: { ...runtime.endpoints.logen, mode: "live" },
    },
  };
};

function writeLogenCredential({ alias, userId, customerCode, secretKey }, replace) {
  const masterKey = readQhkeyMasterKeyFile(masterKeyFile);
  try {
    const encrypted = createEncryptedQhkey({
      masterKey,
      credentialKind: "LOGEN_OPEN_API",
      environment: "live",
      keyAlias: alias,
      credential: { userId, customerCode, secretKey },
      issuedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2028-01-01T00:00:00.000Z",
    });
    writeQhkeyFile(qhkeyFile, encrypted.buffer, replace);
    return encrypted.metadata;
  } finally {
    masterKey.fill(0);
  }
}

try {
  fs.mkdirSync(path.dirname(qhkeyFile), { recursive: true });
  fs.mkdirSync(path.dirname(masterKeyFile), { recursive: true });
  if (process.platform !== "linux") {
    writeQhkeyMasterKeyFile(masterKeyFile, false, { protection: "RAW" });
  }
  const firstMetadata = writeLogenCredential(
    {
      alias: "logen-session-first",
      userId: "FIRST-USER",
      customerCode: "FIRST-CUSTOMER",
      secretKey: "FIRST-SECRET",
    },
    false
  );

  const status = await getLogenCredentialStatus();
  assert.equal(status.providerType, "USB_QHKEY");
  assert.equal(status.status, "ACTIVE");
  assert.equal(status.keyFingerprint, firstMetadata.keyFingerprint);
  assert.equal(status.readEnabled, true);
  assert.equal(status.writeEnabled, true);

  const readSession = await openLogenRequestCredentialSession({
    apiName: "contractTotalInfo",
    operationType: "READ",
  });
  assert.equal(readSession.freshness, "CACHED_READ");
  assert.equal(readSession.userId, "FIRST-USER");
  assert.throws(
    () => assertLogenSessionForOperation(readSession, "WRITE"),
    /received a READ credential session/
  );

  const secondMetadata = writeLogenCredential(
    {
      alias: "logen-session-second",
      userId: "SECOND-USER",
      customerCode: "SECOND-CUSTOMER",
      secretKey: "SECOND-SECRET",
    },
    true
  );
  clearLogenQhkeyCredentialStateCacheForTest();
  const writeSession = await openLogenRequestCredentialSession({
    apiName: "getSlipNo",
    operationType: "WRITE",
  });
  assert.equal(writeSession.freshness, "FORCE_FRESH_WRITE");
  assert.equal(writeSession.userId, "SECOND-USER");
  assert.equal(writeSession.status.keyFingerprint, secondMetadata.keyFingerprint);
  assert.throws(
    () =>
      assertLogenPreparedCredentialMatchesWriteSession(
        {
          customerCode: readSession.customerCode,
          credentialFingerprint: readSession.status.keyFingerprint,
        },
        writeSession
      ),
    (error) => error?.code === "LOGEN_CREDENTIAL_CHANGED_DURING_PREPARATION"
  );

  writeLogenCredential(
    {
      alias: "logen-retry-first",
      userId: "RETRY-USER",
      customerCode: "RETRY-CUSTOMER",
      secretKey: "RETRY-SECRET",
    },
    true
  );
  clearLogenQhkeyCredentialStateCacheForTest();
  const observed = [];
  globalThis.fetch = async (_url, options) => {
    const requestBody = JSON.parse(String(options.body));
    observed.push({
      secretKey: options.headers.secretKey,
      userId: requestBody.userId,
      customerCode: requestBody.data[0].custCd,
    });
    if (observed.length === 1) {
      writeLogenCredential(
        {
          alias: "logen-retry-rotated",
          userId: "ROTATED-USER",
          customerCode: "ROTATED-CUSTOMER",
          secretKey: "ROTATED-SECRET",
        },
        true
      );
      clearLogenQhkeyCredentialStateCacheForTest();
      return new Response("{}", { status: 503 });
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await logenCarrierClient.getContractInfo();
  assert.deepEqual(observed, [
    {
      secretKey: "RETRY-SECRET",
      userId: "RETRY-USER",
      customerCode: "RETRY-CUSTOMER",
    },
    {
      secretKey: "RETRY-SECRET",
      userId: "RETRY-USER",
      customerCode: "RETRY-CUSTOMER",
    },
  ]);

  runtimeConfigService.read = originalRuntimeRead;
  writeRuntimeConfig("development");
  clearLogenQhkeyCredentialStateCacheForTest();
  const mockCredentials = await getLogenRuntimeCredentials();
  assert.equal(mockCredentials.status.providerType, "BUILT_IN_MOCK");
  assert.equal(mockCredentials.userId, "10358007");
  assert.equal(mockCredentials.customerCode, "20179999");
  assert.equal(mockCredentials.secretKey, "LOGEN-MOCK-TEST-SECRET");

  console.log("Logen QHKey credential session checks passed.");
} finally {
  runtimeConfigService.read = originalRuntimeRead;
  globalThis.fetch = originalFetch;
  if (originalCredentialsDirectory === undefined) {
    delete process.env.CREDENTIALS_DIRECTORY;
  } else {
    process.env.CREDENTIALS_DIRECTORY = originalCredentialsDirectory;
  }
  await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
