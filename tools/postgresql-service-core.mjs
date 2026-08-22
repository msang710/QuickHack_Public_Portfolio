import { createPostgresqlPackageManifest } from "../quickhack_shared/core/package-flavor-contract.mjs";

const POSTGRESQL_SETUP_CATEGORY_CODE = "POSTGRESQL_SERVICE_SETUP_FAILED";
const POSTGRESQL_SETUP_STEPS = new Set([
  "INSPECT",
  "VALIDATE_TOOLCHAIN",
  "VALIDATE_PORT",
  "PREPARE_CREDENTIALS",
  "INITIALIZE_CLUSTER",
  "CONFIGURE_CLUSTER",
  "REGISTER_SERVICE",
  "START_SERVICE",
  "PROVISION_CATALOG",
  "COMMIT_CREDENTIALS",
  "ACTIVATE_CREDENTIALS",
]);

function postgresqlSetupFailureCode(step) {
  if (!POSTGRESQL_SETUP_STEPS.has(step)) return POSTGRESQL_SETUP_CATEGORY_CODE;
  return `POSTGRESQL_${step}_FAILED`;
}

export class PostgresqlServiceCoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PostgresqlServiceCoreError";
    this.code = code;
    this.categoryCode = options.categoryCode ?? code;
    this.failedStep = options.failedStep ?? null;
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
    let activeStep = "INSPECT";
    try {
      activeStep = "INSPECT";
      observed = await adapter.inspect({ ...input, manifest });
      journal.push(journalEntry("INSPECT", "COMPLETE"));
      activeStep = "VALIDATE_TOOLCHAIN";
      await adapter.validateToolchain({ ...input, manifest, observed });
      journal.push(journalEntry("VALIDATE_TOOLCHAIN", "COMPLETE"));
      if (observed.fresh && typeof adapter.assertPortAvailable === "function") {
        activeStep = "VALIDATE_PORT";
        await adapter.assertPortAvailable({ ...input, manifest, observed });
        journal.push(journalEntry("VALIDATE_PORT", "COMPLETE"));
      }
      activeStep = "PREPARE_CREDENTIALS";
      credentialToken = await adapter.prepareCredentials({ ...input, manifest, observed });
      journal.push(journalEntry("PREPARE_CREDENTIALS", "COMPLETE"));
      if (observed.fresh) {
        activeStep = "INITIALIZE_CLUSTER";
        await adapter.initializeCluster({ ...input, manifest, observed, credentialToken });
        journal.push(journalEntry("INITIALIZE_CLUSTER", "COMPLETE"));
      }
      activeStep = "CONFIGURE_CLUSTER";
      await adapter.configureCluster({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("CONFIGURE_CLUSTER", "COMPLETE"));
      activeStep = "REGISTER_SERVICE";
      await adapter.registerService({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("REGISTER_SERVICE", "COMPLETE"));
      activeStep = "START_SERVICE";
      await adapter.startService({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("START_SERVICE", "COMPLETE"));
      activeStep = "PROVISION_CATALOG";
      await adapter.provisionCatalog({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("PROVISION_CATALOG", "COMPLETE"));
      activeStep = "COMMIT_CREDENTIALS";
      committedToken = await adapter.commitCredentials({ ...input, manifest, observed, credentialToken });
      journal.push(journalEntry("COMMIT_CREDENTIALS", "COMPLETE"));
      if (typeof adapter.activateCredentials === "function") {
        activeStep = "ACTIVATE_CREDENTIALS";
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
        postgresqlSetupFailureCode(activeStep),
        "QuickHack PostgreSQL setup did not complete. Existing data was not deleted.",
        {
          cause: error,
          categoryCode: POSTGRESQL_SETUP_CATEGORY_CODE,
          failedStep: activeStep,
          journal: Object.freeze(journal),
        }
      );
    } finally {
      if (credentialToken && typeof adapter.disposeCredentials === "function") {
        await adapter.disposeCredentials(credentialToken).catch(() => undefined);
      }
    }
  }

  return Object.freeze({ installOrRepair });
}
