import path from "node:path";
import { getCoupangRuntimeConfig } from "@/quickhack_server/sales-channel/coupang/config";
import {
  QhkeyCredentialStateService,
  type QhkeyCredentialFreshness,
} from "@/quickhack_server/security/qhkey-credential-state-service";
import type { DecryptedQhkey } from "@/quickhack_server/security/qhkey";
import {
  defaultDevelopmentQhkeyRootPath,
  defaultQhkeyMasterKeyFilePath,
  loadUsbQhkeySnapshot,
  resolveProviderQhkeyFilePath,
  resolveQhkeyMasterKeyFilePath,
  type UsbQhkeyCredentialPublicStatus,
  type UsbQhkeyLocation,
  type UsbQhkeyProviderDescriptor,
} from "@/quickhack_server/security/usb-qhkey-storage";
import type {
  ChannelAuthPublicStatus,
  CoupangApiMode,
} from "@/quickhack_server/security/channel-auth";

type CoupangUsbQhkeyCredentials = {
  mode: CoupangApiMode;
  apiHost: string;
  vendorId: string;
  accessKey: string;
  secretKey: string;
  timeoutMs: number;
  status: ChannelAuthPublicStatus;
};

type CoupangDecryptedQhkey = Extract<
  DecryptedQhkey,
  { metadata: { credentialKind: "COUPANG_OPEN_API" } }
>;

const COUPANG_QHKEY_RELATIVE_PATH = path.join(
  "quickhack-keys",
  "coupang.qhkey"
);
const credentialStateService = new QhkeyCredentialStateService<
  CoupangDecryptedQhkey,
  UsbQhkeyCredentialPublicStatus
>();

function descriptor(): UsbQhkeyProviderDescriptor<"COUPANG_OPEN_API"> {
  const config = getCoupangRuntimeConfig();
  return {
    providerCode: "COUPANG",
    providerLabel: "Coupang",
    credentialKind: "COUPANG_OPEN_API",
    relativeFilePath: COUPANG_QHKEY_RELATIVE_PATH,
    runtimeMode: config.mode,
    writeEnabled: config.writeApiEnabled,
  };
}

function channelStatus(
  status: UsbQhkeyCredentialPublicStatus
): ChannelAuthPublicStatus {
  return { channel: "COUPANG", ...status };
}

export {
  defaultDevelopmentQhkeyRootPath,
  defaultQhkeyMasterKeyFilePath,
  resolveQhkeyMasterKeyFilePath,
};

export function resolveCoupangQhkeyFilePath(location?: UsbQhkeyLocation) {
  return resolveProviderQhkeyFilePath(descriptor(), location);
}

export async function getCoupangUsbQhkeyCredentialStatus(
  location?: UsbQhkeyLocation
): Promise<ChannelAuthPublicStatus> {
  const snapshot = await loadUsbQhkeySnapshot({
    descriptor: descriptor(),
    credentialStateService,
    freshness: "CACHED_READ",
    requireCredentials: false,
    location,
  });
  return channelStatus(snapshot.status);
}

export async function getCoupangUsbQhkeyCredentials(
  freshness: QhkeyCredentialFreshness = "CACHED_READ",
  location?: UsbQhkeyLocation
): Promise<CoupangUsbQhkeyCredentials> {
  const config = getCoupangRuntimeConfig();
  const snapshot = await loadUsbQhkeySnapshot({
    descriptor: descriptor(),
    credentialStateService,
    freshness,
    requireCredentials: true,
    location,
  });
  const status = channelStatus(snapshot.status);

  if (!status.readEnabled || !snapshot.decryptedQhkey) {
    throw new Error(status.errorMessage || "QHKEY credential is not readable.");
  }
  if (config.mode === "mock" && !config.mockServerUrl) {
    throw new Error(
      "Coupang mock server URL is missing from the built-in runtime configuration."
    );
  }

  return {
    mode: config.mode,
    apiHost:
      config.mode === "mock" ? config.mockServerUrl || "" : config.apiHost,
    vendorId: snapshot.decryptedQhkey.credential.vendorId,
    accessKey: snapshot.decryptedQhkey.credential.accessKey,
    secretKey: snapshot.decryptedQhkey.credential.secretKey,
    timeoutMs:
      config.mode === "mock"
        ? Math.min(config.httpTimeoutMs, 6000)
        : config.httpTimeoutMs,
    status,
  };
}

export function clearQhkeyCredentialStateCacheForTest() {
  credentialStateService.clear();
}
