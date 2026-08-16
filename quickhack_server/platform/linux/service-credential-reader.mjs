import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { assertServerSecretIdentity } from "../server-secret-identity.mjs";

export class LinuxServiceCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LinuxServiceCredentialError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LinuxServiceCredentialError(code, message);
}

function credentialPath(identity, environment) {
  const credentialDirectory = String(
    environment?.CREDENTIALS_DIRECTORY ?? ""
  ).trim();
  if (!path.isAbsolute(credentialDirectory)) {
    fail(
      "SERVER_SECRET_PROVISIONING_REQUIRED",
      "The systemd service credential directory is not available."
    );
  }
  return path.join(credentialDirectory, identity.id);
}

function validateStat(stat, identity, platform) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > identity.maxBytes ||
    (platform === "linux" &&
      Number.isInteger(stat.mode) &&
      (stat.mode & 0o077) !== 0)
  ) {
    fail(
      "SERVER_SECRET_PROVISIONED_INVALID",
      "A provisioned server credential has an invalid file type or payload size."
    );
  }
}

function validatePayload(payload, identity) {
  if (
    !Buffer.isBuffer(payload) ||
    payload.length === 0 ||
    (identity.kind === "POSTGRESQL_CREDENTIAL" && payload.includes(0))
  ) {
    if (Buffer.isBuffer(payload)) payload.fill(0);
    fail(
      "SERVER_SECRET_PROVISIONED_INVALID",
      "A provisioned server credential has an invalid payload."
    );
  }
  return payload;
}

export function createLinuxServiceCredentialReader(options = {}) {
  const environment = options.environment ?? process.env;
  const readFile = options.readFile ?? fsPromises.readFile;
  const lstat = options.lstat ?? fsPromises.lstat;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const lstatSync = options.lstatSync ?? fs.lstatSync;
  const platform = options.platform ?? "linux";

  async function read(identityValue) {
    const identity = assertServerSecretIdentity(identityValue);
    const filePath = credentialPath(identity, environment);
    try {
      validateStat(await lstat(filePath), identity, platform);
      return validatePayload(await readFile(filePath), identity);
    } catch (error) {
      if (error instanceof LinuxServiceCredentialError) throw error;
      if (error?.code === "ENOENT" || error?.code === "EACCES") {
        fail(
          "SERVER_SECRET_PROVISIONING_REQUIRED",
          "A required systemd service credential is not provisioned."
        );
      }
      fail(
        "SERVER_SECRET_PROVISIONED_UNAVAILABLE",
        "A systemd service credential could not be read."
      );
    }
  }

  function readSync(identityValue) {
    const identity = assertServerSecretIdentity(identityValue);
    const filePath = credentialPath(identity, environment);
    try {
      validateStat(lstatSync(filePath), identity, platform);
      return validatePayload(readFileSync(filePath), identity);
    } catch (error) {
      if (error instanceof LinuxServiceCredentialError) throw error;
      if (error?.code === "ENOENT" || error?.code === "EACCES") {
        fail(
          "SERVER_SECRET_PROVISIONING_REQUIRED",
          "A required systemd service credential is not provisioned."
        );
      }
      fail(
        "SERVER_SECRET_PROVISIONED_UNAVAILABLE",
        "A systemd service credential could not be read."
      );
    }
  }

  return Object.freeze({ read, readSync });
}
