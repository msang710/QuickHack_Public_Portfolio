import crypto from "node:crypto";
import {
  getCoupangUsbQhkeyCredentialStatus,
  getCoupangUsbQhkeyCredentials,
} from "@/quickhack_server/security/usb-qhkey-provider";
import type { QhkeyCredentialFreshness } from "@/quickhack_server/security/qhkey-credential-state-service";
import { quickHackClock } from "@/quickhack_shared/core/time";

export const CHANNEL_CODES = [
  "COUPANG",
  "NAVER",
  "ELEVENST",
  "ESM",
  "CAFE24",
] as const;

export const CHANNEL_AUTH_PROVIDER_TYPES = ["USB_QHKEY", "HSM"] as const;
export const CHANNEL_AUTH_STATUSES = [
  "ACTIVE",
  "WARNING",
  "MISSING",
  "EXPIRED",
  "DISABLED",
  "NOT_IMPLEMENTED",
] as const;

export type ChannelCode = (typeof CHANNEL_CODES)[number];
export type ChannelAuthProviderType = (typeof CHANNEL_AUTH_PROVIDER_TYPES)[number];
export type ChannelAuthStatus = (typeof CHANNEL_AUTH_STATUSES)[number];
export type ChannelOperationType = "READ" | "WRITE";
export type CoupangApiMode = "mock" | "live";

export type ChannelAuthPublicStatus = {
  channel: ChannelCode;
  providerType: ChannelAuthProviderType;
  status: ChannelAuthStatus;
  keyAlias: string | null;
  keyFingerprint: string | null;
  expiresAt: string | null;
  readEnabled: boolean;
  writeEnabled: boolean;
  lastVerifiedAt: string | null;
  warningMessage: string | null;
  errorMessage: string | null;
};

export type CoupangRequestAuthContext = ChannelAuthPublicStatus & {
  mode: CoupangApiMode;
  apiHost: string;
  vendorId: string;
  timeoutMs: number;
};

export type ChannelSignMetadata = {
  providerType: ChannelAuthProviderType;
  keyAlias: string | null;
  keyFingerprint: string | null;
  authStatus: "SUCCEEDED";
  warningMessage: string | null;
};

export type ChannelSignResult = ChannelSignMetadata & {
  authorization: string;
};

export type CoupangRequestAuthSession = {
  context: CoupangRequestAuthContext;
  freshness: QhkeyCredentialFreshness;
  sign: (input: {
    method: string;
    path: string;
    query: string;
    operationType: ChannelOperationType;
  }) => ChannelSignResult;
};

function providerTypeForChannel(channel: ChannelCode): ChannelAuthProviderType {
  void channel;
  return "USB_QHKEY";
}

function notImplementedStatus(
  channel: ChannelCode,
  providerType: ChannelAuthProviderType
): ChannelAuthPublicStatus {
  return {
    channel,
    providerType,
    status: "NOT_IMPLEMENTED",
    keyAlias: null,
    keyFingerprint: null,
    expiresAt: null,
    readEnabled: false,
    writeEnabled: false,
    lastVerifiedAt: null,
    warningMessage: null,
    errorMessage: `${providerType} channel credential backend is not implemented yet.`,
  };
}

async function coupangCredentialStatus(): Promise<ChannelAuthPublicStatus> {
  const channel = "COUPANG" as const;
  const providerType = providerTypeForChannel(channel);

  if (providerType === "USB_QHKEY") {
    return getCoupangUsbQhkeyCredentialStatus();
  }

  return notImplementedStatus(channel, providerType);
}

export async function getChannelAuthStatus(
  channel: ChannelCode
): Promise<ChannelAuthPublicStatus> {
  if (channel === "COUPANG") {
    return coupangCredentialStatus();
  }

  return notImplementedStatus(channel, providerTypeForChannel(channel));
}

export async function getCoupangRequestAuthContext(
  freshness: QhkeyCredentialFreshness = "CACHED_READ"
): Promise<CoupangRequestAuthContext> {
  const providerType = providerTypeForChannel("COUPANG");

  if (providerType === "USB_QHKEY") {
    const credentials = await getCoupangUsbQhkeyCredentials(freshness);

    return {
      ...credentials.status,
      mode: credentials.mode,
      apiHost: credentials.apiHost,
      vendorId: credentials.vendorId,
      timeoutMs: credentials.timeoutMs,
    };
  }

  const status = notImplementedStatus("COUPANG", providerType);
  throw new Error(status.errorMessage ?? "Coupang auth backend is unavailable.");
}

export async function openCoupangRequestAuthSession(
  freshness: QhkeyCredentialFreshness = "CACHED_READ"
): Promise<CoupangRequestAuthSession> {
  const providerType = providerTypeForChannel("COUPANG");

  if (providerType !== "USB_QHKEY") {
    const status = notImplementedStatus("COUPANG", providerType);
    throw new Error(status.errorMessage ?? "Coupang auth backend is unavailable.");
  }

  const credentials = await getCoupangUsbQhkeyCredentials(freshness);
  const context: CoupangRequestAuthContext = {
    ...credentials.status,
    mode: credentials.mode,
    apiHost: credentials.apiHost,
    vendorId: credentials.vendorId,
    timeoutMs: credentials.timeoutMs,
  };

  return {
    context,
    freshness,
    sign(input) {
      if (!context.readEnabled) {
        throw new Error(context.errorMessage ?? "Coupang credential is not readable.");
      }

      if (input.operationType === "WRITE" && !context.writeEnabled) {
        throw new Error("Coupang write API is disabled for the active credential.");
      }
      if (
        input.operationType === "WRITE" &&
        freshness !== "FORCE_FRESH_WRITE"
      ) {
        throw new Error(
          "Coupang write signing requires a force-fresh credential session."
        );
      }

      return {
        authorization: createCoupangHmacAuthorizationHeader({
          method: input.method,
          path: input.path,
          query: input.query,
          accessKey: credentials.accessKey,
          secretKey: credentials.secretKey,
        }),
        providerType: context.providerType,
        keyAlias: context.keyAlias,
        keyFingerprint: context.keyFingerprint,
        authStatus: "SUCCEEDED",
        warningMessage: context.warningMessage,
      };
    },
  };
}

function coupangSignedDateText(date = quickHackClock.nowDate()) {
  const iso = date.toISOString();

  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function createCoupangHmacAuthorizationHeader(input: {
  method: string;
  path: string;
  query: string;
  accessKey: string;
  secretKey: string;
}) {
  const signedDate = coupangSignedDateText();
  const message = `${signedDate}${input.method.toUpperCase()}${input.path}${input.query}`;
  const signature = crypto
    .createHmac("sha256", input.secretKey)
    .update(message)
    .digest("hex");

  return `CEA algorithm=HmacSHA256, access-key=${input.accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

export async function signChannelRequest(input: {
  channel: ChannelCode;
  method: string;
  path: string;
  query: string;
  operationType: ChannelOperationType;
}): Promise<ChannelSignResult> {
  if (input.channel !== "COUPANG") {
    throw new Error(`${input.channel} signing is not implemented yet.`);
  }

  const providerType = providerTypeForChannel(input.channel);

  if (providerType !== "USB_QHKEY") {
    throw new Error(`${providerType} signing is not implemented yet.`);
  }

  const qhkeyCredentials = await getCoupangUsbQhkeyCredentials(
    input.operationType === "WRITE"
      ? "FORCE_FRESH_WRITE"
      : "CACHED_READ"
  );
  const credentials = qhkeyCredentials;
  const status = qhkeyCredentials.status;

  if (!status.readEnabled) {
    throw new Error(status.errorMessage ?? "Coupang credential is not readable.");
  }

  if (input.operationType === "WRITE" && !status.writeEnabled) {
    throw new Error("Coupang write API is disabled for the active credential.");
  }

  return {
    authorization: createCoupangHmacAuthorizationHeader({
      method: input.method,
      path: input.path,
      query: input.query,
      accessKey: credentials.accessKey,
      secretKey: credentials.secretKey,
    }),
    providerType: status.providerType,
    keyAlias: status.keyAlias,
    keyFingerprint: status.keyFingerprint,
    authStatus: "SUCCEEDED",
    warningMessage: status.warningMessage,
  };
}
