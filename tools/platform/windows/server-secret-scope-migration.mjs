import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { POSTGRESQL_ROLE_FILES } from "../../../quickhack_server/core/database/postgresql-credential.mjs";
import { serverSecretFilePrefix } from "../../../quickhack_server/platform/server-secret-file-format.mjs";
import { createWindowsServerSecretProtector } from "../../../quickhack_server/platform/windows/server-secret-protector.mjs";

const MAX_FILE_BYTES = 64 * 1024;
const SECRET_FILES = Object.freeze([
  ...Object.values(POSTGRESQL_ROLE_FILES).map((name) => Object.freeze({
    relativePath: path.join("security", name),
    kind: "POSTGRESQL_CREDENTIAL",
  })),
  Object.freeze({ relativePath: path.join("security", "backup-master.key"), kind: "BACKUP_MASTER_KEY" }),
  Object.freeze({ relativePath: path.join("security", "qhkey-master.key"), kind: "QHKEY_MASTER_KEY" }),
  Object.freeze({ relativePath: path.join("security", "totp", "master.key"), kind: "OTP_MASTER_KEY" }),
  Object.freeze({ relativePath: path.join("security", "mobile-device", "serial-hmac.key"), kind: "MOBILE_SERIAL_HMAC" }),
]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseProtectedFile(source, kind, metadata) {
  const prefix = serverSecretFilePrefix(kind, metadata);
  if (!source.startsWith(prefix) || !source.endsWith("\n")) return null;
  const encoded = source.slice(prefix.length, -1);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw failure("LEGACY_CREDENTIAL_FORMAT_INVALID", "Legacy credential payload is not canonical base64.");
  }
  const payload = Buffer.from(encoded, "base64");
  if (payload.length === 0 || payload.toString("base64") !== encoded) {
    payload.fill(0);
    throw failure("LEGACY_CREDENTIAL_FORMAT_INVALID", "Legacy credential payload is invalid.");
  }
  return payload;
}

async function regularFile(filename) {
  const stat = await fs.lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    throw failure("LEGACY_CREDENTIAL_PATH_AMBIGUOUS", "Legacy credential path is not a bounded regular file.");
  }
  return true;
}

function protectors(input) {
  return {
    source: input?.sourceProtector ?? createWindowsServerSecretProtector({ scope: "CURRENT_USER" }).protector,
    target: input?.targetProtector ?? createWindowsServerSecretProtector({ scope: "LOCAL_MACHINE" }).protector,
  };
}

export async function inspectWindowsServerSecretScopes(input) {
  const dataDir = path.resolve(String(input?.dataDir ?? ""));
  const { source, target } = protectors(input);
  const files = [];
  for (const descriptor of SECRET_FILES) {
    const filename = path.resolve(dataDir, descriptor.relativePath);
    if (!(await regularFile(filename))) continue;
    const sourceText = await fs.readFile(filename, "utf8");
    const targetPayload = parseProtectedFile(sourceText, descriptor.kind, target.metadata);
    if (targetPayload) {
      targetPayload.fill(0);
      files.push(Object.freeze({ ...descriptor, filename, scope: "LOCAL_MACHINE" }));
      continue;
    }
    const sourcePayload = parseProtectedFile(sourceText, descriptor.kind, source.metadata);
    if (!sourcePayload) {
      throw failure("LEGACY_CREDENTIAL_FORMAT_INVALID", "Legacy credential uses an unsupported protection scope.");
    }
    sourcePayload.fill(0);
    files.push(Object.freeze({ ...descriptor, filename, scope: "CURRENT_USER" }));
  }
  return Object.freeze(files);
}

export async function migrateWindowsServerSecretScope(input) {
  const { source, target } = protectors(input);
  const files = await inspectWindowsServerSecretScopes({ ...input, sourceProtector: source, targetProtector: target });
  const migrated = [];
  for (const descriptor of files) {
    if (descriptor.scope === "LOCAL_MACHINE") continue;
    const sourceText = await fs.readFile(descriptor.filename, "utf8");
    let sourcePayload;
    let plaintext;
    let targetPayload;
    let verified;
    let output;
    const temporary = `${descriptor.filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      sourcePayload = parseProtectedFile(sourceText, descriptor.kind, source.metadata);
      plaintext = await source.unprotect(descriptor.kind, sourcePayload);
      targetPayload = await target.protect(descriptor.kind, plaintext);
      verified = await target.unprotect(descriptor.kind, targetPayload);
      if (!Buffer.isBuffer(verified) || !verified.equals(plaintext)) {
        throw failure("LEGACY_CREDENTIAL_REPROTECT_FAILED", "Machine-scope credential verification failed.");
      }
      output = Buffer.from(
        `${serverSecretFilePrefix(descriptor.kind, target.metadata)}${targetPayload.toString("base64")}\n`,
        "utf8"
      );
      await target.ensureDirectory(path.dirname(descriptor.filename));
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(output);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, descriptor.filename);
      migrated.push(descriptor.relativePath.replaceAll(path.sep, "/"));
    } finally {
      sourcePayload?.fill(0);
      plaintext?.fill(0);
      targetPayload?.fill(0);
      verified?.fill(0);
      output?.fill(0);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  const after = await inspectWindowsServerSecretScopes({
    ...input,
    sourceProtector: source,
    targetProtector: target,
  });
  if (after.some((descriptor) => descriptor.scope !== "LOCAL_MACHINE")) {
    throw failure("LEGACY_CREDENTIAL_REPROTECT_FAILED", "A legacy credential was not reprotected.");
  }
  return Object.freeze({ inspected: after.length, migrated: Object.freeze(migrated.sort()) });
}

export const WINDOWS_SERVER_SECRET_MIGRATION_FILES = SECRET_FILES;
