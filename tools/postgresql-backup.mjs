import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import {
  createPostgresqlBackup,
  verifyPostgresqlBackupsAndApplyRetention,
} from "../quickhack_server/core/database/postgresql-native-operations.mjs";
import { resolvePostgresqlConnectionStringSync } from "../quickhack_server/core/database/postgresql-credential.mjs";
import {
  decryptBackupFile,
  encryptBackupFile,
} from "../quickhack_server/security/backup-encryption-core.mjs";
import { createBackupKeyProvider } from "../quickhack_server/security/backup-key-provider-core.mjs";
import { readServerRuntimeConfigSync } from "../quickhack_shared/core/server-runtime-config.mjs";
import { composeServerPlatform } from "../quickhack_server/platform/compose-server-platform.ts";

const SCHEMA_VERSION = "20260811010000_postgresql_baseline";
const serverPlatform = composeServerPlatform();
const serverProcessExecution = serverPlatform.processExecution;

function parseArguments(argv) {
  const values = { command: "create", installDir: "", runtimeConfig: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "create" || argument === "verify") values.command = argument;
    else if (argument === "--install-dir") values.installDir = argv[++index] || "";
    else if (argument === "--runtime-config") values.runtimeConfig = argv[++index] || "";
    else throw new Error(`Unsupported argument: ${argument}`);
  }
  if (!values.installDir || !values.runtimeConfig) {
    throw new Error("Backup requires install dir and runtime config.");
  }
  return {
    ...values,
    installDir: path.resolve(values.installDir),
    runtimeConfig: path.resolve(values.runtimeConfig),
  };
}

function operationContext(input) {
  const runtime = readServerRuntimeConfigSync({
    configPath: input.runtimeConfig,
    kind: "operational",
  }).config;
  const backupDirectory = path.join(runtime.dataDirectory, "backups");
  const privateDirectory = path.join(
    runtime.dataDirectory,
    "security",
    "postgresql-operations"
  );
  const provider = createBackupKeyProvider({
    dataDir: runtime.dataDirectory,
    backupDirectory,
    secretProtector: serverPlatform.secretProtector,
  });
  return {
    runtime,
    provider,
    backupDirectory,
    privateDirectory,
    binDirectory: path.join(input.installDir, "runtime", "postgresql", "bin"),
    connectionString: resolvePostgresqlConnectionStringSync({
      role: "backup",
      applicationName: `quickhack-native-backup-${input.command}`,
    }),
  };
}

async function requireReadyKey(provider) {
  const status = await provider.getStatus();
  if (status.state !== "READY") throw new Error(status.message);
}

export async function runOperationalPostgresqlBackup(input) {
  const context = operationContext(input);
  await requireReadyKey(context.provider);
  if (input.command === "create") {
    const created = await createPostgresqlBackup({
      connectionString: context.connectionString,
      binDirectory: context.binDirectory,
      privateDirectory: context.privateDirectory,
      backupDirectory: context.backupDirectory,
      applicationVersion: packageJson.version,
      schemaVersion: SCHEMA_VERSION,
      encryptFile: (source, target) =>
        context.provider.withKey((key) => encryptBackupFile(source, target, key)),
      processExecution: serverProcessExecution,
    });
    const integrity = await verifyAll(context);
    return { ...created, ...integrity };
  }
  return verifyAll(context);
}

function verifyAll(context) {
  return verifyPostgresqlBackupsAndApplyRetention({
    backupDirectory: context.backupDirectory,
    connectionString: context.connectionString,
    binDirectory: context.binDirectory,
    privateDirectory: context.privateDirectory,
    retentionCount: context.runtime.backupRetentionCount,
    decryptFile: (source, target) =>
      context.provider.withKey((key) => decryptBackupFile(source, target, key)),
    processExecution: serverProcessExecution,
  });
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const input = parseArguments(process.argv.slice(2));
    const result = await runOperationalPostgresqlBackup(input);
    if (input.command === "create") {
      console.log(`QuickHack PostgreSQL backup created: ${result.backup.fileName}`);
    } else {
      console.log(`QuickHack PostgreSQL backups verified: ${result.verifiedCount}`);
    }
  } catch (error) {
    console.error(
      `QuickHack PostgreSQL backup failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
