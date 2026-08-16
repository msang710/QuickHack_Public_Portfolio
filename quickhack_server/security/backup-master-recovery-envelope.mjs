import crypto from "node:crypto";

export const BACKUP_MASTER_RECOVERY_ENVELOPE_HEADER =
  "QUICKHACK_BACKUP_MASTER_RECOVERY_V1";
const KEY_BYTES = 32;
const MAX_ENVELOPE_BYTES = 16 * 1024;
const DEFAULT_SCRYPT = Object.freeze({ N: 32_768, r: 8, p: 1 });

export class BackupMasterRecoveryEnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupMasterRecoveryEnvelopeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BackupMasterRecoveryEnvelopeError(code, message);
}

function passphraseBuffer(value) {
  const result = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(String(value ?? ""), "utf8");
  if (result.length < 12 || result.length > 1024 || result.includes(0)) {
    result.fill(0);
    fail(
      "BACKUP_RECOVERY_PASSPHRASE_INVALID",
      "The recovery passphrase must contain between 12 and 1024 UTF-8 bytes."
    );
  }
  return result;
}

function canonicalBase64(value, field, expectedBytes) {
  const encoded = String(value ?? "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded
    )
  ) {
    fail("BACKUP_RECOVERY_ENVELOPE_INVALID", `Invalid ${field}.`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.toString("base64") !== encoded ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    decoded.fill(0);
    fail("BACKUP_RECOVERY_ENVELOPE_INVALID", `Invalid ${field}.`);
  }
  return decoded;
}

function assertScrypt(input) {
  const N = Number(input?.N);
  const r = Number(input?.r);
  const p = Number(input?.p);
  if (
    !Number.isSafeInteger(N) ||
    N < 16_384 ||
    N > 262_144 ||
    (N & (N - 1)) !== 0 ||
    r !== 8 ||
    !Number.isSafeInteger(p) ||
    p < 1 ||
    p > 4
  ) {
    fail(
      "BACKUP_RECOVERY_KDF_INVALID",
      "The recovery envelope scrypt parameters are outside the allowed bounds."
    );
  }
  return { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) };
}

function deriveKey(passphrase, salt, parameters) {
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, parameters);
}

export function createBackupMasterRecoveryEnvelope(
  backupMasterKey,
  passphrase,
  options = {}
) {
  if (!Buffer.isBuffer(backupMasterKey) || backupMasterKey.length !== KEY_BYTES) {
    fail(
      "BACKUP_RECOVERY_KEY_INVALID",
      "The backup master key must contain exactly 32 bytes."
    );
  }
  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  const parameters = assertScrypt(options.scrypt ?? DEFAULT_SCRYPT);
  const passphraseBytes = passphraseBuffer(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  let derivedKey;
  let ciphertext;
  try {
    derivedKey = deriveKey(passphraseBytes, salt, parameters);
    const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
    cipher.setAAD(Buffer.from(BACKUP_MASTER_RECOVERY_ENVELOPE_HEADER, "ascii"));
    ciphertext = Buffer.concat([
      cipher.update(backupMasterKey),
      cipher.final(),
    ]);
    const payload = {
      version: 1,
      kdf: {
        name: "scrypt",
        N: parameters.N,
        r: parameters.r,
        p: parameters.p,
        salt: salt.toString("base64"),
      },
      cipher: {
        name: "AES-256-GCM",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      },
      ciphertext: ciphertext.toString("base64"),
    };
    return Buffer.from(
      `${BACKUP_MASTER_RECOVERY_ENVELOPE_HEADER}\n${JSON.stringify(payload)}\n`,
      "utf8"
    );
  } finally {
    passphraseBytes.fill(0);
    salt.fill(0);
    iv.fill(0);
    derivedKey?.fill(0);
    ciphertext?.fill(0);
  }
}

export function openBackupMasterRecoveryEnvelope(envelope, passphrase) {
  if (
    !Buffer.isBuffer(envelope) ||
    envelope.length === 0 ||
    envelope.length > MAX_ENVELOPE_BYTES
  ) {
    fail(
      "BACKUP_RECOVERY_ENVELOPE_INVALID",
      "The recovery envelope size is invalid."
    );
  }
  const source = envelope.toString("utf8");
  const prefix = `${BACKUP_MASTER_RECOVERY_ENVELOPE_HEADER}\n`;
  if (!source.startsWith(prefix) || !source.endsWith("\n")) {
    fail(
      "BACKUP_RECOVERY_ENVELOPE_INVALID",
      "The recovery envelope header is invalid."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(source.slice(prefix.length, -1));
  } catch {
    fail(
      "BACKUP_RECOVERY_ENVELOPE_INVALID",
      "The recovery envelope payload is invalid."
    );
  }
  const topKeys = Object.keys(parsed ?? {}).sort();
  if (
    parsed?.version !== 1 ||
    topKeys.join(",") !== "cipher,ciphertext,kdf,version" ||
    parsed.kdf?.name !== "scrypt" ||
    Object.keys(parsed.kdf).sort().join(",") !== "N,name,p,r,salt" ||
    parsed.cipher?.name !== "AES-256-GCM" ||
    Object.keys(parsed.cipher).sort().join(",") !== "iv,name,tag"
  ) {
    fail(
      "BACKUP_RECOVERY_ENVELOPE_INVALID",
      "The recovery envelope schema is invalid."
    );
  }
  const parameters = assertScrypt(parsed.kdf);
  const passphraseBytes = passphraseBuffer(passphrase);
  const salt = canonicalBase64(parsed.kdf.salt, "salt", 16);
  const iv = canonicalBase64(parsed.cipher.iv, "iv", 12);
  const tag = canonicalBase64(parsed.cipher.tag, "authentication tag", 16);
  const ciphertext = canonicalBase64(parsed.ciphertext, "ciphertext", KEY_BYTES);
  let derivedKey;
  try {
    derivedKey = deriveKey(passphraseBytes, salt, parameters);
    const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);
    decipher.setAAD(Buffer.from(BACKUP_MASTER_RECOVERY_ENVELOPE_HEADER, "ascii"));
    decipher.setAuthTag(tag);
    const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (key.length !== KEY_BYTES) {
      key.fill(0);
      fail(
        "BACKUP_RECOVERY_ENVELOPE_INVALID",
        "The recovered backup master key is invalid."
      );
    }
    return key;
  } catch (error) {
    if (error instanceof BackupMasterRecoveryEnvelopeError) throw error;
    fail(
      "BACKUP_RECOVERY_AUTHENTICATION_FAILED",
      "The recovery envelope could not be authenticated."
    );
  } finally {
    passphraseBytes.fill(0);
    salt.fill(0);
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    derivedKey?.fill(0);
  }
}
