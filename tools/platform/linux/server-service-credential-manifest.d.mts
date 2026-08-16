import type { ServerSecretIdentity } from "../../../quickhack_server/platform/server-secret-identity.mjs";
export const SERVER_CREDENTIAL_CONSUMERS: readonly ["APPLICATION", "MIGRATE", "INITIAL_LEADER", "INSTALL", "REPAIR", "RESTORE", "QHKEY_PUBLISH"];
export type ServerCredentialConsumer = (typeof SERVER_CREDENTIAL_CONSUMERS)[number];
export type ServerServiceCredential = Readonly<{ identity: ServerSecretIdentity; name: string; ciphertextPath: string; directive: string }>;
export function createServerServiceCredentialManifest(runtimeConfig: Record<string, unknown>, consumer: ServerCredentialConsumer): Readonly<{ packageFlavor: "OPERATIONAL" | "DEMONSTRATION"; consumer: ServerCredentialConsumer; credentials: readonly ServerServiceCredential[] }>;
export function renderSystemdCredentialDirectives(manifest: { credentials: readonly ServerServiceCredential[] }): string;
