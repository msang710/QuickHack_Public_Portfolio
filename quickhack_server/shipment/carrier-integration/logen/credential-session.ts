import type { CarrierOperationType } from "@/quickhack_server/shipment/carrier-integration/types";
import {
  assertLogenWriteAllowed,
  getLogenRuntimeConfig,
} from "@/quickhack_server/shipment/carrier-integration/logen/config";
import {
  getLogenRuntimeCredentials,
  type LogenCredentialPublicStatus,
} from "@/quickhack_server/security/logen-usb-qhkey-provider";
import type { QhkeyCredentialFreshness } from "@/quickhack_server/security/qhkey-credential-state-service";

type LogenRuntimeConfig = ReturnType<typeof getLogenRuntimeConfig>;

export type LogenRequestCredentialSession = {
  runtime: LogenRuntimeConfig;
  operationType: CarrierOperationType;
  freshness: QhkeyCredentialFreshness;
  status: LogenCredentialPublicStatus;
  userId: string;
  customerCode: string;
  secretKey: string;
};

export type LogenPreparedCredentialIdentity = {
  customerCode: string;
  credentialFingerprint: string | null;
};

export class LogenCredentialChangedDuringPreparationError extends Error {
  readonly code = "LOGEN_CREDENTIAL_CHANGED_DURING_PREPARATION";

  constructor() {
    super(
      "로젠 자격증명이 송장 준비 이후 변경되었습니다. 최신 자격증명으로 준비 단계부터 다시 시도합니다."
    );
    this.name = "LogenCredentialChangedDuringPreparationError";
  }
}

export async function openLogenRequestCredentialSession(input: {
  apiName: string;
  operationType: CarrierOperationType;
}): Promise<LogenRequestCredentialSession> {
  const runtime =
    input.operationType === "WRITE"
      ? await assertLogenWriteAllowed(input.apiName)
      : getLogenRuntimeConfig();
  const freshness: QhkeyCredentialFreshness =
    input.operationType === "WRITE" ? "FORCE_FRESH_WRITE" : "CACHED_READ";
  const credentials = await getLogenRuntimeCredentials(freshness);

  if (!credentials.status.readEnabled) {
    throw new Error(
      credentials.status.errorMessage || "Logen credential is not readable."
    );
  }
  if (input.operationType === "WRITE" && !credentials.status.writeEnabled) {
    throw new Error(
      credentials.status.errorMessage ||
        `${input.apiName} 차단: 로젠 쓰기 credential을 사용할 수 없습니다.`
    );
  }

  return {
    runtime,
    operationType: input.operationType,
    freshness,
    status: credentials.status,
    userId: credentials.userId,
    customerCode: credentials.customerCode,
    secretKey: credentials.secretKey,
  };
}

export function assertLogenSessionForOperation(
  session: LogenRequestCredentialSession,
  operationType: CarrierOperationType
) {
  if (session.operationType !== operationType) {
    throw new Error(
      `Logen ${operationType} request received a ${session.operationType} credential session.`
    );
  }
  if (!session.status.readEnabled) {
    throw new Error(
      session.status.errorMessage || "Logen credential is not readable."
    );
  }
  if (
    operationType === "WRITE" &&
    session.freshness !== "FORCE_FRESH_WRITE"
  ) {
    throw new Error(
      "Logen write requests require a force-fresh credential session."
    );
  }
  if (operationType === "WRITE" && !session.status.writeEnabled) {
    throw new Error("Logen write API is disabled for the active credential.");
  }
  return session;
}

export function assertLogenPreparedCredentialMatchesWriteSession(
  prepared: LogenPreparedCredentialIdentity,
  writeSession: LogenRequestCredentialSession
) {
  assertLogenSessionForOperation(writeSession, "WRITE");
  if (
    writeSession.customerCode !== prepared.customerCode ||
    writeSession.status.keyFingerprint !== prepared.credentialFingerprint
  ) {
    throw new LogenCredentialChangedDuringPreparationError();
  }
  return writeSession;
}
