import type {
  ServerSecretKind,
  ServerSecretProtectionMetadata,
} from "./server-secret-contract.mjs";

export function serverSecretProtectionFileLabel(
  metadata: ServerSecretProtectionMetadata
): string;
export function serverSecretFilePrefix(
  kind: ServerSecretKind,
  metadata: ServerSecretProtectionMetadata
): string;
