import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { defaultBackupKeyFilePath } from "../../../quickhack_server/security/backup-key-provider-core.mjs";
import { serverSecretFilePrefix } from "../../../quickhack_server/platform/server-secret-file-format.mjs";
import { getServerSecretProtector } from "../../../quickhack_server/platform/server-runtime.ts";

function decodeFilePayload(source, prefix) {
  if (!source.startsWith(prefix) || !source.endsWith("\n")) {
    throw new Error("The Windows backup master key file format is invalid.");
  }
  const encoded = source.slice(prefix.length, -1);
  const payload = Buffer.from(encoded, "base64");
  if (!encoded || payload.toString("base64") !== encoded) {
    payload.fill(0);
    throw new Error("The Windows backup master key payload is invalid.");
  }
  return payload;
}

export function createWindowsBackupMasterRecoveryOperator(options) {
  const dataDir = path.resolve(String(options?.dataDir ?? ""));
  const protector = options?.secretProtector ?? getServerSecretProtector();
  const fileSystem = options?.fileSystem ?? fs;
  const targetPath = defaultBackupKeyFilePath(dataDir);
  if (!options?.dataDir || protector.metadata.lifecycle !== "OPAQUE_PAYLOAD") {
    throw new TypeError("A Windows opaque-payload backup recovery target is required.");
  }

  async function verify(expectedKey) {
    const filePayload = await fileSystem.readFile(targetPath, "utf8");
    let protectedPayload;
    let key;
    try {
      protectedPayload = decodeFilePayload(
        filePayload,
        serverSecretFilePrefix("BACKUP_MASTER_KEY", protector.metadata)
      );
      key = await protector.unprotect("BACKUP_MASTER_KEY", protectedPayload);
      return Buffer.isBuffer(key) && key.length === 32 && key.equals(expectedKey);
    } finally {
      protectedPayload?.fill(0);
      key?.fill(0);
    }
  }

  async function provision(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new TypeError("The backup master recovery key is invalid.");
    }
    const directory = path.dirname(targetPath);
    await protector.ensureDirectory(directory);
    let protectedPayload;
    let filePayload;
    const temporaryPath = path.join(
      directory,
      `.backup-master.recovery.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    try {
      protectedPayload = await protector.protect("BACKUP_MASTER_KEY", key);
      filePayload = Buffer.from(
        `${serverSecretFilePrefix("BACKUP_MASTER_KEY", protector.metadata)}${protectedPayload.toString("base64")}\n`,
        "utf8"
      );
      const handle = await fileSystem.open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(filePayload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fileSystem.link(temporaryPath, targetPath);
      if (!(await verify(key))) {
        await fileSystem.rm(targetPath, { force: true });
        throw new Error("The restored Windows backup master key failed verification.");
      }
      return Object.freeze({ state: "ACTIVE", targetPath });
    } finally {
      protectedPayload?.fill(0);
      filePayload?.fill(0);
      await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  return Object.freeze({ provision, verify, targetPath: () => targetPath });
}
