import { assertServerSecretKind } from "./server-secret-contract.mjs";

const FILE_FORMAT_BASES = Object.freeze({
  OTP_MASTER_KEY: "QHTOTPKEY1",
  BACKUP_MASTER_KEY: "QHBKEY1",
  POSTGRESQL_CREDENTIAL: "QHPG1",
  MOBILE_SERIAL_HMAC: "QHMOBILESERIAL2",
  QHKEY_MASTER_KEY: "QHQHKEYMASTER1",
});

export function serverSecretProtectionFileLabel(metadata) {
  const protection = String(metadata?.protection ?? "").trim();
  if (!protection) {
    throw new TypeError("Server secret protection metadata is required.");
  }
  return protection.startsWith("WINDOWS_") ? protection.slice(8) : protection;
}

export function serverSecretFilePrefix(kind, metadata) {
  const normalizedKind = assertServerSecretKind(kind);
  return `${FILE_FORMAT_BASES[normalizedKind]}\n${serverSecretProtectionFileLabel(metadata)}\n`;
}
