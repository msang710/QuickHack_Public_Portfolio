import path from "node:path";
import { getLogenRuntimeConfig } from "@/quickhack_server/shipment/carrier-integration/logen/config";
import {
  QhkeyCredentialStateService,
  type QhkeyCredentialFreshness,
} from "@/quickhack_server/security/qhkey-credential-state-service";
import type { DecryptedQhkey } from "@/quickhack_server/security/qhkey";
import {
  loadUsbQhkeySnapshot,
  resolveProviderQhkeyFilePath,
  type UsbQhkeyCredentialPublicStatus,
  type UsbQhkeyLocation,
  type UsbQhkeyProviderDescriptor,
} from "@/quickhack_server/security/usb-qhkey-storage";
import { formatKstSqlDateTime, quickHackClock } from "@/quickhack_shared/core/time";

export type LogenCredentialPublicStatus = {
  carrierCode: "LOGEN";
  providerType: "BUILT_IN_MOCK" | "USB_QHKEY";
  status: "ACTIVE" | "WARNING" | "MISSING" | "EXPIRED" | "DISABLED";
  keyAlias: string | null;
  keyFingerprint: string | null;
  expiresAt: string | null;
  readEnabled: boolean;
  writeEnabled: boolean;
  lastVerifiedAt: string | null;
  warningMessage: string | null;
  errorMessage: string | null;
};

export type LogenRuntimeCredentials = {
  userId: string;
  customerCode: string;
  secretKey: string;
  status: LogenCredentialPublicStatus;
};

type LogenDecryptedQhkey = Extract<
  DecryptedQhkey,
  { metadata: { credentialKind: "LOGEN_OPEN_API" } }
>;

const DEFAULT_MOCK_SECRET = "LOGEN-MOCK-TEST-SECRET";
const DEFAULT_MOCK_USER_ID = "10358007";
const DEFAULT_MOCK_CUSTOMER_CODE = "20179999";
const LOGEN_QHKEY_RELATIVE_PATH = path.join(
  "quickhack-keys",
  "logen.qhkey"
);
const credentialStateService = new QhkeyCredentialStateService<
  LogenDecryptedQhkey,
  UsbQhkeyCredentialPublicStatus
>();

function descriptor(): UsbQhkeyProviderDescriptor<"LOGEN_OPEN_API"> {
  const config = getLogenRuntimeConfig();
  return {
    providerCode: "LOGEN",
    providerLabel: "Logen",
    credentialKind: "LOGEN_OPEN_API",
    relativeFilePath: LOGEN_QHKEY_RELATIVE_PATH,
    runtimeMode: config.mode,
    writeEnabled: config.writeApiEnabled,
  };
}

function liveStatus(
  status: UsbQhkeyCredentialPublicStatus
): LogenCredentialPublicStatus {
  return { carrierCode: "LOGEN", ...status };
}

function mockStatus(): LogenCredentialPublicStatus {
  const config = getLogenRuntimeConfig();
  return {
    carrierCode: "LOGEN",
    providerType: "BUILT_IN_MOCK",
    status: "ACTIVE",
    keyAlias: "logen-built-in-mock",
    keyFingerprint: null,
    expiresAt: null,
    readEnabled: true,
    writeEnabled: config.writeApiEnabled,
    lastVerifiedAt: formatKstSqlDateTime(quickHackClock.nowDate()),
    warningMessage: null,
    errorMessage: null,
  };
}

export function resolveLogenQhkeyFilePath(location?: UsbQhkeyLocation) {
  return resolveProviderQhkeyFilePath(descriptor(), location);
}

export async function getLogenCredentialStatus(
  location?: UsbQhkeyLocation
): Promise<LogenCredentialPublicStatus> {
  const config = getLogenRuntimeConfig();
  if (config.mode === "mock") return mockStatus();

  const snapshot = await loadUsbQhkeySnapshot({
    descriptor: descriptor(),
    credentialStateService,
    freshness: "CACHED_READ",
    requireCredentials: false,
    location,
  });
  return liveStatus(snapshot.status);
}

export async function getLogenRuntimeCredentials(
  freshness: QhkeyCredentialFreshness = "CACHED_READ",
  location?: UsbQhkeyLocation
): Promise<LogenRuntimeCredentials> {
  const config = getLogenRuntimeConfig();
  if (config.mode === "mock") {
    return {
      userId: DEFAULT_MOCK_USER_ID,
      customerCode: DEFAULT_MOCK_CUSTOMER_CODE,
      secretKey: DEFAULT_MOCK_SECRET,
      status: mockStatus(),
    };
  }

  const snapshot = await loadUsbQhkeySnapshot({
    descriptor: descriptor(),
    credentialStateService,
    freshness,
    requireCredentials: true,
    location,
  });
  const status = liveStatus(snapshot.status);
  if (!status.readEnabled || !snapshot.decryptedQhkey) {
    throw new Error(
      status.errorMessage || "Logen QHKEY credential is not readable."
    );
  }

  return {
    userId: snapshot.decryptedQhkey.credential.userId,
    customerCode: snapshot.decryptedQhkey.credential.customerCode,
    secretKey: snapshot.decryptedQhkey.credential.secretKey,
    status,
  };
}

export function clearLogenQhkeyCredentialStateCacheForTest() {
  credentialStateService.clear();
}
