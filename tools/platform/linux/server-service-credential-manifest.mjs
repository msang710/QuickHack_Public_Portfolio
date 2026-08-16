import { createServerSecretIdentityManifest } from "../../../quickhack_server/platform/server-secret-identity.mjs";
import { systemdCredentialCiphertextPath } from "./systemd-credential-provisioner.mjs";

export const SERVER_CREDENTIAL_CONSUMERS = Object.freeze([
  "APPLICATION",
  "MIGRATE",
  "INITIAL_LEADER",
  "INSTALL",
  "REPAIR",
  "RESTORE",
  "QHKEY_PUBLISH",
]);

const CONSUMER_SET = new Set(SERVER_CREDENTIAL_CONSUMERS);

function fail(code, message) {
  const error = new Error(message);
  error.name = "ServerServiceCredentialManifestError";
  error.code = code;
  throw error;
}

function assertConsumer(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!CONSUMER_SET.has(normalized)) {
    fail("SERVER_CREDENTIAL_CONSUMER_INVALID", "The service credential consumer is invalid.");
  }
  return normalized;
}

function identitiesForConsumer(consumer, identities) {
  switch (consumer) {
    case "APPLICATION":
      return identities.filter(
        (identity) =>
          identity.consumerClass === "LONG_LIVED_APPLICATION" ||
          identity.consumerClass === "DEMONSTRATION_MOCK"
      );
    case "MIGRATE":
    case "INITIAL_LEADER":
      return identities.filter((identity) => identity.postgresqlRole === "migrator");
    case "INSTALL":
    case "REPAIR":
    case "RESTORE":
      return identities.filter((identity) => identity.postgresqlRole === "operator");
    case "QHKEY_PUBLISH":
      return [];
    default:
      return [];
  }
}

export function createServerServiceCredentialManifest(runtimeConfig, consumerValue) {
  const consumer = assertConsumer(consumerValue);
  const identityManifest = createServerSecretIdentityManifest(runtimeConfig);
  const credentials = identitiesForConsumer(consumer, identityManifest.identities).map(
    (identity) =>
      Object.freeze({
        identity,
        name: identity.id,
        ciphertextPath: systemdCredentialCiphertextPath(identity),
        directive: `LoadCredentialEncrypted=${identity.id}:${systemdCredentialCiphertextPath(identity)}`,
      })
  );
  if (new Set(credentials.map((item) => item.name)).size !== credentials.length) {
    fail("SERVER_CREDENTIAL_MANIFEST_INVALID", "The service credential manifest contains duplicate identities.");
  }
  return Object.freeze({
    packageFlavor: identityManifest.packageFlavor,
    consumer,
    credentials: Object.freeze(credentials),
  });
}

export function renderSystemdCredentialDirectives(manifest) {
  if (!manifest || !Array.isArray(manifest.credentials)) {
    fail("SERVER_CREDENTIAL_MANIFEST_INVALID", "A service credential manifest is required.");
  }
  return manifest.credentials.map((item) => item.directive).join("\n");
}
