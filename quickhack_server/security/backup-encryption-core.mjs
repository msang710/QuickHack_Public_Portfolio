import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const ENCRYPTED_BACKUP_MAGIC = Buffer.from("QHBK1");
export const BACKUP_ENCRYPTION_ALGORITHM = "aes-256-gcm";
export const BACKUP_ENCRYPTION_KEY_BYTES = 32;

const BACKUP_IV_LENGTH = 12;
const BACKUP_TAG_LENGTH = 16;
const BACKUP_HEADER_LENGTH =
  ENCRYPTED_BACKUP_MAGIC.length + BACKUP_IV_LENGTH + BACKUP_TAG_LENGTH;
const BACKUP_TAG_OFFSET =
  ENCRYPTED_BACKUP_MAGIC.length + BACKUP_IV_LENGTH;
const TEMPORARY_FILE_ORPHAN_GRACE_MS = 5 * 60 * 1000;
const TEMPORARY_FILE_CLEANUP_LIMIT = 128;
const activeTemporaryPaths = new Set();

function backupEncryptionKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== BACKUP_ENCRYPTION_KEY_BYTES) {
    throw new Error("DB 백업 암호화 키는 정확히 32바이트여야 합니다.");
  }

  return Buffer.from(key);
}

function temporaryOutputPath(outputPath) {
  return path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
}

function temporaryFileNamePattern() {
  return new RegExp(
    "^\\.(.+)\\.(\\d+)\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-" +
      "[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$",
    "i"
  );
}

function processIsAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    return true;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function cleanupAbandonedTemporaryFiles(outputPath) {
  const outputDirectory = path.dirname(outputPath);
  const fileNamePattern = temporaryFileNamePattern();
  let directoryHandle;

  try {
    directoryHandle = await fs.opendir(outputDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  let matchedCount = 0;

  try {
    for await (const entry of directoryHandle) {
      const match = fileNamePattern.exec(entry.name);

      if (!match) {
        continue;
      }

      matchedCount += 1;
      if (matchedCount > TEMPORARY_FILE_CLEANUP_LIMIT) {
        break;
      }

      const temporaryPath = path.join(outputDirectory, entry.name);

      if (activeTemporaryPaths.has(temporaryPath)) {
        continue;
      }

      let stats;

      try {
        stats = await fs.lstat(temporaryPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      if (
        stats.isSymbolicLink() ||
        !stats.isFile() ||
        Date.now() - stats.mtimeMs < TEMPORARY_FILE_ORPHAN_GRACE_MS
      ) {
        continue;
      }

      const ownerProcessId = Number.parseInt(match[2], 10);

      // Same-process active paths are tracked exactly. For another process,
      // a live PID (or an indeterminate permission error) is preserved.
      if (
        ownerProcessId !== process.pid &&
        processIsAlive(ownerProcessId)
      ) {
        continue;
      }

      await fs.rm(temporaryPath, { force: true });
    }
  } finally {
    await directoryHandle.close().catch((error) => {
      if (error?.code !== "ERR_DIR_CLOSED") {
        throw error;
      }
    });
  }
}

async function closeFileHandle(fileHandle) {
  if (!fileHandle) {
    return;
  }

  await fileHandle.close().catch((error) => {
    if (error?.code !== "EBADF") {
      throw error;
    }
  });
}

async function writeBufferAt(fileHandle, buffer, position) {
  let offset = 0;

  while (offset < buffer.length) {
    const { bytesWritten } = await fileHandle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );

    if (bytesWritten <= 0) {
      throw new Error("DB backup temporary file could not be written.");
    }

    offset += bytesWritten;
  }
}

async function readBufferAt(fileHandle, buffer, position) {
  let offset = 0;

  while (offset < buffer.length) {
    const { bytesRead } = await fileHandle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );

    if (bytesRead <= 0) {
      break;
    }

    offset += bytesRead;
  }

  return offset;
}

function createFileHandleWriteStream(fileHandle, startPosition) {
  let position = startPosition;

  return new Writable({
    write(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding);

      writeBufferAt(fileHandle, buffer, position)
        .then(() => {
          position += buffer.length;
          callback();
        })
        .catch(callback);
    },
  });
}

async function writeFileAtomically(outputPath, writeTemporaryFile) {
  await cleanupAbandonedTemporaryFiles(outputPath);

  const temporaryPath = temporaryOutputPath(outputPath);
  let temporaryHandle = null;
  activeTemporaryPaths.add(temporaryPath);

  try {
    temporaryHandle = await fs.open(temporaryPath, "wx", 0o600);
    await writeTemporaryFile(temporaryHandle);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    await fs.link(temporaryPath, outputPath);
  } finally {
    try {
      await closeFileHandle(temporaryHandle);
    } finally {
      try {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      } finally {
        activeTemporaryPaths.delete(temporaryPath);
      }
    }
  }
}

export function isEncryptedBackupFileName(fileName) {
  return String(fileName || "").toLowerCase().endsWith(".qhb");
}

export async function isEncryptedBackupFile(filePath) {
  const handle = await fs.open(filePath, "r");

  try {
    const header = Buffer.alloc(ENCRYPTED_BACKUP_MAGIC.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);

    return (
      bytesRead === ENCRYPTED_BACKUP_MAGIC.length &&
      header.equals(ENCRYPTED_BACKUP_MAGIC)
    );
  } finally {
    await handle.close();
  }
}

export async function encryptBackupFile(
  inputPath,
  outputPath,
  encryptionKey
) {
  const key = backupEncryptionKey(encryptionKey);
  let iv = null;
  let tagPlaceholder = null;
  let header = null;
  let inputHandle = null;

  try {
    iv = crypto.randomBytes(BACKUP_IV_LENGTH);
    tagPlaceholder = Buffer.alloc(BACKUP_TAG_LENGTH);
    header = Buffer.concat([
      ENCRYPTED_BACKUP_MAGIC,
      iv,
      tagPlaceholder,
    ]);
    inputHandle = await fs.open(inputPath, "r");
    const cipher = crypto.createCipheriv(
      BACKUP_ENCRYPTION_ALGORITHM,
      key,
      iv
    );

    await writeFileAtomically(
      outputPath,
      async (temporaryHandle) => {
        await writeBufferAt(temporaryHandle, header, 0);

        const inputStream = inputHandle.createReadStream({
          autoClose: true,
        });
        const outputStream = createFileHandleWriteStream(
          temporaryHandle,
          BACKUP_HEADER_LENGTH
        );

        await pipeline(inputStream, cipher, outputStream);

        const tag = cipher.getAuthTag();

        try {
          await writeBufferAt(
            temporaryHandle,
            tag,
            BACKUP_TAG_OFFSET
          );
        } finally {
          tag.fill(0);
        }
      }
    );
  } finally {
    try {
      await closeFileHandle(inputHandle);
    } finally {
      header?.fill(0);
      tagPlaceholder?.fill(0);
      iv?.fill(0);
      key.fill(0);
    }
  }
}

export async function decryptBackupFile(
  inputPath,
  outputPath,
  encryptionKey
) {
  const key = backupEncryptionKey(encryptionKey);
  let header = null;
  let inputHandle = null;

  try {
    header = Buffer.alloc(BACKUP_HEADER_LENGTH);
    inputHandle = await fs.open(inputPath, "r");
    const inputStats = await inputHandle.stat();
    const headerBytesRead = await readBufferAt(inputHandle, header, 0);

    if (
      inputStats.size <= BACKUP_HEADER_LENGTH ||
      headerBytesRead !== BACKUP_HEADER_LENGTH ||
      !header
        .subarray(0, ENCRYPTED_BACKUP_MAGIC.length)
        .equals(ENCRYPTED_BACKUP_MAGIC)
    ) {
      throw new Error("암호화된 DB 백업 파일 형식이 올바르지 않습니다.");
    }

    const ivStart = ENCRYPTED_BACKUP_MAGIC.length;
    const tagStart = ivStart + BACKUP_IV_LENGTH;
    const encryptedStart = tagStart + BACKUP_TAG_LENGTH;
    const iv = header.subarray(ivStart, tagStart);
    const tag = header.subarray(tagStart, encryptedStart);
    const decipher = crypto.createDecipheriv(
      BACKUP_ENCRYPTION_ALGORITHM,
      key,
      iv
    );

    decipher.setAuthTag(tag);

    await writeFileAtomically(
      outputPath,
      async (temporaryHandle) => {
        const inputStream = inputHandle.createReadStream({
          autoClose: true,
          start: encryptedStart,
          end: inputStats.size - 1,
        });
        const outputStream = createFileHandleWriteStream(
          temporaryHandle,
          0
        );

        // GCM can emit plaintext before final authentication. Keep it in the
        // private temporary file and publish only after pipeline() succeeds.
        await pipeline(inputStream, decipher, outputStream);
      }
    );
  } finally {
    try {
      await closeFileHandle(inputHandle);
    } finally {
      header?.fill(0);
      key.fill(0);
    }
  }
}
