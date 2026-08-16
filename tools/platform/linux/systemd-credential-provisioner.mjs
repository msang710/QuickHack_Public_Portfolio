import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { assertServerSecretIdentity } from "../../../quickhack_server/platform/server-secret-identity.mjs";
import { runSystemdCredentialProcess } from "./systemd-credential-process.mjs";

export const QUICKHACK_SYSTEMD_CREDENTIAL_DIRECTORY =
  "/var/lib/quickhack/security";
export const SYSTEMD_PERSISTENT_HOST_KEY_PATH =
  "/var/lib/systemd/credential.secret";

export class SystemdCredentialProvisioningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SystemdCredentialProvisioningError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SystemdCredentialProvisioningError(code, message);
}

function canonicalEncryptedCredential(value) {
  const normalized = value.toString("utf8").replace(/\s+/gu, "");
  if (
    !normalized ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      normalized
    )
  ) {
    fail(
      "SYSTEMD_CREDENTIAL_CIPHERTEXT_INVALID",
      "systemd-creds returned an invalid encrypted credential."
    );
  }
  const decoded = Buffer.from(normalized, "base64");
  const canonical = decoded.toString("base64");
  decoded.fill(0);
  if (canonical !== normalized) {
    fail(
      "SYSTEMD_CREDENTIAL_CIPHERTEXT_INVALID",
      "systemd-creds returned a non-canonical encrypted credential."
    );
  }
  return Buffer.from(`${canonical}\n`, "utf8");
}

async function pathExists(target, lstat = fsPromises.lstat) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function systemdCredentialCiphertextPath(identityValue) {
  const identity = assertServerSecretIdentity(identityValue);
  return path.posix.join(
    QUICKHACK_SYSTEMD_CREDENTIAL_DIRECTORY,
    `${identity.id}.cred`
  );
}

export function createSystemdCredentialProvisioner(options = {}) {
  const run = options.run ?? runSystemdCredentialProcess;
  const getuid = options.getuid ?? process.getuid?.bind(process);
  const fileSystem = options.fileSystem ?? fsPromises;
  const platform = options.platform ?? process.platform;

  function requireRoot() {
    if (platform !== "linux") {
      fail(
        "SYSTEMD_CREDENTIAL_PLATFORM_UNSUPPORTED",
        "systemd credential provisioning is available only on Linux."
      );
    }
    if (typeof getuid !== "function" || getuid() !== 0) {
      fail(
        "SYSTEMD_CREDENTIAL_ROOT_REQUIRED",
        "Administrator authentication is required to provision server credentials."
      );
    }
  }

  async function preflight() {
    requireRoot();
    const versionOutput = await run(["--version"]);
    const match = versionOutput.toString("utf8").match(/systemd\s+(\d+)/u);
    versionOutput.fill(0);
    if (!match || Number(match[1]) < 250) {
      fail(
        "DEPENDENCY_VERSION_MISMATCH",
        "QuickHack requires systemd 250 or newer for encrypted credentials."
      );
    }
    const keyHelp = await run(["encrypt", "--with-key=help"]);
    const supportsAuto = /(?:^|\s)auto(?:\s|$)/u.test(keyHelp.toString("utf8"));
    keyHelp.fill(0);
    if (!supportsAuto) {
      fail(
        "DEPENDENCY_VERSION_MISMATCH",
        "This systemd-creds build does not support the required auto key mode."
      );
    }
    const persistentHostKey = await pathExists(
      SYSTEMD_PERSISTENT_HOST_KEY_PATH,
      fileSystem.lstat?.bind(fileSystem)
    );
    let tpm2 = false;
    try {
      const output = await run(["has-tpm2"]);
      tpm2 = /(?:^|\s)yes(?:\s|$)/iu.test(output.toString("utf8"));
      output.fill(0);
    } catch {
      tpm2 = false;
    }
    if (!tpm2 && !persistentHostKey) {
      fail(
        "SYSTEMD_CREDENTIAL_HOST_KEY_REQUIRED",
        "No TPM2 or persistent systemd host key is available."
      );
    }
    return Object.freeze({
      version: Number(match[1]),
      keyMode: tpm2 ? "AUTO_TPM2_OR_HOST" : "HOST_KEY_ONLY",
    });
  }

  async function prepare({ identity: identityValue, secret }) {
    requireRoot();
    const identity = assertServerSecretIdentity(identityValue);
    if (!Buffer.isBuffer(secret) || secret.length === 0 || secret.length > identity.maxBytes) {
      fail(
        "SYSTEMD_CREDENTIAL_SECRET_INVALID",
        "The server credential payload is invalid."
      );
    }
    await preflight();
    const encryptedOutput = await run(
      ["encrypt", "--with-key=auto", `--name=${identity.id}`, "-", "-"],
      { input: secret }
    );
    let ciphertext;
    let decrypted;
    let preparedPath = "";
    try {
      ciphertext = canonicalEncryptedCredential(encryptedOutput);
      decrypted = await run(
        ["decrypt", `--name=${identity.id}`, "-", "-"],
        { input: ciphertext }
      );
      if (decrypted.length !== secret.length || !decrypted.equals(secret)) {
        fail(
          "SYSTEMD_CREDENTIAL_VERIFY_FAILED",
          "The encrypted credential could not be verified."
        );
      }
      await fileSystem.mkdir(QUICKHACK_SYSTEMD_CREDENTIAL_DIRECTORY, {
        recursive: true,
        mode: 0o700,
      });
      await fileSystem.chmod(QUICKHACK_SYSTEMD_CREDENTIAL_DIRECTORY, 0o700);
      const directoryStat = await fileSystem.lstat(
        QUICKHACK_SYSTEMD_CREDENTIAL_DIRECTORY
      );
      if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        (Number.isInteger(directoryStat.uid) && directoryStat.uid !== 0)
      ) {
        fail(
          "SYSTEMD_CREDENTIAL_DIRECTORY_INVALID",
          "The encrypted credential directory must be a root-owned regular directory."
        );
      }
      const generationId = randomUUID();
      const targetPath = systemdCredentialCiphertextPath(identity);
      preparedPath = path.posix.join(
        QUICKHACK_SYSTEMD_CREDENTIAL_DIRECTORY,
        `.${identity.id}.${generationId}.prepared`
      );
      const handle = await fileSystem.open(preparedPath, "wx", 0o600);
      try {
        await handle.writeFile(ciphertext);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fileSystem.chmod(preparedPath, 0o600);
      return Object.freeze({
        state: "PREPARED",
        generationId,
        identityId: identity.id,
        preparedPath,
        targetPath,
      });
    } catch (error) {
      if (preparedPath) {
        await fileSystem.rm(preparedPath, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      encryptedOutput.fill(0);
      ciphertext?.fill(0);
      decrypted?.fill(0);
    }
  }

  async function commit(token) {
    requireRoot();
    if (token?.state !== "PREPARED") {
      fail("SYSTEMD_CREDENTIAL_STATE_INVALID", "Only a prepared credential can be committed.");
    }
    const backupPath = `${token.targetPath}.${token.generationId}.rollback`;
    const previousExists = await pathExists(
      token.targetPath,
      fileSystem.lstat?.bind(fileSystem)
    );
    if (previousExists) await fileSystem.link(token.targetPath, backupPath);
    try {
      await fileSystem.rename(token.preparedPath, token.targetPath);
    } catch (error) {
      if (previousExists) await fileSystem.rm(backupPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return Object.freeze({
      ...token,
      state: "COMMITTED_RESTART_REQUIRED",
      previousExists,
      backupPath: previousExists ? backupPath : "",
    });
  }

  async function discard(token) {
    requireRoot();
    if (token?.state !== "PREPARED") {
      fail("SYSTEMD_CREDENTIAL_STATE_INVALID", "Only a prepared credential can be discarded.");
    }
    await fileSystem.rm(token.preparedPath, { force: true });
    return Object.freeze({
      state: "DISCARDED",
      generationId: token.generationId,
      identityId: token.identityId,
    });
  }

  async function activate(token) {
    requireRoot();
    if (token?.state !== "COMMITTED_RESTART_REQUIRED") {
      fail("SYSTEMD_CREDENTIAL_STATE_INVALID", "Only a committed credential can be activated.");
    }
    if (token.backupPath) await fileSystem.rm(token.backupPath, { force: true });
    return Object.freeze({
      state: "ACTIVE",
      generationId: token.generationId,
      identityId: token.identityId,
    });
  }

  async function rollback(token) {
    requireRoot();
    if (token?.state !== "COMMITTED_RESTART_REQUIRED") {
      fail("SYSTEMD_CREDENTIAL_STATE_INVALID", "Only a committed credential can be rolled back.");
    }
    if (token.previousExists) {
      await fileSystem.rename(token.backupPath, token.targetPath);
    } else {
      await fileSystem.rm(token.targetPath, { force: true });
    }
    return Object.freeze({
      state: "ROLLED_BACK",
      generationId: token.generationId,
      identityId: token.identityId,
    });
  }

  return Object.freeze({ preflight, prepare, commit, discard, activate, rollback });
}
