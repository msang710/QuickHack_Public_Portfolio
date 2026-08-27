import fs from "node:fs";
import path from "node:path";
import packageJson from "@/package.json" with { type: "json" };
import {
  createPostgresqlBackup,
  inspectPostgresqlToolchain,
  listPostgresqlBackupQuarantines,
  listPostgresqlBackups,
  verifyPostgresqlBackupsAndApplyRetention,
} from "@/quickhack_server/core/database/postgresql-native-operations.mjs";
import { POSTGRESQL_MAJOR_VERSION } from "@/quickhack_shared/platform/native-runtime-contract.mjs";
import { resolvePostgresqlConnectionStringSync } from "@/quickhack_server/core/database/postgresql-credential.mjs";
import {
  decryptBackupFile,
  encryptBackupFile,
} from "@/quickhack_server/security/backup-encryption";
import { getRuntimeConfig } from "@/quickhack_shared/core/runtime";
import { composeServerPlatform } from "@/quickhack_server/platform/compose-server-platform";
import { QUICKHACK_POSTGRESQL_SCHEMA_VERSION } from "@/quickhack_shared/core/postgresql-schema-contract.mjs";

export { QUICKHACK_POSTGRESQL_SCHEMA_VERSION };

const serverProcessExecution = composeServerPlatform().processExecution;

export function resolvePostgresqlBinDirectory() {
  const runtime = getRuntimeConfig();
  const candidates = serverProcessExecution.postgresqlBinDirectories({
    appRoot: runtime.paths.appRoot,
    nodeExecutable: process.execPath,
    environment: process.env,
    majorVersion: POSTGRESQL_MAJOR_VERSION,
  });

  const found = candidates.find((candidate) =>
    (["pg_dump", "pg_restore", "psql"] as const).every((tool) => {
      try {
        const stat = fs.lstatSync(
          serverProcessExecution.postgresqlExecutable(candidate, tool)
        );
        return stat.isFile() && !stat.isSymbolicLink();
      } catch {
        return false;
      }
    })
  );
  if (!found) {
    throw new Error(
      `PostgreSQL ${POSTGRESQL_MAJOR_VERSION} native backup tools were not found in the QuickHack server runtime.`
    );
  }
  return path.resolve(found);
}

export async function inspectOperationalPostgresqlBinDirectory() {
  const binDirectory = resolvePostgresqlBinDirectory();
  await inspectPostgresqlToolchain({
    binDirectory,
    capability: "backup",
    processExecution: serverProcessExecution,
  });
  return binDirectory;
}

export function postgresqlBackupPaths() {
  const runtime = getRuntimeConfig();
  return {
    backupDirectory: path.join(runtime.paths.dataDir, "backups"),
    privateDirectory: path.join(
      runtime.paths.dataDir,
      "security",
      "postgresql-operations"
    ),
    binDirectory: resolvePostgresqlBinDirectory(),
    processExecution: serverProcessExecution,
  };
}

export async function createOperationalPostgresqlBackup(input: {
  operationId?: string;
} = {}) {
  const paths = postgresqlBackupPaths();
  const created = await createPostgresqlBackup({
    connectionString: resolvePostgresqlConnectionStringSync({
      role: "backup",
      applicationName: "quickhack-native-backup",
    }),
    ...paths,
    applicationVersion: packageJson.version,
    schemaVersion: QUICKHACK_POSTGRESQL_SCHEMA_VERSION,
    encryptFile: encryptBackupFile,
    operationId: input.operationId,
  });
  const integrity = await verifyOperationalPostgresqlBackups({
    requiredFileName: created.backup.fileName,
  });
  const quarantined = [
    ...created.prePublicationQuarantined,
    ...integrity.quarantined,
  ];
  return {
    ...created,
    ...integrity,
    quarantined,
    quarantinedCount: quarantined.length,
    warningCount: quarantined.length,
  };
}

export async function listOperationalPostgresqlBackups() {
  const runtime = getRuntimeConfig();
  return listPostgresqlBackups(
    path.join(runtime.paths.dataDir, "backups")
  );
}

export async function enforceOperationalPostgresqlBackupRetention() {
  return (await verifyOperationalPostgresqlBackups()).retention;
}

export async function verifyOperationalPostgresqlBackups(input: {
  requiredFileName?: string | null;
} = {}) {
  const paths = postgresqlBackupPaths();
  const connectionString = resolvePostgresqlConnectionStringSync({
    role: "backup",
    applicationName: "quickhack-backup-integrity",
  });
  const runtime = getRuntimeConfig();
  return verifyPostgresqlBackupsAndApplyRetention({
    ...paths,
    connectionString,
    retentionCount: runtime.serverConfig?.backupRetentionCount ?? 30,
    decryptFile: decryptBackupFile,
    requiredFileName: input.requiredFileName ?? null,
  });
}

export async function listOperationalPostgresqlBackupQuarantines() {
  const runtime = getRuntimeConfig();
  return listPostgresqlBackupQuarantines(
    path.join(runtime.paths.dataDir, "backups")
  );
}
