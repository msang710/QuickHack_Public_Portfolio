import type { QhkeyProvider } from "../platform/qhkey-contract.mjs";
import type { CoupangOpenApiCredential, LogenOpenApiCredential } from "./qhkey-format.mjs";

export type QhkeyReplacementPublicResult = Readonly<{
  state: string;
  transactionId: string;
  provider: QhkeyProvider;
  volumeId: string;
  keyAlias: string;
  keyFingerprint: string;
  expiresAt: string;
  errorCode?: string;
  message?: string;
}>;

export function createQhkeyReplacementService(options: Record<string, unknown> & {
  dataDir: string;
}): Readonly<{
  platform: string;
  stateRoot: string;
  prepareReplacement(input: {
    provider: QhkeyProvider;
    volumeId?: string;
    rootPath?: string;
    replaceExisting?: boolean;
    production?: boolean;
    environment: string;
    keyAlias: string;
    credential: CoupangOpenApiCredential | LogenOpenApiCredential;
    issuedAt: string;
    expiresAt: string;
  }): Promise<QhkeyReplacementPublicResult>;
  publishReplacement(transactionId: string, options?: { requireRoot?: boolean; uid?: number | null }): Promise<QhkeyReplacementPublicResult>;
  replacementStatus(transactionId: string): Promise<QhkeyReplacementPublicResult>;
  cancelReplacement(transactionId: string): Promise<QhkeyReplacementPublicResult>;
}>;
