import fs from "node:fs/promises";
import path from "node:path";
import { traceOperationSpan } from "@/quickhack_server/observability/operation-trace";
import {
  getServerQhkeyMasterKeyProvider,
  getServerRemovableVolumeProvider,
} from "@/quickhack_server/platform/server-runtime";
import type { QhkeyVolumeIdentity } from "@/quickhack_server/platform/contracts";
import {
  QhkeyCredentialStateService,
  type QhkeyCredentialFreshness,
} from "@/quickhack_server/security/qhkey-credential-state-service";
import {
  decryptQhkeyAsync,
  normalizeQhkeyEnvironment,
  qhkeyDaysUntilExpiry,
  readQhkeyMetadataAsync,
  type DecryptedQhkey,
  type QhkeyCredentialKind,
  type QhkeyMetadata,
} from "@/quickhack_server/security/qhkey";
import { getDataDir } from "@/quickhack_shared/core/runtime";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import { formatKstSqlDateTime, quickHackClock } from "@/quickhack_shared/core/time";

export type UsbQhkeyStatusCode =
  | "ACTIVE"
  | "WARNING"
  | "MISSING"
  | "EXPIRED"
  | "DISABLED";

export type UsbQhkeyCredentialPublicStatus = {
  providerType: "USB_QHKEY";
  status: UsbQhkeyStatusCode;
  keyAlias: string | null;
  keyFingerprint: string | null;
  expiresAt: string | null;
  readEnabled: boolean;
  writeEnabled: boolean;
  lastVerifiedAt: string | null;
  warningMessage: string | null;
  errorMessage: string | null;
};

export type DecryptedQhkeyForKind<TKind extends QhkeyCredentialKind> = Extract<
  DecryptedQhkey,
  { metadata: { credentialKind: TKind } }
>;

export type UsbQhkeyProviderDescriptor<TKind extends QhkeyCredentialKind> = {
  providerCode: "COUPANG" | "LOGEN";
  providerLabel: string;
  credentialKind: TKind;
  relativeFilePath: string;
  runtimeMode: "mock" | "live";
  writeEnabled: boolean;
};

export type UsbQhkeyLocation = {
  rootPath: string;
  filePath?: string;
};

export type UsbQhkeySnapshot<TKind extends QhkeyCredentialKind> = {
  status: UsbQhkeyCredentialPublicStatus;
  decryptedQhkey: DecryptedQhkeyForKind<TKind> | null;
};

const QHKEY_EXPIRY_WARNING_DAYS = 30;
const qhkeyMasterKeyProvider = getServerQhkeyMasterKeyProvider();
const removableVolumeProvider = getServerRemovableVolumeProvider();

export function defaultQhkeyMasterKeyFilePath() {
  return path.join(getDataDir(), "security", "qhkey-master.key");
}

export function defaultDevelopmentQhkeyRootPath() {
  return path.join(getDataDir(), "qhkey");
}

export function resolveQhkeyMasterKeyFilePath() {
  return defaultQhkeyMasterKeyFilePath();
}

function baseStatus(
  input: Partial<UsbQhkeyCredentialPublicStatus> = {}
): UsbQhkeyCredentialPublicStatus {
  return {
    providerType: "USB_QHKEY",
    status: "MISSING",
    keyAlias: null,
    keyFingerprint: null,
    expiresAt: null,
    readEnabled: false,
    writeEnabled: false,
    lastVerifiedAt: null,
    warningMessage: null,
    errorMessage: null,
    ...input,
  };
}

function statusFromError(
  error: unknown,
  metadata?: Pick<QhkeyMetadata, "keyAlias" | "keyFingerprint" | "expiresAt">,
  status: UsbQhkeyStatusCode = "MISSING"
) {
  return baseStatus({
    status,
    keyAlias: metadata?.keyAlias ?? null,
    keyFingerprint: metadata?.keyFingerprint ?? null,
    expiresAt: metadata?.expiresAt ?? null,
    errorMessage: error instanceof Error ? error.message : String(error),
  });
}

function expiryStatus(expiresAt: string, providerLabel: string) {
  const days = qhkeyDaysUntilExpiry(expiresAt, quickHackClock.nowDate());

  if (days === null) {
    return {
      status: "DISABLED" as const,
      warningMessage: null,
      errorMessage: "QHKEY expiresAt is not a valid ISO UTC timestamp.",
      readEnabled: false,
    };
  }

  if (days <= 0) {
    return {
      status: "EXPIRED" as const,
      warningMessage: null,
      errorMessage: `QHKEY is expired. Rotate the ${providerLabel} credential before API use.`,
      readEnabled: false,
    };
  }

  if (days <= QHKEY_EXPIRY_WARNING_DAYS) {
    return {
      status: "WARNING" as const,
      warningMessage: `QHKEY expires in ${days} day(s). Rotate the ${providerLabel} key before expiry.`,
      errorMessage: null,
      readEnabled: true,
    };
  }

  return {
    status: "ACTIVE" as const,
    warningMessage: null,
    errorMessage: null,
    readEnabled: true,
  };
}

async function inspectQhkeyRootSecurity(
  root: string,
  volume?: QhkeyVolumeIdentity
) {
  if (!root) {
    return { disabled: false, message: null, volumeIdentity: "" };
  }

  try {
    await fs.access(root);
  } catch {
    return {
      disabled: true,
      message: "QHKEY root was not found.",
      volumeIdentity: "",
    };
  }

  if (!runtimeConfigService.isProduction() || !volume) {
    return {
      disabled: false,
      message: null,
      volumeIdentity: path.resolve(root),
    };
  }

  try {
    const current = await removableVolumeProvider.validate(volume, {
      production: true,
    });
    if (current.readOnly) {
      return {
        disabled: true,
        message: "QHKEY volume is read-only.",
        volumeIdentity: "",
      };
    }
    return {
      disabled: false,
      message: null,
      volumeIdentity: JSON.stringify(current),
    };
  } catch {
    return {
      disabled: true,
      message: "QHKEY volume identity could not be verified.",
      volumeIdentity: "",
    };
  }
}

async function inspectMasterKeyProtection() {
  try {
    const status = await qhkeyMasterKeyProvider.status({
      dataDir: getDataDir(),
      production: runtimeConfigService.isProduction(),
    });
    if (!status.available) {
      return {
        disabled: true,
        message: "QHKEY master key file was not found.",
        status,
      };
    }
    return {
      disabled: false,
      message: status.warningMessage,
      status,
    };
  } catch (error) {
    return {
      disabled: true,
      message: error instanceof Error ? error.message : String(error),
      status: null,
    };
  }
}

function combineMessages(
  ...messages: Array<string | null | undefined>
) {
  return messages.filter(Boolean).join(" ");
}

async function locationForProvider<TKind extends QhkeyCredentialKind>(
  descriptor: UsbQhkeyProviderDescriptor<TKind>,
  explicitLocation?: UsbQhkeyLocation
) {
  const production = runtimeConfigService.isProduction();

  if (production && explicitLocation) {
    return {
      filePath: "",
      rootPath: "",
      errorMessage: "Production USB_QHKEY does not accept an explicit test location.",
    };
  }

  if (explicitLocation) {
    const rootPath = path.resolve(explicitLocation.rootPath);
    return {
      rootPath,
      filePath: explicitLocation.filePath
        ? path.resolve(explicitLocation.filePath)
        : path.join(rootPath, descriptor.relativeFilePath),
      errorMessage: "",
      volume: undefined,
    };
  }

  if (production) {
    try {
      const volume = await removableVolumeProvider.locate({
        requireProvider: descriptor.providerCode,
        production: true,
      });
      return {
        rootPath: volume.rootPath,
        filePath: path.join(volume.rootPath, descriptor.relativeFilePath),
        errorMessage: "",
        volume,
      };
    } catch (error) {
      return {
        filePath: "",
        rootPath: "",
        errorMessage: error instanceof Error ? error.message : String(error),
        volume: undefined,
      };
    }
  }

  const rootPath = defaultDevelopmentQhkeyRootPath();
  return {
    rootPath,
    filePath: path.join(rootPath, descriptor.relativeFilePath),
    errorMessage: "",
    volume: undefined,
  };
}

export async function resolveProviderQhkeyFilePath<
  TKind extends QhkeyCredentialKind,
>(
  descriptor: UsbQhkeyProviderDescriptor<TKind>,
  explicitLocation?: UsbQhkeyLocation
) {
  return (await locationForProvider(descriptor, explicitLocation)).filePath;
}

function assertRuntimeMatches<TKind extends QhkeyCredentialKind>(
  metadata: QhkeyMetadata,
  descriptor: UsbQhkeyProviderDescriptor<TKind>
) {
  if (metadata.credentialKind !== descriptor.credentialKind) {
    throw new Error("QHKEY_CREDENTIAL_KIND_MISMATCH");
  }

  const qhkeyEnvironment = normalizeQhkeyEnvironment(metadata.environment);
  const quickHackEnvironment = runtimeConfigService.read().environment;

  if (qhkeyEnvironment === "mock" && descriptor.runtimeMode !== "mock") {
    throw new Error(
      `QHKEY environment is mock, but the ${descriptor.providerCode} runtime mode is not mock.`
    );
  }
  if (qhkeyEnvironment === "live" && descriptor.runtimeMode !== "live") {
    throw new Error(
      `QHKEY environment is live, but the ${descriptor.providerCode} runtime mode is not live.`
    );
  }
  if (
    qhkeyEnvironment === "development" &&
    quickHackEnvironment !== "development"
  ) {
    throw new Error(
      "QHKEY environment is development, but QuickHack is not running in development."
    );
  }
  if (
    qhkeyEnvironment === "production" &&
    (quickHackEnvironment !== "production" ||
      descriptor.runtimeMode !== "live")
  ) {
    throw new Error(
      "QHKEY environment is production, but QuickHack is not running production/live."
    );
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function credentialStateCacheKey<TKind extends QhkeyCredentialKind>(
  descriptor: UsbQhkeyProviderDescriptor<TKind>,
  qhkeyFilePath: string,
  masterIdentityToken: string,
  rootPath: string
) {
  return JSON.stringify({
    providerCode: descriptor.providerCode,
    credentialKind: descriptor.credentialKind,
    qhkeyFilePath,
    masterIdentityToken,
    qhkeyRoot: rootPath,
    requireBitlocker: runtimeConfigService.isProduction(),
    runtimeEnvironment: runtimeConfigService.read().environment,
    runtimeMode: descriptor.runtimeMode,
    writeEnabled: descriptor.writeEnabled,
  });
}

async function openDecryptedQhkey<TKind extends QhkeyCredentialKind>(
  descriptor: UsbQhkeyProviderDescriptor<TKind>,
  qhkeyFilePath: string
): Promise<DecryptedQhkeyForKind<TKind>> {
  const masterKey = await traceOperationSpan("QHKEY_MASTER_KEY_OPEN", () =>
    qhkeyMasterKeyProvider.read({ dataDir: getDataDir() })
  );

  try {
    const decrypted = await traceOperationSpan("QHKEY_PAYLOAD_DECRYPT", () =>
      decryptQhkeyAsync(qhkeyFilePath, masterKey)
    );
    if (decrypted.metadata.credentialKind !== descriptor.credentialKind) {
      throw new Error("QHKEY_CREDENTIAL_KIND_MISMATCH");
    }
    return decrypted as DecryptedQhkeyForKind<TKind>;
  } finally {
    masterKey.fill(0);
  }
}

async function loadFreshUsbQhkeySnapshot<
  TKind extends QhkeyCredentialKind,
>(
  descriptor: UsbQhkeyProviderDescriptor<TKind>,
  qhkeyFilePath: string,
  rootPath: string,
  volume?: QhkeyVolumeIdentity
): Promise<UsbQhkeySnapshot<TKind> & { validationSignature: string }> {
  const rootSecurity = await traceOperationSpan("QHKEY_ROOT_VALIDATE", () =>
    inspectQhkeyRootSecurity(rootPath, volume)
  );
  if (rootSecurity.disabled) {
    return {
      status: baseStatus({
        status: "DISABLED",
        errorMessage: rootSecurity.message,
      }),
      decryptedQhkey: null,
      validationSignature: rootSecurity.volumeIdentity,
    };
  }

  if (!(await pathExists(qhkeyFilePath))) {
    return {
      status: baseStatus({ errorMessage: "QHKEY file was not found." }),
      decryptedQhkey: null,
      validationSignature: rootSecurity.volumeIdentity,
    };
  }

  let metadata: QhkeyMetadata | null = null;
  try {
    metadata = await traceOperationSpan("QHKEY_METADATA_VALIDATE", async () => {
      const loadedMetadata = await readQhkeyMetadataAsync(qhkeyFilePath);
      assertRuntimeMatches(loadedMetadata, descriptor);
      return loadedMetadata;
    });
  } catch (error) {
    return {
      status: statusFromError(error, metadata ?? undefined, "DISABLED"),
      decryptedQhkey: null,
      validationSignature: rootSecurity.volumeIdentity,
    };
  }

  const masterKeyProtection = await traceOperationSpan(
    "QHKEY_MASTER_KEY_VALIDATE",
    () => inspectMasterKeyProtection()
  );
  if (masterKeyProtection.disabled) {
    return {
      status: statusFromError(
        new Error(
          masterKeyProtection.message || "QHKEY master key protection failed."
        ),
        metadata,
        masterKeyProtection.status?.protection === "MISSING"
          ? "MISSING"
          : "DISABLED"
      ),
      decryptedQhkey: null,
      validationSignature: rootSecurity.volumeIdentity,
    };
  }

  try {
    const decryptedQhkey = await openDecryptedQhkey(
      descriptor,
      qhkeyFilePath
    );
    assertRuntimeMatches(decryptedQhkey.metadata, descriptor);
    metadata = decryptedQhkey.metadata;
    const expiry = expiryStatus(metadata.expiresAt, descriptor.providerLabel);

    return {
      status: baseStatus({
        status:
          (rootSecurity.message || masterKeyProtection.message) &&
          expiry.status === "ACTIVE"
            ? "WARNING"
            : expiry.status,
        keyAlias: metadata.keyAlias,
        keyFingerprint: metadata.keyFingerprint,
        expiresAt: metadata.expiresAt,
        readEnabled: expiry.readEnabled,
        writeEnabled: expiry.readEnabled && descriptor.writeEnabled,
        lastVerifiedAt: formatKstSqlDateTime(quickHackClock.nowDate()),
        warningMessage:
          combineMessages(
            expiry.warningMessage,
            rootSecurity.message,
            masterKeyProtection.message
          ) || null,
        errorMessage: expiry.errorMessage,
      }),
      decryptedQhkey,
      validationSignature: rootSecurity.volumeIdentity,
    };
  } catch (error) {
    return {
      status: statusFromError(error, metadata),
      decryptedQhkey: null,
      validationSignature: rootSecurity.volumeIdentity,
    };
  }
}

export async function loadUsbQhkeySnapshot<
  TKind extends QhkeyCredentialKind,
>(input: {
  descriptor: UsbQhkeyProviderDescriptor<TKind>;
  credentialStateService: QhkeyCredentialStateService<
    DecryptedQhkeyForKind<TKind>,
    UsbQhkeyCredentialPublicStatus
  >;
  freshness: QhkeyCredentialFreshness;
  requireCredentials: boolean;
  location?: UsbQhkeyLocation;
}): Promise<UsbQhkeySnapshot<TKind>> {
  const location = await locationForProvider(input.descriptor, input.location);
  if (!location.filePath) {
    return {
      status: baseStatus({ errorMessage: location.errorMessage }),
      decryptedQhkey: null,
    };
  }

  const masterKeyFilePath = resolveQhkeyMasterKeyFilePath();
  const masterIdentityToken =
    qhkeyMasterKeyProvider.descriptor.platform === "linux"
      ? "quickhack.qhkey-master-key"
      : masterKeyFilePath;
  const masterIdentityPaths =
    qhkeyMasterKeyProvider.descriptor.platform === "linux"
      ? []
      : [masterKeyFilePath];
  const snapshot = await input.credentialStateService.get({
    cacheKey: credentialStateCacheKey(
      input.descriptor,
      location.filePath,
      masterIdentityToken,
      location.rootPath
    ),
    identityPaths: [location.filePath, ...masterIdentityPaths],
    freshness: input.freshness,
    requireCredentials: input.requireCredentials,
    loadFresh: async () => {
      const loaded = await loadFreshUsbQhkeySnapshot(
        input.descriptor,
        location.filePath,
        location.rootPath,
        location.volume
      );
      return {
        status: loaded.status,
        credentials: loaded.decryptedQhkey,
        validationSignature: loaded.validationSignature,
      };
    },
    loadCredentialsFromValidatedState: async (status) => {
      const decrypted = await openDecryptedQhkey(
        input.descriptor,
        location.filePath
      );
      assertRuntimeMatches(decrypted.metadata, input.descriptor);
      if (
        decrypted.metadata.keyAlias !== status.keyAlias ||
        decrypted.metadata.keyFingerprint !== status.keyFingerprint ||
        decrypted.metadata.expiresAt !== status.expiresAt
      ) {
        throw new Error(
          "QHKEY changed while a cached credential state was active."
        );
      }
      return decrypted;
    },
  });

  return {
    status: snapshot.status,
    decryptedQhkey: snapshot.credentials,
  };
}
