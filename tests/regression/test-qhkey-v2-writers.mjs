import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  decryptQhkey,
  readQhkeyMetadata,
} from "../../quickhack_server/security/qhkey-format.mjs";
import {
  readQhkeyMasterKeyFile,
  writeQhkeyMasterKeyFile,
} from "../../quickhack_server/security/qhkey-master-key-provider.mjs";
import {
  validateQhkeyProviderFilesWithMaster,
  writeCoupangQhkey,
  writeLogenQhkey,
} from "../../tools/server-console-qhkey.mjs";
import { writeTestServerRuntimeConfig } from "../support/runtime-config-file.mjs";

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "quickhack-qhkey-v2-writers-")
);
const originalCredentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
const systemdCredentialDirectory = path.join(temporaryDirectory, "credentials");
const systemdMasterKeyFile = path.join(
  systemdCredentialDirectory,
  "quickhack.qhkey-master-key"
);
const provisionTestMasterKey = (filePath, byte = 0x5a) => {
  if (process.platform === "linux") {
    fs.mkdirSync(systemdCredentialDirectory, { recursive: true });
    fs.writeFileSync(systemdMasterKeyFile, Buffer.alloc(32, byte), { mode: 0o600 });
    process.env.CREDENTIALS_DIRECTORY = systemdCredentialDirectory;
    return;
  }
  writeQhkeyMasterKeyFile(filePath, false, { protection: "RAW" });
};
const runtimeConfigPath = writeTestServerRuntimeConfig(temporaryDirectory);
const credential = {
  vendorId: "A123456",
  accessKey: "WRITER-ACCESS-MARKER",
  secretKey: "WRITER-SECRET-MARKER",
  issuedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2027-01-01T00:00:00.000Z",
};
const logenCredential = {
  userId: "10358007",
  customerCode: "20179999",
  secretKey: "LOGEN-WRITER-SECRET-MARKER",
  issuedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2028-01-01T00:00:00.000Z",
};

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...args, "--runtime-config", runtimeConfigPath],
      {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: {
        ...process.env,
        QUICKHACK_ENV: "development",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      }
    );
    let stdout = "";
    let stderr = "";
    let promptCount = 0;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;

      if (promptCount === 0 && chunk.includes("environment")) {
        promptCount += 1;
        child.stdin.write("\n");
      } else if (promptCount === 1 && chunk.includes("key alias")) {
        promptCount += 1;
        child.stdin.end("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`create-qhkey exited ${code}: ${stderr || stdout}`));
    });
  });
}

function assertCoupangV2(filePath, masterKeyFile, expectedAlias) {
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "QHQK2");
  assert.equal(bytes.readUInt8(5), 2);

  const metadata = readQhkeyMetadata(filePath);
  assert.equal(metadata.formatVersion, 2);
  assert.equal(metadata.credentialKind, "COUPANG_OPEN_API");
  assert.equal(metadata.keyAlias, expectedAlias);
  assert.equal("channel" in metadata, false);

  const masterKey = readQhkeyMasterKeyFile(masterKeyFile);
  try {
    const decrypted = decryptQhkey(filePath, masterKey);
    assert.equal(decrypted.metadata.credentialKind, "COUPANG_OPEN_API");
    assert.deepEqual(decrypted.credential, {
      vendorId: credential.vendorId,
      accessKey: credential.accessKey,
      secretKey: credential.secretKey,
    });
  } finally {
    masterKey.fill(0);
  }
}

function assertLogenV2(filePath, masterKeyFile, expectedAlias) {
  const metadata = readQhkeyMetadata(filePath);
  assert.equal(metadata.formatVersion, 2);
  assert.equal(metadata.credentialKind, "LOGEN_OPEN_API");
  assert.equal(metadata.keyAlias, expectedAlias);

  const masterKey = readQhkeyMasterKeyFile(masterKeyFile);
  try {
    const decrypted = decryptQhkey(filePath, masterKey);
    assert.equal(decrypted.metadata.credentialKind, "LOGEN_OPEN_API");
    assert.deepEqual(decrypted.credential, {
      userId: logenCredential.userId,
      customerCode: logenCredential.customerCode,
      secretKey: logenCredential.secretKey,
    });
  } finally {
    masterKey.fill(0);
  }
}

const mockServer = http.createServer((request, response) => {
  if (
    request.method !== "POST" ||
    request.url !== "/admin/openapi-credentials/issue"
  ) {
    response.writeHead(404).end();
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      credential: {
        credentialId: "writer-test-credential",
        ...credential,
      },
    })
  );
});

try {
  const consoleDirectory = path.join(temporaryDirectory, "console");
  const consoleMasterKeyFile = path.join(consoleDirectory, "master.key");
  const consoleQhkeyFile = path.join(consoleDirectory, "coupang.qhkey");
  provisionTestMasterKey(consoleMasterKeyFile);
  writeCoupangQhkey(
    { environment: "live", keyAlias: "console-writer-v2" },
    {
      root: consoleDirectory,
      filePath: consoleQhkeyFile,
      fileExists: false,
      masterKeyFile: consoleMasterKeyFile,
    },
    credential
  );
  assertCoupangV2(
    consoleQhkeyFile,
    consoleMasterKeyFile,
    "console-writer-v2"
  );
  const logenQhkeyFile = path.join(consoleDirectory, "logen.qhkey");
  writeLogenQhkey(
    { environment: "live", keyAlias: "logen-console-writer-v2" },
    {
      root: consoleDirectory,
      filePath: logenQhkeyFile,
      fileExists: false,
      masterKeyFile: consoleMasterKeyFile,
    },
    logenCredential
  );
  assertLogenV2(
    logenQhkeyFile,
    consoleMasterKeyFile,
    "logen-console-writer-v2"
  );

  const sharedRoot = path.join(temporaryDirectory, "shared-root");
  const sharedKeyDirectory = path.join(sharedRoot, "quickhack-keys");
  const sharedMasterKeyFile = path.join(temporaryDirectory, "shared-master.key");
  const sharedCoupangFile = path.join(sharedKeyDirectory, "coupang.qhkey");
  const sharedLogenFile = path.join(sharedKeyDirectory, "logen.qhkey");
  provisionTestMasterKey(sharedMasterKeyFile);
  writeCoupangQhkey(
    { environment: "live", keyAlias: "shared-coupang" },
    {
      root: sharedRoot,
      filePath: sharedCoupangFile,
      fileExists: false,
      masterKeyFile: sharedMasterKeyFile,
    },
    credential
  );
  writeLogenQhkey(
    { environment: "live", keyAlias: "shared-logen" },
    {
      root: sharedRoot,
      filePath: sharedLogenFile,
      fileExists: false,
      masterKeyFile: sharedMasterKeyFile,
    },
    logenCredential
  );
  assert.deepEqual(
    validateQhkeyProviderFilesWithMaster(sharedRoot, sharedMasterKeyFile).map(
      (entry) => entry.provider
    ),
    ["coupang", "logen"]
  );
  const coupangBeforeFailure = fs.readFileSync(sharedCoupangFile);
  const logenBeforeFailure = fs.readFileSync(sharedLogenFile);
  const wrongMasterKeyFile = path.join(temporaryDirectory, "wrong-master.key");
  provisionTestMasterKey(wrongMasterKeyFile, 0x3c);
  assert.throws(
    () => validateQhkeyProviderFilesWithMaster(sharedRoot, wrongMasterKeyFile),
    (error) => error?.code === "QHKEY_DECRYPT_FAILED"
  );
  assert.deepEqual(fs.readFileSync(sharedCoupangFile), coupangBeforeFailure);
  assert.deepEqual(fs.readFileSync(sharedLogenFile), logenBeforeFailure);
  if (process.platform === "linux") provisionTestMasterKey(sharedMasterKeyFile);

  fs.copyFileSync(sharedLogenFile, sharedCoupangFile);
  assert.throws(
    () =>
      validateQhkeyProviderFilesWithMaster(sharedRoot, sharedMasterKeyFile),
    /QHKEY_CREDENTIAL_KIND_MISMATCH/
  );
  fs.writeFileSync(sharedCoupangFile, coupangBeforeFailure);
  assert.deepEqual(
    validateQhkeyProviderFilesWithMaster(sharedRoot, sharedMasterKeyFile).map(
      (entry) => entry.provider
    ),
    ["coupang", "logen"]
  );

  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  const address = mockServer.address();
  assert(address && typeof address === "object");

  const cliDirectory = path.join(temporaryDirectory, "cli");
  const cliMasterKeyFile = path.join(cliDirectory, "master.key");
  const cliQhkeyFile = path.join(cliDirectory, "coupang.qhkey");
  const result = await runCli(
    [
      path.join("tools", "create-qhkey.mjs"),
      "--root",
      cliDirectory,
      "--out",
      cliQhkeyFile,
      "--master-key",
      cliMasterKeyFile,
      "--master-key-protection",
      "RAW",
      "--environment",
      "mock",
      "--alias",
      "cli-writer-v2",
      "--mock-server-url",
      `http://127.0.0.1:${address.port}`,
    ]
  );
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(credential.accessKey), false);
  assert.equal(result.stdout.includes(credential.secretKey), false);
  assertCoupangV2(cliQhkeyFile, cliMasterKeyFile, "cli-writer-v2");

  console.log("QHKey v2 CLI and server-console writer checks passed.");
} finally {
  await new Promise((resolve) => mockServer.close(resolve));
  if (originalCredentialsDirectory === undefined) {
    delete process.env.CREDENTIALS_DIRECTORY;
  } else {
    process.env.CREDENTIALS_DIRECTORY = originalCredentialsDirectory;
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
