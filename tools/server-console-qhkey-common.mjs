import fs from "node:fs";
const preserveKoreanSnapshot = (value) => value;
import path from "node:path";
import {
  createEncryptedQhkey,
  decryptQhkey,
  readQhkeyMetadata,
  writeQhkeyFile,
} from "../quickhack_server/security/qhkey-format.mjs";
import {
  readQhkeyMasterKeyFile,
} from "../quickhack_server/security/qhkey-master-key-provider.mjs";
import {
  QHKEY_PROVIDER_RELATIVE_PATHS,
  QhkeyPlatformError,
  assertQhkeyTransactionId,
} from "../quickhack_server/platform/qhkey-contract.mjs";
import { composeServerPlatform } from "../quickhack_server/platform/compose-server-platform.ts";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";
import { createQhkeyReplacementService } from "../quickhack_server/security/qhkey-replacement-transaction.mjs";

const MAX_CREDENTIAL_LENGTH = 4096;
const serverPlatform = composeServerPlatform();
const operatorPlatform = composeOperatorPlatform();
const replacementServices = new Map();

const QHKEY_PROVIDERS = Object.freeze({
  coupang: Object.freeze({
    provider: "COUPANG",
    credentialKind: "COUPANG_OPEN_API",
    relativePath: QHKEY_PROVIDER_RELATIVE_PATHS.COUPANG,
  }),
  logen: Object.freeze({
    provider: "LOGEN",
    credentialKind: "LOGEN_OPEN_API",
    relativePath: QHKEY_PROVIDER_RELATIVE_PATHS.LOGEN,
  }),
});

function replacementService(dataDir) {
  const normalized = path.resolve(String(dataDir ?? ""));
  let service = replacementServices.get(normalized);
  if (!service) {
    service = createQhkeyReplacementService({ dataDir: normalized });
    replacementServices.set(normalized, service);
  }
  return service;
}

function providerDescriptor(provider) {
  const descriptor = QHKEY_PROVIDERS[provider];
  if (!descriptor) throw new TypeError("지원하지 않는 QHKEY provider입니다.");
  return descriptor;
}

function qhkeyPath(root, provider) {
  return path.join(root, providerDescriptor(provider).relativePath);
}

function providerFiles(root) {
  return Object.entries(QHKEY_PROVIDERS)
    .map(([provider, descriptor]) => ({
      provider,
      credentialKind: descriptor.credentialKind,
      filePath: path.join(root, descriptor.relativePath),
    }))
    .filter((entry) => fs.existsSync(entry.filePath));
}

function publicDrive(volume) {
  return Object.freeze({
    root: volume.rootPath,
    volumeId: volume.volumeId,
    deviceId: volume.deviceId,
    fileSystemUuid: volume.fileSystemUuid,
    label: volume.label,
    driveType: "Removable",
    removable: true,
    readOnly: volume.readOnly,
    hasCoupangQhkey: volume.providers.includes("COUPANG"),
    hasLogenQhkey: volume.providers.includes("LOGEN"),
    hasQhkey: volume.providers.length > 0,
  });
}

export async function discoverWindowsDrives() {
  return (await operatorPlatform.removableVolume.list()).map(publicDrive);
}

export async function detectSingleQhkeyRoot() {
  const drives = (await discoverWindowsDrives()).filter((drive) => drive.hasQhkey);
  return drives.length === 1 ? drives[0].root : "";
}

export const detectSingleCoupangQhkeyRoot = detectSingleQhkeyRoot;

function safeMetadata(filePath) {
  try {
    return { ok: true, ...readQhkeyMetadata(filePath), errorMessage: "" };
  } catch (error) {
    return {
      ok: false,
      formatVersion: null,
      credentialKind: "",
      environment: "",
      keyAlias: "",
      keyFingerprint: "",
      issuedAt: "",
      expiresAt: "",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspectProviderConsoleStatus(provider, selectedVolume, dataDir, masterStatus) {
  const descriptor = providerDescriptor(provider);
  const filePath = selectedVolume ? qhkeyPath(selectedVolume.rootPath, provider) : "";
  const metadata = filePath && fs.existsSync(filePath) ? safeMetadata(filePath) : null;
  let readable = false;
  let errorMessage = "";
  if (metadata?.ok && masterStatus.available) {
    try {
      if (metadata.credentialKind !== descriptor.credentialKind) {
        throw new Error("QHKEY_CREDENTIAL_KIND_MISMATCH");
      }
      const masterKey = await serverPlatform.qhkeyMasterKey.read({ dataDir });
      try {
        const decrypted = decryptQhkey(filePath, masterKey);
        if (decrypted.metadata.credentialKind !== descriptor.credentialKind) {
          throw new Error("QHKEY_CREDENTIAL_KIND_MISMATCH");
        }
        readable = true;
      } finally {
        masterKey.fill(0);
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  } else if (metadata && !metadata.ok) {
    errorMessage = metadata.errorMessage;
  } else if (metadata?.ok && !masterStatus.available) {
    errorMessage = preserveKoreanSnapshot("이 서버에 QHKEY 마스터 키가 provision되지 않았습니다.");
  }
  return { qhkeyFile: filePath, metadata, readable, errorMessage };
}

export async function getQhkeyConsoleStatus(dataDir, production = false) {
  const volumes = await operatorPlatform.removableVolume.list({ production });
  const drives = volumes.map(publicDrive);
  const rootsWithKey = volumes.filter((volume) => volume.providers.length > 0);
  const selectedVolume = rootsWithKey.length === 1 ? rootsWithKey[0] : null;
  const masterStatus = await serverPlatform.qhkeyMasterKey.status({ dataDir, production });
  let errorMessage = masterStatus.warningMessage ?? "";
  if (rootsWithKey.length > 1) {
    errorMessage = preserveKoreanSnapshot("QHKEY가 있는 removable volume이 여러 개라 자동 선택할 수 없습니다.");
  }
  const coupang = await inspectProviderConsoleStatus("coupang", selectedVolume, dataDir, masterStatus);
  const logen = await inspectProviderConsoleStatus("logen", selectedVolume, dataDir, masterStatus);
  const masterKeyFile =
    typeof serverPlatform.qhkeyMasterKey.masterFilePath === "function"
      ? serverPlatform.qhkeyMasterKey.masterFilePath(dataDir)
      : "";
  return {
    platform: serverPlatform.platform,
    drives,
    selectedRoot: selectedVolume?.rootPath ?? "",
    selectedVolumeId: selectedVolume?.volumeId ?? "",
    errorMessage,
    masterKeyExists: masterStatus.available,
    masterKeyProtection: masterStatus.protection,
    masterKeyFile,
    coupang,
    logen,
  };
}

export async function getCoupangQhkeyConsoleStatus(dataDir) {
  const status = await getQhkeyConsoleStatus(dataDir);
  return { ...status, ...status.coupang };
}

function requiredCredential(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label}을(를) 입력하세요.`);
  if (text.length > MAX_CREDENTIAL_LENGTH) throw new Error(`${label} 값이 너무 깁니다.`);
  return text;
}

export function validateQhkeyProviderFilesWithMaster(root, masterKeyFile) {
  const files = providerFiles(root);
  const masterKey = readQhkeyMasterKeyFile(masterKeyFile);
  const metadata = [];
  try {
    for (const file of files) {
      const decrypted = decryptQhkey(file.filePath, masterKey);
      if (decrypted.metadata.credentialKind !== file.credentialKind) {
        throw new Error("QHKEY_CREDENTIAL_KIND_MISMATCH");
      }
      metadata.push({ provider: file.provider, ...decrypted.metadata });
    }
  } finally {
    masterKey.fill(0);
  }
  return metadata;
}

// Test/development compatibility writer. Production console routes use the
// replacement transaction below and never call this direct writer.
export function writeCoupangQhkey(input, target, credential) {
  const masterKey = readQhkeyMasterKeyFile(target.masterKeyFile);
  try {
    const qhkey = createEncryptedQhkey({
      masterKey,
      credentialKind: "COUPANG_OPEN_API",
      environment: String(input.environment || "mock").trim().toLowerCase(),
      keyAlias: String(input.keyAlias || "").trim() || `coupang-${Date.now()}`,
      credential: {
        vendorId: requiredCredential(credential.vendorId, "업체코드 (vendorId)"),
        accessKey: requiredCredential(credential.accessKey, "Access Key"),
        secretKey: requiredCredential(credential.secretKey, "Secret Key"),
      },
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
    });
    writeQhkeyFile(target.filePath, qhkey.buffer, target.fileExists);
    return { root: target.root, filePath: target.filePath, ...qhkey.metadata };
  } finally {
    masterKey.fill(0);
  }
}

export function writeLogenQhkey(input, target, credential) {
  const masterKey = readQhkeyMasterKeyFile(target.masterKeyFile);
  try {
    const qhkey = createEncryptedQhkey({
      masterKey,
      credentialKind: "LOGEN_OPEN_API",
      environment: String(input.environment || "live").trim().toLowerCase(),
      keyAlias: String(input.keyAlias || "").trim() || `logen-${Date.now()}`,
      credential: {
        userId: requiredCredential(credential.userId, "연동업체코드 (userId)"),
        customerCode: requiredCredential(credential.customerCode, "거래처코드 (customerCode)"),
        secretKey: requiredCredential(credential.secretKey, "Secret Key"),
      },
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
    });
    writeQhkeyFile(target.filePath, qhkey.buffer, target.fileExists);
    return { root: target.root, filePath: target.filePath, ...qhkey.metadata };
  } finally {
    masterKey.fill(0);
  }
}

export async function prepareProviderReplacement(input, provider, credential, dateRange) {
  const descriptor = providerDescriptor(provider);
  const volume = await operatorPlatform.removableVolume.locate({
    volumeId: String(input.volumeId ?? "").trim() || undefined,
    rootPath: String(input.root ?? "").trim() || undefined,
    requireWritable: true,
    production: Boolean(input.production),
  });
  let masterStatus = await serverPlatform.qhkeyMasterKey.status({
    dataDir: input.dataDir,
    production: Boolean(input.production),
  });
  if (
    !masterStatus.available &&
    masterStatus.protection === "MISSING" &&
    serverPlatform.platform === "win32" &&
    volume.providers.length === 0
  ) {
    masterStatus = await serverPlatform.qhkeyMasterKey.ensure({
      dataDir: input.dataDir,
      production: Boolean(input.production),
    });
  }
  if (!masterStatus.available) {
    throw new QhkeyPlatformError(
      "QHKEY_MASTER_PROVISIONING_REQUIRED",
      masterStatus.warningMessage || "The QHKEY master key is not available for this runtime."
    );
  }
  const result = await replacementService(input.dataDir).prepareReplacement({
    provider: descriptor.provider,
    volumeId: volume.volumeId,
    replaceExisting: Boolean(input.replaceExisting),
    environment: String(input.environment || "live").trim().toLowerCase(),
    keyAlias:
      String(input.keyAlias || "").trim() ||
      `${provider}-${String(input.environment || "live").trim().toLowerCase()}-${Date.now()}`,
    credential,
    issuedAt: dateRange.issuedAt,
    expiresAt: dateRange.expiresAt,
    production: Boolean(input.production),
  });
  return { root: volume.rootPath, ...result };
}

export async function getQhkeyReplacementStatus(dataDir, transactionId) {
  return replacementService(dataDir).replacementStatus(
    assertQhkeyTransactionId(transactionId)
  );
}

export async function cancelQhkeyReplacement(dataDir, transactionId) {
  return replacementService(dataDir).cancelReplacement(
    assertQhkeyTransactionId(transactionId)
  );
}

export async function importQhkeyMasterKey(input) {
  if (typeof serverPlatform.qhkeyMasterKey.importProtectedFile !== "function") {
    const error = new Error("Linux QHKEY master keys are provisioned by the operating-system installer or recovery command.");
    error.code = "QHKEY_MASTER_PROVISIONING_REQUIRED";
    throw error;
  }
  const volume = await operatorPlatform.removableVolume.locate({
    volumeId: String(input.volumeId ?? "").trim() || undefined,
    rootPath: String(input.root ?? "").trim() || undefined,
  });
  if (volume.providers.length === 0) throw new Error("QHKEY가 있는 이동식 volume을 선택하세요.");
  const sourceFile = path.resolve(String(input.sourceFile || ""));
  if (!fs.existsSync(sourceFile)) throw new Error("기존 마스터 키 파일을 찾을 수 없습니다.");
  const validated = validateQhkeyProviderFilesWithMaster(volume.rootPath, sourceFile);
  serverPlatform.qhkeyMasterKey.importProtectedFile({
    dataDir: input.dataDir,
    sourceFile,
    force: Boolean(input.replaceExisting),
  });
  return {
    root: volume.rootPath,
    providers: validated.map((entry) => ({
      provider: entry.provider,
      keyAlias: entry.keyAlias,
      keyFingerprint: entry.keyFingerprint,
      expiresAt: entry.expiresAt,
    })),
  };
}

export const importCoupangQhkeyMasterKey = importQhkeyMasterKey;
