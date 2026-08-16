import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  QhkeyFormatError,
  createEncryptedQhkey,
  decryptQhkey,
  decryptQhkeyAsync,
  readQhkeyMetadata,
  readQhkeyMetadataAsync,
  writeQhkeyFile,
} from "../../quickhack_server/security/qhkey-format.mjs";

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "quickhack-qhkey-v2-")
);
const masterKey = Buffer.alloc(32, 0x31);
const wrongMasterKey = Buffer.alloc(32, 0x32);
const issuedAt = "2026-08-01T00:00:00.000Z";
const expiresAt = "2027-08-01T00:00:00.000Z";
const secretMarkers = [
  "COUPANG-SECRET-MARKER",
  "LOGEN-SECRET-MARKER",
  "COUPANG-ACCESS-MARKER",
  "LOGEN-USER-MARKER",
];

function expectQhkeyError(action, code) {
  assert.throws(action, (error) => {
    assert(error instanceof QhkeyFormatError);
    assert.equal(error.code, code);
    for (const marker of secretMarkers) {
      assert.equal(error.message.includes(marker), false);
    }
    return true;
  });
}

async function expectQhkeyErrorAsync(action, code) {
  await assert.rejects(action, (error) => {
    assert(error instanceof QhkeyFormatError);
    assert.equal(error.code, code);
    for (const marker of secretMarkers) {
      assert.equal(error.message.includes(marker), false);
    }
    return true;
  });
}

function createFixture(name, input) {
  const result = createEncryptedQhkey({
    masterKey,
    environment: "production",
    keyAlias: `${name}-key`,
    issuedAt,
    expiresAt,
    ...input,
  });
  const filePath = path.join(temporaryDirectory, `${name}.qhkey`);
  writeQhkeyFile(filePath, result.buffer);
  return { filePath, ...result };
}

try {
  assert.equal(
    new QhkeyFormatError("UNKNOWN_ERROR_CODE").code,
    "QHKEY_FORMAT_INVALID"
  );

  const coupang = createFixture("coupang", {
    credentialKind: "COUPANG_OPEN_API",
    credential: {
      vendorId: "COUPANG-VENDOR",
      accessKey: "COUPANG-ACCESS-MARKER",
      secretKey: "COUPANG-SECRET-MARKER",
    },
  });
  const logen = createFixture("logen", {
    credentialKind: "LOGEN_OPEN_API",
    credential: {
      userId: "LOGEN-USER-MARKER",
      customerCode: "LOGEN-CUSTOMER",
      secretKey: "LOGEN-SECRET-MARKER",
    },
  });

  assert.equal(coupang.buffer.subarray(0, 5).toString("ascii"), "QHQK2");
  assert.equal(coupang.buffer.readUInt8(5), 2);
  assert.equal(logen.buffer.subarray(0, 5).toString("ascii"), "QHQK2");
  assert.equal(logen.buffer.readUInt8(5), 2);
  for (const marker of secretMarkers) {
    assert.equal(coupang.buffer.includes(Buffer.from(marker)), false);
    assert.equal(logen.buffer.includes(Buffer.from(marker)), false);
  }

  const coupangMetadata = readQhkeyMetadata(coupang.filePath);
  const logenMetadata = await readQhkeyMetadataAsync(logen.filePath);
  assert.deepEqual(coupangMetadata, coupang.metadata);
  assert.deepEqual(logenMetadata, logen.metadata);
  assert.equal(coupangMetadata.formatVersion, 2);
  assert.equal(coupangMetadata.credentialKind, "COUPANG_OPEN_API");
  assert.equal(logenMetadata.credentialKind, "LOGEN_OPEN_API");
  assert.equal("channel" in coupangMetadata, false);
  assert.equal("credential" in coupangMetadata, false);
  assert.equal("secretKey" in coupangMetadata, false);

  const decryptedCoupang = decryptQhkey(coupang.filePath, masterKey);
  const decryptedLogen = await decryptQhkeyAsync(logen.filePath, masterKey);
  assert.deepEqual(decryptedCoupang.credential, {
    vendorId: "COUPANG-VENDOR",
    accessKey: "COUPANG-ACCESS-MARKER",
    secretKey: "COUPANG-SECRET-MARKER",
  });
  assert.deepEqual(decryptedLogen.credential, {
    userId: "LOGEN-USER-MARKER",
    customerCode: "LOGEN-CUSTOMER",
    secretKey: "LOGEN-SECRET-MARKER",
  });
  assert.equal("secret" in decryptedCoupang, false);
  assert.notEqual(
    coupang.metadata.keyFingerprint,
    createEncryptedQhkey({
      masterKey,
      credentialKind: "LOGEN_OPEN_API",
      environment: "production",
      keyAlias: "fingerprint-kind-test",
      credential: {
        userId: "COUPANG-VENDOR",
        customerCode: "COUPANG-ACCESS-MARKER",
        secretKey: "COUPANG-SECRET-MARKER",
      },
      issuedAt,
      expiresAt,
    }).metadata.keyFingerprint
  );

  expectQhkeyError(
    () => decryptQhkey(coupang.filePath, wrongMasterKey),
    "QHKEY_DECRYPT_FAILED"
  );
  await expectQhkeyErrorAsync(
    () => decryptQhkeyAsync(logen.filePath, wrongMasterKey),
    "QHKEY_DECRYPT_FAILED"
  );

  const tamperedCiphertext = Buffer.from(coupang.buffer);
  tamperedCiphertext[tamperedCiphertext.length - 1] ^= 0x01;
  const tamperedCiphertextFile = path.join(
    temporaryDirectory,
    "tampered-ciphertext.qhkey"
  );
  fs.writeFileSync(tamperedCiphertextFile, tamperedCiphertext);
  expectQhkeyError(
    () => decryptQhkey(tamperedCiphertextFile, masterKey),
    "QHKEY_DECRYPT_FAILED"
  );

  const tamperedMetadata = Buffer.from(coupang.buffer);
  const aliasOffset = tamperedMetadata.indexOf(
    Buffer.from("coupang-key", "utf8")
  );
  assert.notEqual(aliasOffset, -1);
  Buffer.from("tamperedkey", "utf8").copy(tamperedMetadata, aliasOffset);
  const tamperedMetadataFile = path.join(
    temporaryDirectory,
    "tampered-metadata.qhkey"
  );
  fs.writeFileSync(tamperedMetadataFile, tamperedMetadata);
  expectQhkeyError(
    () => decryptQhkey(tamperedMetadataFile, masterKey),
    "QHKEY_DECRYPT_FAILED"
  );

  const unsupportedKind = Buffer.from(coupang.buffer);
  const kindOffset = unsupportedKind.indexOf(
    Buffer.from("COUPANG_OPEN_API", "utf8")
  );
  assert.notEqual(kindOffset, -1);
  Buffer.from("UNKNOWN_OPEN_API", "utf8").copy(unsupportedKind, kindOffset);
  const unsupportedKindFile = path.join(
    temporaryDirectory,
    "unsupported-kind.qhkey"
  );
  fs.writeFileSync(unsupportedKindFile, unsupportedKind);
  expectQhkeyError(
    () => readQhkeyMetadata(unsupportedKindFile),
    "QHKEY_CREDENTIAL_KIND_UNSUPPORTED"
  );

  const oldFormatFile = path.join(temporaryDirectory, "old-format.qhkey");
  const oldFormat = Buffer.from(coupang.buffer);
  Buffer.from("QHQK1", "ascii").copy(oldFormat, 0);
  oldFormat.writeUInt8(1, 5);
  fs.writeFileSync(oldFormatFile, oldFormat);
  expectQhkeyError(
    () => readQhkeyMetadata(oldFormatFile),
    "QHKEY_FORMAT_INVALID"
  );

  const truncatedFile = path.join(temporaryDirectory, "truncated.qhkey");
  fs.writeFileSync(truncatedFile, coupang.buffer.subarray(0, 12));
  expectQhkeyError(
    () => readQhkeyMetadata(truncatedFile),
    "QHKEY_FORMAT_INVALID"
  );

  const metadataLength = coupang.buffer.readUInt32BE(7);
  const metadataEnd = 5 + 1 + 1 + 4 + 12 + 16 + metadataLength;
  const trailingFieldBytes = Buffer.concat([
    coupang.buffer.subarray(0, metadataEnd),
    Buffer.from([0]),
    coupang.buffer.subarray(metadataEnd),
  ]);
  trailingFieldBytes.writeUInt32BE(metadataLength + 1, 7);
  const trailingFieldBytesFile = path.join(
    temporaryDirectory,
    "trailing-field-bytes.qhkey"
  );
  fs.writeFileSync(trailingFieldBytesFile, trailingFieldBytes);
  expectQhkeyError(
    () => readQhkeyMetadata(trailingFieldBytesFile),
    "QHKEY_FORMAT_INVALID"
  );

  assert.throws(
    () =>
      createEncryptedQhkey({
        masterKey,
        credentialKind: "COUPANG_OPEN_API",
        environment: "production",
        keyAlias: "invalid-shape",
        credential: {
          vendorId: "vendor",
          accessKey: "access",
          secretKey: "secret",
          customerCode: "must-not-be-accepted",
        },
        issuedAt,
        expiresAt,
      }),
    /credential must contain exactly/
  );

  console.log("QHKey v2 format, provider codec, and tamper checks passed.");
} finally {
  masterKey.fill(0);
  wrongMasterKey.fill(0);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
