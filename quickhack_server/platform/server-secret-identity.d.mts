import type { PackageFlavor } from "../../quickhack_shared/core/package-flavor-contract.mjs";
import type { ServerSecretKind } from "./server-secret-contract.mjs";

export const SERVER_SECRET_LIFECYCLES: readonly [
  "OPAQUE_PAYLOAD",
  "ACTIVATION_CREDENTIAL"
];
export type ServerSecretLifecycle = (typeof SERVER_SECRET_LIFECYCLES)[number];

export const SERVER_SECRET_CONSUMER_CLASSES: readonly [
  "LONG_LIVED_APPLICATION",
  "PRIVILEGED_ONE_SHOT",
  "DEMONSTRATION_MOCK"
];
export type ServerSecretConsumerClass =
  (typeof SERVER_SECRET_CONSUMER_CLASSES)[number];

export type ServerSecretIdentity = Readonly<{
  id: string;
  kind: ServerSecretKind;
  postgresqlRole?: string;
  consumerClass: ServerSecretConsumerClass;
  maxBytes: number;
  generationGuard: string;
  recovery: string;
}>;

export function createServerSecretIdentityManifest(runtimeConfig: {
  packageFlavor: PackageFlavor;
  database: Record<string, unknown>;
}): Readonly<{
  packageFlavor: PackageFlavor;
  identities: readonly ServerSecretIdentity[];
}>;

export function serverSecretIdentity(input: {
  kind: ServerSecretKind;
  runtimeConfig?: {
    packageFlavor: PackageFlavor;
    database: Record<string, unknown>;
  };
  postgresqlRole?: string;
}): ServerSecretIdentity;

export function assertServerSecretIdentity(value: unknown): ServerSecretIdentity;
