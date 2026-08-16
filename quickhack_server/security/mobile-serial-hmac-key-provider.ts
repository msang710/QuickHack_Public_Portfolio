import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/quickhack_server/core/prisma";
import { publicUnavailable } from "@/quickhack_server/core/public-error";
import { getServerSecretProtector } from "@/quickhack_server/platform/server-runtime";
import type { ServerSecretProtector } from "@/quickhack_server/platform/contracts";
import {
  getDataDir,
  isProductionRuntime,
} from "@/quickhack_shared/core/runtime";
import { serverSecretFilePrefix } from "../platform/server-secret-file-format.mjs";
import { serverSecretIdentity } from "../platform/server-secret-identity.mjs";

const KEY_BYTES = 32;
const MAX_FILE_BYTES = 4096;
const DEVELOPMENT_POSIX_PREFIX = "QHMOBILESERIAL2\nDEVELOPMENT_POSIX_OWNER_ONLY\n";

export type MobileSerialHmacKeyAccess = {
  withKey<T>(operation: (key: Buffer) => T | Promise<T>): Promise<T>;
};

type ProviderOptions = {
  dataDir?: string;
  production?: boolean;
  liveRegistrationCount?: () => Promise<number>;
  randomBytes?: (size: number) => Buffer;
  secretProtector?: ServerSecretProtector;
};

function isCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function decodeCanonicalBase64(value: string) {
  const encoded = value.trim();
  const payload = Buffer.from(encoded, "base64");
  if (!encoded || payload.toString("base64") !== encoded) {
    payload.fill(0);
    throw new Error("Mobile serial HMAC key payload is invalid.");
  }
  return payload;
}

export class MobileSerialHmacKeyProvider implements MobileSerialHmacKeyAccess {
  private readonly dataDir: string;
  private readonly production: boolean;
  private readonly liveRegistrationCount: () => Promise<number>;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly secretProtector: ServerSecretProtector;
  private initialization: Promise<Buffer> | null = null;

  constructor(options: ProviderOptions = {}) {
    this.dataDir = options.dataDir ?? getDataDir();
    this.secretProtector =
      options.secretProtector ?? getServerSecretProtector();
    this.production = options.production ?? isProductionRuntime();
    this.liveRegistrationCount =
      options.liveRegistrationCount ??
      (() =>
        prisma.mobile_registered_devices.count({
          where: { registration_state: { in: ["PROVISIONING", "ACTIVE"] } },
        }));
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
  }

  keyFilePath() {
    return path.join(this.dataDir, "security", "mobile-device", "serial-hmac.key");
  }

  private async readExisting(filePath: string) {
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) {
        throw new Error("Mobile serial HMAC key path is not a valid regular file.");
      }
      const protectedMode =
        this.secretProtector.descriptor.state === "READY" &&
        this.secretProtector.metadata.lifecycle === "OPAQUE_PAYLOAD";
      if (!protectedMode && (stat.mode & 0o077) !== 0) {
        throw new Error("Mobile serial HMAC key permissions must be owner-only.");
      }
      const filePayload = await fs.readFile(filePath, "utf8");
      let encoded: Buffer | null = null;
      try {
        const protectedPrefix = serverSecretFilePrefix(
          "MOBILE_SERIAL_HMAC",
          this.secretProtector.metadata
        );
        if (filePayload.startsWith(protectedPrefix) && protectedMode) {
          encoded = decodeCanonicalBase64(
            filePayload.slice(protectedPrefix.length)
          );
          return await this.secretProtector.unprotect(
            "MOBILE_SERIAL_HMAC",
            encoded
          );
        }
        if (
          filePayload.startsWith(DEVELOPMENT_POSIX_PREFIX) &&
          !protectedMode &&
          !this.production
        ) {
          return decodeCanonicalBase64(
            filePayload.slice(DEVELOPMENT_POSIX_PREFIX.length)
          );
        }
        throw new Error("Mobile serial HMAC key format is not valid for this runtime.");
      } finally {
        encoded?.fill(0);
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  private async create(filePath: string) {
    const protectedMode =
      this.secretProtector.descriptor.state === "READY" &&
      this.secretProtector.metadata.lifecycle === "OPAQUE_PAYLOAD";
    if (!protectedMode && this.production) {
      throw new Error("Production Linux requires an external protected-key provider.");
    }
    const directory = path.dirname(filePath);
    if (protectedMode) {
      await this.secretProtector.ensureDirectory(directory);
    } else {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
    }

    const key = this.randomBytes(KEY_BYTES);
    if (key.length !== KEY_BYTES) throw new Error("Invalid HMAC key length.");
    let protectedPayload: Buffer | null = null;
    try {
      protectedPayload =
        protectedMode
          ? await this.secretProtector.protect("MOBILE_SERIAL_HMAC", key)
          : Buffer.from(key);
      const prefix =
        protectedMode
          ? serverSecretFilePrefix(
              "MOBILE_SERIAL_HMAC",
              this.secretProtector.metadata
            )
          : DEVELOPMENT_POSIX_PREFIX;
      await fs.writeFile(
        filePath,
        `${prefix}${protectedPayload.toString("base64")}\n`,
        { flag: "wx", mode: 0o600 }
      );
      return key;
    } catch (error) {
      key.fill(0);
      if (isCode(error, "EEXIST")) {
        const existing = await this.readExisting(filePath);
        if (existing) return existing;
      }
      throw error;
    } finally {
      protectedPayload?.fill(0);
    }
  }

  private async initialize() {
    if (
      this.secretProtector.descriptor.state !== "READY" &&
      this.production
    ) {
      throw new Error("Production Linux requires an external protected-key provider.");
    }
    if (this.secretProtector.metadata.lifecycle === "ACTIVATION_CREDENTIAL") {
      try {
        const key = await this.secretProtector.readProvisioned(
          serverSecretIdentity({ kind: "MOBILE_SERIAL_HMAC" })
        );
        if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
          if (Buffer.isBuffer(key)) key.fill(0);
          throw new Error("The provisioned mobile serial HMAC key is invalid.");
        }
        return key;
      } catch {
        const liveCount = await this.liveRegistrationCount();
        if (liveCount > 0) {
          throw new Error(
            "Live registrations require the existing mobile serial HMAC credential."
          );
        }
        throw new Error(
          "The mobile serial HMAC credential requires privileged provisioning."
        );
      }
    }
    const filePath = this.keyFilePath();
    let existing: Buffer | null = null;
    let readError: unknown = null;
    try {
      existing = await this.readExisting(filePath);
      if (existing) {
        if (existing.length !== KEY_BYTES) {
          existing.fill(0);
          throw new Error("Mobile serial HMAC key length is invalid.");
        }
        return existing;
      }
    } catch (error) {
      readError = error;
    }
    const liveCount = await this.liveRegistrationCount();
    if (liveCount > 0) {
      throw new Error("Live registrations require the existing mobile serial HMAC key.");
    }
    if (readError) {
      const quarantinePath = `${filePath}.unusable.${Date.now()}.${crypto.randomUUID()}`;
      try {
        await fs.rename(filePath, quarantinePath);
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    }
    return this.create(filePath);
  }

  async withKey<T>(operation: (key: Buffer) => T | Promise<T>) {
    try {
      this.initialization ??= this.initialize();
      const cached = await this.initialization;
      const key = Buffer.from(cached);
      try {
        return await operation(key);
      } finally {
        key.fill(0);
      }
    } catch {
      this.initialization = null;
      throw publicUnavailable(
        "MOBILE_SERIAL_KEY_UNAVAILABLE",
        "모바일 기기 식별 키를 사용할 수 없어 기기 등록과 포장 검증을 차단했습니다."
      );
    }
  }
}

const provider = new MobileSerialHmacKeyProvider();

export function withMobileSerialHmacKey<T>(
  operation: (key: Buffer) => T | Promise<T>
) {
  return provider.withKey(operation);
}
