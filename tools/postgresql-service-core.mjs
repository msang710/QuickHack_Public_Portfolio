import { createPostgresqlPackageManifest } from "../quickhack_shared/core/package-flavor-contract.mjs";

export class PostgresqlServiceCoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PostgresqlServiceCoreError";
    this.code = code;
    this.journal = options.journal ?? [];
  }
}

function requireFunction(adapter, name) {
  if (typeof adapter?.[name] !== "function") {
    throw new TypeError(`PostgreSQL service adapter is missing ${name}().`);
  }
}

function journalEntry(step, state) {
  return Object.freeze({ step, state });
}

export function createPostgresqlServiceCore(adapter) {
  for (const name of [
    "inspect",
    "validateToolchain",
    "prepareCredentials",
    "initializeCluster",
    "configureCluster",
    "registerService",
    "startService",
    "provisionCatalog",
    "commitCredentials",
    "rollbackCredentials",
  ]) {
    requireFunction(adapter, name);
  }

  async function installOrRepair(input) {
    const manifest = createPostgresqlPackageManifest(input.runtimeConfig);
    const journal = [];
    let credentialToken;
    let committedToken;
    let observed;
    try {
      observed = await adapter.inspect({ ...input, manifest });
      journal.push(journalEntry("INSPECT", "COMPLETE"));
      await adapter.validateToolchain({ ...input, manifest, observed });
      journal.push(journalEntry("VALIDATE_TOOLCHAIN", "COMPLETE"));
      if (observed.fresh && typeof adapter.assertPortAvailable === "function") {
        await adapter.assertPortAvailable({ ...input, manifest, observed });
        journal.push(journalEntry("VALIDATE_PORT", "COMPLETE"));
      }
      credentialToken = await adapter.prepareCredentials({ ...input, manifest, observed });
      journal.push(journalEntry("PREPARE_CREDENTIALS", "COMPLETE"));
      if (observed.fresh) {
        await adapter.initializeCluster({ ...input, manifest, observed, credentialToken });
        journal.push(journalEntry("INITIALIZE_CLUSTER", "COMPLETE"));
      }
      await adapter.configureCluster({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("CONFIGURE_CLUSTER", "COMPLETE"));
      await adapter.registerService({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("REGISTER_SERVICE", "COMPLETE"));
      await adapter.startService({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("START_SERVICE", "COMPLETE"));
      await adapter.provisionCatalog({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("PROVISION_CATALOG", "COMPLETE"));
      committedToken = await adapter.commitCredentials({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("COMMIT_CREDENTIALS", "COMPLETE"));
      if (typeof adapter.activateCredentials === "function") {
        await adapter.activateCredentials({ ...input, manifest, observed, committedToken });
        journal.push(journalEntry("ACTIVATE_CREDENTIALS", "COMPLETE"));
      }
      return Object.freeze({
        fresh: Boolean(observed.fresh),
        flavor: manifest.flavor,
        roles: manifest.roles.length,
        databases: manifest.databases.length,
        serviceName: observed.serviceName,
        clusterDirectory: observed.clusterDirectory,
        journal: Object.freeze(journal),
      });
    } catch (error) {
      const rollbackToken = committedToken ?? credentialToken;
      if (rollbackToken) {
        try {
          await adapter.rollbackCredentials({
            ...input,
            manifest,
            observed,
            credentialToken,
            committedToken,
          });
          journal.push(journalEntry("ROLLBACK_CREDENTIALS", "COMPLETE"));
        } catch {
          journal.push(journalEntry("ROLLBACK_CREDENTIALS", "FAILED"));
        }
      }
      if (observed?.fresh && typeof adapter.rollbackFreshCluster === "function") {
        try {
          await adapter.rollbackFreshCluster({ ...input, manifest, observed });
          journal.push(journalEntry("ROLLBACK_FRESH_CLUSTER", "COMPLETE"));
        } catch {
          journal.push(journalEntry("ROLLBACK_FRESH_CLUSTER", "FAILED"));
        }
      }
      throw new PostgresqlServiceCoreError(
        "POSTGRESQL_SERVICE_SETUP_FAILED",
        "QuickHack PostgreSQL setup did not complete. Existing data was not deleted.",
        { cause: error, journal: Object.freeze(journal) }
      );
    } finally {
      if (credentialToken && typeof adapter.disposeCredentials === "function") {
        await adapter.disposeCredentials(credentialToken).catch(() => undefined);
      }
    }
  }

  return Object.freeze({ installOrRepair });
}
