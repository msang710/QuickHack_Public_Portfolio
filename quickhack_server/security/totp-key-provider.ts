import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  getServerSecretProtector,
} from "@/quickhack_server/platform/server-runtime";
import type { ServerSecretProtector } from "@/quickhack_server/platform/contracts";
import {
  publicConflict,
  publicUnavailable,
} from "@/quickhack_server/core/public-error";
import { getDataDir } from "@/quickhack_shared/core/runtime";
import { serverSecretFilePrefix } from "../platform/server-secret-file-format.mjs";
import { serverSecretIdentity } from "../platform/server-secret-identity.mjs";

const TOTP_KEY_BYTES = 32;
const TOTP_KEY_FILE_MAX_BYTES = 4_096;

export type TotpKeyState =
  | "READY"
  | "CREDENTIALS_REQUIRE_EXISTING_KEY"
  | "INVALID_KEY_FILE"
  | "CREATE_FAILED"
  | "PROVISIONING_REQUIRED"
  | "UNSUPPORTED_PLATFORM";

export type TotpKeyStatus = {
  state: TotpKeyState;
  configured: boolean;
  protection: string | null;
};

type TotpKeyProviderInput = {
  dataDir?: string;
  credentialCount?: () => Promise<number>;
  randomBytes?: (size: number) => Buffer;
  secretProtector?: ServerSecretProtector;
};

type InitializationResult = {
  status: TotpKeyStatus;
  key: Buffer | null;
};

function readyStatus(protection: string): TotpKeyStatus {
  return {
    state: "READY",
    configured: true,
    protection,
  };
}

function unavailableStatus(state: Exclude<TotpKeyState, "READY">): TotpKeyStatus {
  return {
    state,
    configured: false,
    protection: null,
  };
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isExistingFileError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function decodeProtectedPayload(text: string, filePrefix: string) {
  if (!text.startsWith(filePrefix)) {
    throw new Error("The OTP key file format is not recognized.");
  }

  const encoded = text.slice(filePrefix.length).trim();

  if (
    !encoded ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded
    )
  ) {
    throw new Error("The OTP key file payload is invalid.");
  }

  const payload = Buffer.from(encoded, "base64");

  if (payload.toString("base64") !== encoded) {
    payload.fill(0);
    throw new Error("The OTP key file payload is not canonical base64.");
  }

  return payload;
}

export function defaultTotpKeyFilePath(dataDir = getDataDir()) {
  return path.join(dataDir, "security", "totp", "master.key");
}

export class TotpKeyProvider {
  private readonly dataDir: string;
  private readonly credentialCount: () => Promise<number>;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly secretProtector: ServerSecretProtector;
  private initialization: Promise<InitializationResult> | null = null;
  private recovery: Promise<TotpKeyStatus> | null = null;

  constructor(input: TotpKeyProviderInput = {}) {
    this.dataDir = input.dataDir ?? getDataDir();
    this.secretProtector = input.secretProtector ?? getServerSecretProtector();
    this.credentialCount =
      input.credentialCount ??
      (() => prisma.user_totp_credentials.count());
    this.randomBytes = input.randomBytes ?? crypto.randomBytes;
  }

  keyFilePath() {
    return defaultTotpKeyFilePath(this.dataDir);
  }

  private async readKeyFile(filePath: string) {
    const stats = await fs.lstat(filePath);

    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("The OTP key path is not a regular file.");
    }

    if (stats.size <= 0 || stats.size > TOTP_KEY_FILE_MAX_BYTES) {
      throw new Error("The OTP key file size is invalid.");
    }

    const filePayload = await fs.readFile(filePath);
    let protectedPayload: Buffer | null = null;

    try {
      const filePrefix = serverSecretFilePrefix(
        "OTP_MASTER_KEY",
        this.secretProtector.metadata
      );
      protectedPayload = decodeProtectedPayload(
        filePayload.toString("utf8"),
        filePrefix
      );
      const key = await this.secretProtector.unprotect(
        "OTP_MASTER_KEY",
        protectedPayload
      );

      if (key.length !== TOTP_KEY_BYTES) {
        key.fill(0);
        throw new Error("The unprotected OTP key length is invalid.");
      }

      return key;
    } finally {
      filePayload.fill(0);
      protectedPayload?.fill(0);
    }
  }

  private async readExistingKey(filePath: string) {
    try {
      return await this.readKeyFile(filePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  private async createKeyFile(filePath: string) {
    const directoryPath = path.dirname(filePath);
    await this.secretProtector.ensureDirectory(directoryPath);

    const candidateKey = this.randomBytes(TOTP_KEY_BYTES);
    let protectedPayload: Buffer | null = null;
    let filePayload: Buffer | null = null;
    const temporaryPath = path.join(
      directoryPath,
      `.master.key.${process.pid}.${crypto.randomUUID()}.tmp`
    );

    try {
      if (candidateKey.length !== TOTP_KEY_BYTES) {
        throw new Error("The OTP key generator returned an invalid key length.");
      }

      protectedPayload = await this.secretProtector.protect(
        "OTP_MASTER_KEY",
        candidateKey
      );
      const filePrefix = serverSecretFilePrefix(
        "OTP_MASTER_KEY",
        this.secretProtector.metadata
      );
      filePayload = Buffer.from(
        `${filePrefix}${protectedPayload.toString("base64")}\n`,
        "utf8"
      );

      const handle = await fs.open(temporaryPath, "wx", 0o600);

      try {
        await handle.writeFile(filePayload);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await fs.link(temporaryPath, filePath);
      } catch (error) {
        if (!isExistingFileError(error)) {
          throw error;
        }
      }

      return await this.readKeyFile(filePath);
    } finally {
      candidateKey.fill(0);
      protectedPayload?.fill(0);
      filePayload?.fill(0);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async initializeInternal(): Promise<InitializationResult> {
    if (this.secretProtector.descriptor.state !== "READY") {
      return {
        status: unavailableStatus("UNSUPPORTED_PLATFORM"),
        key: null,
      };
    }

    if (this.secretProtector.metadata.lifecycle === "ACTIVATION_CREDENTIAL") {
      try {
        const key = await this.secretProtector.readProvisioned(
          serverSecretIdentity({ kind: "OTP_MASTER_KEY" })
        );
        if (!Buffer.isBuffer(key) || key.length !== TOTP_KEY_BYTES) {
          if (Buffer.isBuffer(key)) key.fill(0);
          return {
            status: unavailableStatus("INVALID_KEY_FILE"),
            key: null,
          };
        }
        return {
          status: readyStatus(this.secretProtector.metadata.protection),
          key,
        };
      } catch (error) {
        let credentialCount = 0;
        try {
          credentialCount = await this.credentialCount();
        } catch {
          return {
            status: unavailableStatus("CREATE_FAILED"),
            key: null,
          };
        }
        if (credentialCount > 0) {
          return {
            status: unavailableStatus("CREDENTIALS_REQUIRE_EXISTING_KEY"),
            key: null,
          };
        }
        return {
          status: unavailableStatus(
            typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "SERVER_SECRET_PROVISIONING_REQUIRED"
              ? "PROVISIONING_REQUIRED"
              : "INVALID_KEY_FILE"
          ),
          key: null,
        };
      }
    }

    const filePath = this.keyFilePath();

    try {
      const existingKey = await this.readExistingKey(filePath);

      if (existingKey) {
        return {
          status: readyStatus(this.secretProtector.metadata.protection),
          key: existingKey,
        };
      }
    } catch {
      return {
        status: unavailableStatus("INVALID_KEY_FILE"),
        key: null,
      };
    }

    let credentialCount = 0;

    try {
      credentialCount = await this.credentialCount();
    } catch {
      return {
        status: unavailableStatus("CREATE_FAILED"),
        key: null,
      };
    }

    if (credentialCount > 0) {
      return {
        status: unavailableStatus("CREDENTIALS_REQUIRE_EXISTING_KEY"),
        key: null,
      };
    }

    try {
      const key = await this.createKeyFile(filePath);
      return {
        status: readyStatus(this.secretProtector.metadata.protection),
        key,
      };
    } catch {
      return {
        status: unavailableStatus("CREATE_FAILED"),
        key: null,
      };
    }
  }

  private initialize() {
    this.initialization ??= this.initializeInternal();
    return this.initialization;
  }

  private async discardCachedInitialization() {
    const initialized = this.initialization
      ? await this.initialization.catch(() => null)
      : null;

    initialized?.key?.fill(0);
    this.initialization = null;
  }

  private async quarantineUnusableKeyFile() {
    const filePath = this.keyFilePath();
    const quarantinePath = path.join(
      path.dirname(filePath),
      `master.key.unusable.${Date.now()}.${crypto.randomUUID()}`
    );

    try {
      await fs.rename(filePath, quarantinePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  private async recoverAfterCredentialsClearedInternal() {
    const credentialCount = await this.credentialCount();

    if (credentialCount !== 0) {
      throw publicConflict(
        "TOTP_CREDENTIALS_REMAIN",
        "OTP 등록 정보가 남아 있어 서버 소유 키를 다시 만들 수 없습니다."
      );
    }

    const previous = await this.initialize();

    if (previous.status.configured) {
      return previous.status;
    }

    await this.discardCachedInitialization();

    if (this.secretProtector.metadata.lifecycle === "ACTIVATION_CREDENTIAL") {
      return (await this.initialize()).status;
    }

    if (previous.status.state === "INVALID_KEY_FILE") {
      await this.quarantineUnusableKeyFile();
    }

    let recovered = await this.initialize();

    // A failed first creation can leave a file that is present but unreadable.
    // With no encrypted credentials left, quarantining it is safe and makes the
    // next attempt deterministic without ever overwriting a live credential key.
    if (recovered.status.state === "INVALID_KEY_FILE") {
      await this.discardCachedInitialization();
      await this.quarantineUnusableKeyFile();
      recovered = await this.initialize();
    }

    return recovered.status;
  }

  async getStatus() {
    if (this.recovery) {
      return this.recovery;
    }

    return (await this.initialize()).status;
  }

  async withKey<T>(operation: (key: Buffer) => T | Promise<T>) {
    if (this.recovery) {
      await this.recovery;
    }

    const initialized = await this.initialize();

    if (!initialized.status.configured || !initialized.key) {
      throw publicUnavailable(
        "TOTP_SERVICE_UNAVAILABLE",
        "OTP 보안 서비스를 사용할 수 없어 보호된 작업을 진행할 수 없습니다."
      );
    }

    const key = Buffer.from(initialized.key);

    try {
      return await operation(key);
    } finally {
      key.fill(0);
    }
  }

  recoverAfterCredentialsCleared() {
    this.recovery ??= this.recoverAfterCredentialsClearedInternal().finally(
      () => {
        this.recovery = null;
      }
    );
    return this.recovery;
  }
}

const totpKeyProvider = new TotpKeyProvider();

export function getTotpKeyStatus() {
  return totpKeyProvider.getStatus();
}

export async function requireTotpKeyReady() {
  await totpKeyProvider.withKey(() => undefined);
}

export function withTotpEncryptionKey<T>(
  operation: (key: Buffer) => T | Promise<T>
) {
  return totpKeyProvider.withKey(operation);
}

export function recoverTotpKeyAfterCredentialsCleared() {
  return totpKeyProvider.recoverAfterCredentialsCleared();
}
