import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const QHKEY_MAGIC = Buffer.from("QHQK2", "ascii");
const QHKEY_VERSION = 2;
const QHKEY_ALGORITHM_AES_256_GCM = 1;
const QHKEY_IV_LENGTH = 12;
const QHKEY_TAG_LENGTH = 16;
const QHKEY_MASTER_KEY_LENGTH = 32;
const QHKEY_METADATA_FIELD_COUNT = 6;
const QHKEY_MAX_FILE_BYTES = 64 * 1024;
const UTF8 = "utf8";

export const QHKEY_ENVIRONMENTS = ["mock", "live", "development", "production"];
export const QHKEY_CREDENTIAL_KINDS = [
  "COUPANG_OPEN_API",
  "LOGEN_OPEN_API",
];

const QHKEY_CREDENTIAL_FIELDS = Object.freeze({
  COUPANG_OPEN_API: Object.freeze(["vendorId", "accessKey", "secretKey"]),
  LOGEN_OPEN_API: Object.freeze(["userId", "customerCode", "secretKey"]),
});

const QHKEY_ERROR_MESSAGES = Object.freeze({
  QHKEY_FORMAT_INVALID: "QHKEY file format is invalid.",
  QHKEY_CREDENTIAL_KIND_UNSUPPORTED:
    "QHKEY credential kind is not supported.",
  QHKEY_DECRYPT_FAILED: "QHKEY credential could not be decrypted or verified.",
});

export class QhkeyFormatError extends Error {
  constructor(code) {
    const normalizedCode = Object.hasOwn(QHKEY_ERROR_MESSAGES, code)
      ? code
      : "QHKEY_FORMAT_INVALID";
    super(QHKEY_ERROR_MESSAGES[normalizedCode]);
    this.name = "QhkeyFormatError";
    this.code = normalizedCode;
  }
}

function qhkeyFormatError(code) {
  return new QhkeyFormatError(code);
}

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  return normalized;
}

function safeReadRegularFile(filePath, label, maxBytes) {
  const stats = fs.lstatSync(/* turbopackIgnore: true */ filePath);

  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link.`);
  }

  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }

  if (stats.size > maxBytes) {
    throw new Error(`${label} is too large.`);
  }

  return fs.readFileSync(/* turbopackIgnore: true */ filePath);
}

async function safeReadRegularFileAsync(filePath, label, maxBytes) {
  const stats = await fsp.lstat(filePath);

  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link.`);
  }

  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }

  if (stats.size > maxBytes) {
    throw new Error(`${label} is too large.`);
  }

  return fsp.readFile(filePath);
}

function ensureFieldLength(buffer, label) {
  if (buffer.length > 0xffff) {
    throw new Error(`${label} is too long.`);
  }
}

function encodeStringFields(fields, sensitive = false) {
  const chunks = [];
  const sensitiveBuffers = [];

  try {
    fields.forEach((field, index) => {
      const text = String(field ?? "");
      const value = Buffer.from(text, UTF8);

      if (sensitive) {
        sensitiveBuffers.push(value);
      }

      ensureFieldLength(value, `QHKEY field ${index}`);

      const length = Buffer.alloc(2);
      length.writeUInt16BE(value.length, 0);
      chunks.push(length, value);
    });

    return Buffer.concat(chunks);
  } finally {
    sensitiveBuffers.forEach((buffer) => buffer.fill(0));
  }
}

function decodeStringFields(buffer, fieldCount) {
  const fields = [];
  let offset = 0;

  for (let index = 0; index < fieldCount; index += 1) {
    if (offset + 2 > buffer.length) {
      throw new Error("QHKEY field length is truncated.");
    }

    const length = buffer.readUInt16BE(offset);
    offset += 2;

    if (offset + length > buffer.length) {
      throw new Error("QHKEY field value is truncated.");
    }

    fields.push(buffer.subarray(offset, offset + length).toString(UTF8));
    offset += length;
  }

  if (offset !== buffer.length) {
    throw new Error("QHKEY has trailing field bytes.");
  }

  return fields;
}

export function normalizeQhkeyEnvironment(value) {
  const normalized = requiredText(value, "environment").toLowerCase();

  if (!QHKEY_ENVIRONMENTS.includes(normalized)) {
    throw new Error(
      `QHKEY environment must be one of: ${QHKEY_ENVIRONMENTS.join(", ")}.`
    );
  }

  return normalized;
}

export function normalizeQhkeyCredentialKind(value) {
  const normalized = requiredText(value, "credentialKind").toUpperCase();

  if (!QHKEY_CREDENTIAL_KINDS.includes(normalized)) {
    throw qhkeyFormatError("QHKEY_CREDENTIAL_KIND_UNSUPPORTED");
  }

  return normalized;
}

function normalizeQhkeyCredential(credentialKind, credential) {
  const fields = QHKEY_CREDENTIAL_FIELDS[credentialKind];

  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new Error("credential is required.");
  }

  const suppliedFields = Object.keys(credential).sort();
  const expectedFields = [...fields].sort();

  if (
    suppliedFields.length !== expectedFields.length ||
    suppliedFields.some((field, index) => field !== expectedFields[index])
  ) {
    throw new Error(
      `credential must contain exactly: ${fields.join(", ")}.`
    );
  }

  return Object.fromEntries(
    fields.map((field) => [field, requiredText(credential[field], field)])
  );
}

function credentialValues(credentialKind, credential) {
  return QHKEY_CREDENTIAL_FIELDS[credentialKind].map(
    (field) => credential[field]
  );
}

function credentialFromValues(credentialKind, values) {
  return Object.fromEntries(
    QHKEY_CREDENTIAL_FIELDS[credentialKind].map((field, index) => [
      field,
      requiredText(values[index], field),
    ])
  );
}

export function parseQhkeyIsoDateTimeMs(value, label = "date") {
  const text = requiredText(value, label);

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) {
    throw new Error(`${label} must be an ISO UTC timestamp, for example 2026-07-11T00:00:00.000Z.`);
  }

  const parsed = Date.parse(text);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} is not a valid date.`);
  }

  return parsed;
}

export function assertValidQhkeyDateRange(issuedAt, expiresAt) {
  const issuedAtMs = parseQhkeyIsoDateTimeMs(issuedAt, "issuedAt");
  const expiresAtMs = parseQhkeyIsoDateTimeMs(expiresAt, "expiresAt");

  if (expiresAtMs <= issuedAtMs) {
    throw new Error("expiresAt must be later than issuedAt.");
  }
}

export function qhkeyFingerprint(input) {
  const credentialKind = normalizeQhkeyCredentialKind(input.credentialKind);
  const credential = normalizeQhkeyCredential(
    credentialKind,
    input.credential
  );

  return crypto
    .createHash("sha256")
    .update(
      [credentialKind, ...credentialValues(credentialKind, credential)].join(
        "\0"
      ),
      UTF8
    )
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

export function normalizeQhkeyMasterKey(masterKey) {
  if (masterKey.length === QHKEY_MASTER_KEY_LENGTH) {
    return masterKey;
  }

  const text = masterKey.toString(UTF8).trim();

  if (text) {
    const decoded = Buffer.from(text, "base64");

    if (decoded.length === QHKEY_MASTER_KEY_LENGTH) {
      return decoded;
    }
  }

  throw new Error("QHKEY master key must be 32 raw bytes or base64-encoded 32 bytes.");
}

function parseMetadata(fields) {
  const [
    credentialKind,
    environment,
    keyAlias,
    keyFingerprint,
    issuedAt,
    expiresAt,
  ] = fields;

  return {
    formatVersion: QHKEY_VERSION,
    credentialKind,
    environment,
    keyAlias,
    keyFingerprint,
    issuedAt,
    expiresAt,
  };
}

function metadataFields(metadata) {
  return [
    metadata.credentialKind,
    metadata.environment,
    metadata.keyAlias,
    metadata.keyFingerprint,
    metadata.issuedAt,
    metadata.expiresAt,
  ];
}

function parseQhkeyBuffer(buffer) {
  try {
    const headerLength = QHKEY_MAGIC.length + 1 + 1 + 4 + QHKEY_IV_LENGTH;
    const tagStart = headerLength;
    const metadataStart = tagStart + QHKEY_TAG_LENGTH;

    if (!Buffer.isBuffer(buffer) || buffer.length <= metadataStart) {
      throw qhkeyFormatError("QHKEY_FORMAT_INVALID");
    }

    const magic = buffer.subarray(0, QHKEY_MAGIC.length);
    const version = buffer.readUInt8(QHKEY_MAGIC.length);
    const algorithm = buffer.readUInt8(QHKEY_MAGIC.length + 1);

    if (
      !magic.equals(QHKEY_MAGIC) ||
      version !== QHKEY_VERSION ||
      algorithm !== QHKEY_ALGORITHM_AES_256_GCM
    ) {
      throw qhkeyFormatError("QHKEY_FORMAT_INVALID");
    }

    const metadataLength = buffer.readUInt32BE(QHKEY_MAGIC.length + 2);
    const metadataEnd = metadataStart + metadataLength;

    if (metadataLength === 0 || metadataEnd >= buffer.length) {
      throw qhkeyFormatError("QHKEY_FORMAT_INVALID");
    }

    const header = buffer.subarray(0, headerLength);
    const tag = buffer.subarray(tagStart, metadataStart);
    const metadataBytes = buffer.subarray(metadataStart, metadataEnd);
    const encryptedPayload = buffer.subarray(metadataEnd);
    const fields = decodeStringFields(
      metadataBytes,
      QHKEY_METADATA_FIELD_COUNT
    );

    return {
      metadata: parseMetadata(fields),
      header,
      tag,
      metadataBytes,
      encryptedPayload,
    };
  } catch (error) {
    if (error instanceof QhkeyFormatError) {
      throw error;
    }

    throw qhkeyFormatError("QHKEY_FORMAT_INVALID");
  }
}

export function validateQhkeyMetadata(metadata) {
  try {
    if (metadata.formatVersion !== QHKEY_VERSION) {
      throw qhkeyFormatError("QHKEY_FORMAT_INVALID");
    }

    normalizeQhkeyCredentialKind(metadata.credentialKind);
    normalizeQhkeyEnvironment(metadata.environment);
    requiredText(metadata.keyAlias, "keyAlias");

    if (!/^[A-F0-9]{16}$/.test(String(metadata.keyFingerprint ?? ""))) {
      throw qhkeyFormatError("QHKEY_FORMAT_INVALID");
    }

    assertValidQhkeyDateRange(metadata.issuedAt, metadata.expiresAt);
  } catch (error) {
    if (error instanceof QhkeyFormatError) {
      throw error;
    }

    throw qhkeyFormatError("QHKEY_FORMAT_INVALID");
  }
}

export function createEncryptedQhkey(input) {
  const credentialKind = normalizeQhkeyCredentialKind(input.credentialKind);
  const environment = normalizeQhkeyEnvironment(input.environment);
  const keyAlias = requiredText(input.keyAlias, "keyAlias");
  const credential = normalizeQhkeyCredential(
    credentialKind,
    input.credential
  );
  const issuedAt = requiredText(input.issuedAt, "issuedAt");
  const expiresAt = requiredText(input.expiresAt, "expiresAt");

  assertValidQhkeyDateRange(issuedAt, expiresAt);

  let key;
  let credentialBytes;

  try {
    key = normalizeQhkeyMasterKey(input.masterKey);
    const metadata = {
      formatVersion: QHKEY_VERSION,
      credentialKind,
      environment,
      keyAlias,
      keyFingerprint: qhkeyFingerprint({
        credentialKind,
        credential,
      }),
      issuedAt,
      expiresAt,
    };
    const metadataBytes = encodeStringFields(metadataFields(metadata));
    credentialBytes = encodeStringFields(
      credentialValues(credentialKind, credential),
      true
    );
    const iv = crypto.randomBytes(QHKEY_IV_LENGTH);
    const header = Buffer.alloc(
      QHKEY_MAGIC.length + 1 + 1 + 4 + QHKEY_IV_LENGTH
    );

    QHKEY_MAGIC.copy(header, 0);
    header.writeUInt8(QHKEY_VERSION, QHKEY_MAGIC.length);
    header.writeUInt8(QHKEY_ALGORITHM_AES_256_GCM, QHKEY_MAGIC.length + 1);
    header.writeUInt32BE(metadataBytes.length, QHKEY_MAGIC.length + 2);
    iv.copy(header, QHKEY_MAGIC.length + 1 + 1 + 4);

    const aad = Buffer.concat([header, metadataBytes]);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);

    const encrypted = Buffer.concat([
      cipher.update(credentialBytes),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      buffer: Buffer.concat([header, tag, metadataBytes, encrypted]),
      metadata,
    };
  } finally {
    credentialBytes?.fill(0);
    if (key && key !== input.masterKey) {
      key.fill(0);
    }
  }
}

export function readQhkeyMetadata(filePath) {
  const buffer = safeReadRegularFile(filePath, "QHKEY file", QHKEY_MAX_FILE_BYTES);
  const parsed = parseQhkeyBuffer(buffer);

  validateQhkeyMetadata(parsed.metadata);

  return parsed.metadata;
}

export function readQhkeyMetadataBuffer(buffer) {
  const parsed = parseQhkeyBuffer(buffer);
  validateQhkeyMetadata(parsed.metadata);
  return parsed.metadata;
}

export async function readQhkeyMetadataAsync(filePath) {
  const buffer = await safeReadRegularFileAsync(
    filePath,
    "QHKEY file",
    QHKEY_MAX_FILE_BYTES
  );
  const parsed = parseQhkeyBuffer(buffer);

  validateQhkeyMetadata(parsed.metadata);

  return parsed.metadata;
}

function decryptParsedQhkey(parsed, masterKey) {
  let credentialBytes;
  let key;
  const credentialChunks = [];

  try {
    validateQhkeyMetadata(parsed.metadata);

    const credentialKind = normalizeQhkeyCredentialKind(
      parsed.metadata.credentialKind
    );
    key = normalizeQhkeyMasterKey(masterKey);
    const ivOffset = QHKEY_MAGIC.length + 1 + 1 + 4;
    const iv = parsed.header.subarray(ivOffset, ivOffset + QHKEY_IV_LENGTH);
    const aad = Buffer.concat([parsed.header, parsed.metadataBytes]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);

    decipher.setAAD(aad);
    decipher.setAuthTag(parsed.tag);

    credentialChunks.push(decipher.update(parsed.encryptedPayload));
    credentialChunks.push(decipher.final());
    credentialBytes = Buffer.concat(credentialChunks);

    const values = decodeStringFields(
      credentialBytes,
      QHKEY_CREDENTIAL_FIELDS[credentialKind].length
    );
    const credential = credentialFromValues(credentialKind, values);
    const fingerprint = qhkeyFingerprint({
      credentialKind,
      credential,
    });

    if (fingerprint !== parsed.metadata.keyFingerprint) {
      throw qhkeyFormatError("QHKEY_DECRYPT_FAILED");
    }

    return {
      metadata: parsed.metadata,
      credential,
    };
  } catch (error) {
    if (
      error instanceof QhkeyFormatError &&
      error.code === "QHKEY_CREDENTIAL_KIND_UNSUPPORTED"
    ) {
      throw error;
    }

    throw qhkeyFormatError("QHKEY_DECRYPT_FAILED");
  } finally {
    credentialBytes?.fill(0);
    credentialChunks.forEach((buffer) => buffer.fill(0));
    if (key && key !== masterKey) {
      key.fill(0);
    }
  }
}

export function decryptQhkey(filePath, masterKey) {
  const parsed = parseQhkeyBuffer(
    safeReadRegularFile(filePath, "QHKEY file", QHKEY_MAX_FILE_BYTES)
  );

  return decryptParsedQhkey(parsed, masterKey);
}

export function decryptQhkeyBuffer(buffer, masterKey) {
  return decryptParsedQhkey(parseQhkeyBuffer(buffer), masterKey);
}

export async function decryptQhkeyAsync(filePath, masterKey) {
  const parsed = parseQhkeyBuffer(
    await safeReadRegularFileAsync(
      filePath,
      "QHKEY file",
      QHKEY_MAX_FILE_BYTES
    )
  );
  return decryptParsedQhkey(parsed, masterKey);
}

export function writeQhkeyFile(filePath, payload, force = false) {
  if (!force && fs.existsSync(/* turbopackIgnore: true */ filePath)) {
    throw new Error(`QHKEY file already exists: ${filePath}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, payload, {
    mode: 0o600,
    flag: force ? "w" : "wx",
  });
}

export function qhkeyDaysUntilExpiry(expiresAt, now = new Date()) {
  try {
    const time = parseQhkeyIsoDateTimeMs(expiresAt, "expiresAt");

    return Math.ceil((time - now.getTime()) / 86_400_000);
  } catch {
    return null;
  }
}
