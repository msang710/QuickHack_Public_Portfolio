import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  POSTGRESQL_MAJOR_VERSION,
  createPostgresqlBackup,
  inspectPostgresqlToolchain,
  listPostgresqlBackups,
  restorePostgresqlBackup,
  verifyPostgresqlBackupsAndApplyRetention,
  withInspectedPostgresqlBackup,
} from "../../quickhack_server/core/database/postgresql-native-operations.mjs";
import { planPostgresqlCutoverRecovery } from "../../tools/postgresql-restore.mjs";
import { linuxServerProcessExecution } from "../../quickhack_server/platform/linux/process-execution.ts";
import { windowsServerProcessExecution } from "../../quickhack_server/platform/windows/process-execution.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickhack-pg-native-"));
const backupDirectory = path.join(root, "backups");
const privateDirectory = path.join(root, "private");
const connectionString = "postgresql://backup:secret@127.0.0.1:5432/quickhack";
const toolCalls = [];
const processExecution = process.platform === "win32"
  ? windowsServerProcessExecution
  : linuxServerProcessExecution;

const executableExtension = process.platform === "win32" ? ".exe" : "";
const toolchainDirectory = path.join(root, "toolchain");
await fs.mkdir(toolchainDirectory);
for (const tool of ["psql", "pg_dump", "pg_restore"]) {
  await fs.writeFile(path.join(toolchainDirectory, `${tool}${executableExtension}`), "fixture");
}
const inspected = await inspectPostgresqlToolchain({
  binDirectory: toolchainDirectory,
  capability: "backup",
  processExecution,
  runVersion: ({ tool }) => `${tool} (PostgreSQL) 18.4`,
});
assert.equal(inspected.major, 18);
await assert.rejects(
  inspectPostgresqlToolchain({
    binDirectory: toolchainDirectory,
    capability: "backup",
    processExecution,
    runVersion: ({ tool }) =>
      `${tool} (PostgreSQL) ${tool === "pg_dump" ? "17.9" : "18.4"}`,
  }),
  (error) => error?.code === "DEPENDENCY_VERSION_MISMATCH"
);
await fs.rm(path.join(toolchainDirectory, `psql${executableExtension}`));
await assert.rejects(
  inspectPostgresqlToolchain({
    binDirectory: toolchainDirectory,
    capability: "backup",
    processExecution,
    runVersion: ({ tool }) => `${tool} (PostgreSQL) 18.4`,
  }),
  (error) => error?.code === "POSTGRESQL_NATIVE_TOOL_MISSING"
);

assert.equal(
  planPostgresqlCutoverRecovery({
    expectedInstanceEpoch: 2,
    liveEpoch: 2,
    stagingEpoch: null,
    previousEpoch: 1,
  }),
  "COMPLETE_ACTIVATED"
);
assert.equal(
  planPostgresqlCutoverRecovery({
    expectedInstanceEpoch: 2,
    liveEpoch: null,
    stagingEpoch: 2,
    previousEpoch: 1,
  }),
  "ACTIVATE_STAGING"
);
assert.equal(
  planPostgresqlCutoverRecovery({
    expectedInstanceEpoch: 2,
    liveEpoch: 1,
    stagingEpoch: 2,
    previousEpoch: null,
  }),
  "MOVE_LIVE_AND_ACTIVATE_STAGING"
);
assert.equal(
  planPostgresqlCutoverRecovery({
    expectedInstanceEpoch: 2,
    liveEpoch: null,
    stagingEpoch: null,
    previousEpoch: 1,
  }),
  "ROLLBACK_PREVIOUS"
);
assert.throws(() =>
  planPostgresqlCutoverRecovery({
    expectedInstanceEpoch: 2,
    liveEpoch: 1,
    stagingEpoch: 2,
    previousEpoch: 1,
  })
);

async function fakeTool(input) {
  toolCalls.push({ tool: input.tool, args: [...input.args] });
  if (input.tool === "pg_dump") {
    const outputIndex = input.args.indexOf("--file");
    await fs.writeFile(input.args[outputIndex + 1], "PGDMP\0quickhack-test", {
      mode: 0o600,
    });
  }
  return { stdout: "", stderr: "" };
}

async function encryptFile(source, target) {
  const input = await fs.readFile(source);
  await fs.writeFile(target, Buffer.concat([Buffer.from("QHENC"), input]), {
    flag: "wx",
    mode: 0o600,
  });
}

async function decryptFile(source, target) {
  const input = await fs.readFile(source);
  assert.equal(input.subarray(0, 5).toString("utf8"), "QHENC");
  await fs.writeFile(target, input.subarray(5), { flag: "wx", mode: 0o600 });
}

try {
  const first = await createPostgresqlBackup({
    connectionString,
    binDirectory: root,
    privateDirectory,
    backupDirectory,
    applicationVersion: "1.0.0",
    schemaVersion: "20260811010000_postgresql_baseline",
    encryptFile,
    runTool: fakeTool,
    now: new Date("2026-08-14T00:00:00.000Z"),
  });
  assert.match(first.backup.fileName, /^quickhack-postgresql-.+\.qhb$/);
  assert.equal(first.backup.postgresqlMajor, POSTGRESQL_MAJOR_VERSION);
  assert.equal(first.backup.postgresqlMajor, 18);
  assert.equal((await listPostgresqlBackups(backupDirectory)).length, 1);
  assert.equal(
    toolCalls.some((call) =>
      call.args.some((argument) => String(argument).includes("secret"))
    ),
    false,
    "A database password entered native tool arguments."
  );

  await withInspectedPostgresqlBackup({
    backupDirectory,
    fileName: first.backup.fileName,
    connectionString,
    binDirectory: root,
    privateDirectory,
    decryptFile,
    runTool: fakeTool,
    operation: async ({ manifest }) => {
      assert.equal(manifest.database, "quickhack");
    },
  });

  const firstManifestPath = path.join(backupDirectory, `${first.backup.fileName}.json`);
  const firstManifest = JSON.parse(await fs.readFile(firstManifestPath, "utf8"));
  await fs.writeFile(
    firstManifestPath,
    `${JSON.stringify({ ...firstManifest, postgresqlMajor: 17 }, null, 2)}\n`
  );
  await assert.rejects(
    withInspectedPostgresqlBackup({
      backupDirectory,
      fileName: first.backup.fileName,
      connectionString,
      binDirectory: root,
      privateDirectory,
      decryptFile,
      runTool: fakeTool,
      operation: async () => undefined,
    }),
    (error) => error?.code === "POSTGRESQL_BACKUP_VERSION_UNSUPPORTED"
  );
  await fs.writeFile(firstManifestPath, `${JSON.stringify(firstManifest, null, 2)}\n`);

  await createPostgresqlBackup({
    connectionString,
    binDirectory: root,
    privateDirectory,
    backupDirectory,
    applicationVersion: "1.0.0",
    schemaVersion: "20260811010000_postgresql_baseline",
    encryptFile,
    runTool: fakeTool,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  const verification = await verifyPostgresqlBackupsAndApplyRetention({
    backupDirectory,
    connectionString,
    binDirectory: root,
    privateDirectory,
    retentionCount: 1,
    decryptFile,
    runTool: fakeTool,
  });
  assert.equal(verification.verifiedCount, 2);
  const retained = await listPostgresqlBackups(backupDirectory);
  assert.equal(retained.length, 1);
  assert.notEqual(retained[0].fileName, first.backup.fileName);

  const restoreSql = [];
  const cutoverPhases = [];
  const restoreResult = await restorePostgresqlBackup({
    backupDirectory,
    fileName: retained[0].fileName,
    operatorConnectionString:
      "postgresql://operator:secret@127.0.0.1:5432/postgres",
    binDirectory: root,
    privateDirectory,
    expectedDatabase: "quickhack",
    restoredDatabaseOwner: "quickhack_migrator",
    expectedApplicationVersion: "1.0.0",
    expectedSchemaVersion: "20260811010000_postgresql_baseline",
    decryptFile,
    runTool: async (input) => {
      if (input.tool === "psql") {
        restoreSql.push(input.args[input.args.indexOf("--command") + 1]);
      }
      return fakeTool(input);
    },
    onStagingRestored: async ({ stagingDatabase }) => ({ stagingDatabase }),
    onCutoverPhase: async ({ phase }) => { cutoverPhases.push(phase); },
  });
  assert.equal(restoreResult.restored, true);
  assert.equal(
    toolCalls.some(
      (call) =>
        call.tool === "pg_restore" &&
        call.args.includes("--dbname") &&
        call.args.includes("--no-owner")
    ),
    false,
    "Restore discarded the migrator ownership recorded in the archive."
  );
  assert.equal(restoreSql.some((sql) => sql.includes("CREATE DATABASE")), true);
  assert.equal(restoreSql.some((sql) => sql.includes("ALTER DATABASE")), true);
  assert.equal(
    restoreSql.filter((sql) => /ALTER DATABASE .* RENAME TO/.test(sql)).length,
    2,
    "Database rename cutover must use two resumable PostgreSQL transactions."
  );
  assert.equal(
    restoreSql.some(
      (sql) => (sql.match(/ALTER DATABASE/g) ?? []).length > 1
    ),
    false,
    "PostgreSQL database rename cannot run in a multi-statement transaction."
  );
  assert.equal(
    restoreSql.some((sql) => sql.includes('OWNER TO "quickhack_migrator"')),
    true
  );
  assert.equal(restoreSql.some((sql) => sql.includes("DROP DATABASE")), true);
  assert.deepEqual(cutoverPhases, [
    "STAGING_READY",
    "LIVE_RENAMED",
    "DATABASE_ACTIVATED",
    "CUTOVER_COMPLETE",
  ]);

  const failedRestoreSql = [];
  await assert.rejects(
    restorePostgresqlBackup({
      backupDirectory,
      fileName: retained[0].fileName,
      operatorConnectionString:
        "postgresql://operator:secret@127.0.0.1:5432/postgres",
      binDirectory: root,
      privateDirectory,
      expectedDatabase: "quickhack",
      restoredDatabaseOwner: "quickhack_migrator",
      expectedApplicationVersion: "1.0.0",
      expectedSchemaVersion: "20260811010000_postgresql_baseline",
      decryptFile,
      runTool: async (input) => {
        if (input.tool === "psql") {
          failedRestoreSql.push(input.args[input.args.indexOf("--command") + 1]);
        }
        if (input.tool === "pg_restore" && input.args.includes("--dbname")) {
          throw new Error("injected restore failure");
        }
        return fakeTool(input);
      },
    })
  );
  assert.equal(
    failedRestoreSql.some((sql) => sql.includes("DROP DATABASE IF EXISTS")),
    true,
    "A failed staging restore was not cleaned up."
  );

  const failedCutoverSql = [];
  const failedCutoverPhases = [];
  let cutoverFailureInjected = false;
  await assert.rejects(
    restorePostgresqlBackup({
      backupDirectory,
      fileName: retained[0].fileName,
      operatorConnectionString:
        "postgresql://operator:secret@127.0.0.1:5432/postgres",
      binDirectory: root,
      privateDirectory,
      expectedDatabase: "quickhack",
      restoredDatabaseOwner: "quickhack_migrator",
      expectedApplicationVersion: "1.0.0",
      expectedSchemaVersion: "20260811010000_postgresql_baseline",
      decryptFile,
      runTool: async (input) => {
        if (input.tool === "psql") {
          const sql = input.args[input.args.indexOf("--command") + 1];
          failedCutoverSql.push(sql);
          if (
            !cutoverFailureInjected &&
            /ALTER DATABASE "qh_restore_[a-z0-9]+" RENAME TO "quickhack"/.test(sql)
          ) {
            cutoverFailureInjected = true;
            throw new Error("injected cutover failure");
          }
        }
        return fakeTool(input);
      },
      onStagingRestored: async () => ({ barrierReady: true }),
      onCutoverPhase: async ({ phase }) => { failedCutoverPhases.push(phase); },
    })
  );
  assert.equal(
    failedCutoverSql.some((sql) => sql.includes("DROP DATABASE IF EXISTS")),
    true,
    "A failed pre-commit cutover was not cleaned up."
  );
  assert.deepEqual(failedCutoverPhases, [
    "STAGING_READY",
    "LIVE_RENAMED",
    "ROLLED_BACK",
  ]);

  const payloadPath = path.join(backupDirectory, retained[0].fileName);
  await fs.appendFile(payloadPath, "corruption");
  await assert.rejects(
    withInspectedPostgresqlBackup({
      backupDirectory,
      fileName: retained[0].fileName,
      connectionString,
      binDirectory: root,
      privateDirectory,
      decryptFile,
      runTool: fakeTool,
      operation: async () => undefined,
    }),
    (error) => error?.code === "POSTGRESQL_BACKUP_CORRUPT"
  );

  const failedDirectory = path.join(root, "failed-publication");
  await assert.rejects(
    createPostgresqlBackup({
      connectionString,
      binDirectory: root,
      privateDirectory,
      backupDirectory: failedDirectory,
      applicationVersion: "1.0.0",
      schemaVersion: "20260811010000_postgresql_baseline",
      encryptFile: async () => { throw new Error("injected encryption failure"); },
      runTool: fakeTool,
    })
  );
  const failedEntries = await fs.readdir(failedDirectory);
  assert.equal(failedEntries.some((name) => name.endsWith(".qhb")), false);
  assert.equal(failedEntries.some((name) => name.endsWith(".qhb.json")), false);

  const retentionSafetyDirectory = path.join(root, "retention-safety");
  for (const createdAt of [
    "2026-08-16T00:00:00.000Z",
    "2026-08-17T00:00:00.000Z",
  ]) {
    await createPostgresqlBackup({
      connectionString,
      binDirectory: root,
      privateDirectory,
      backupDirectory: retentionSafetyDirectory,
      applicationVersion: "1.0.0",
      schemaVersion: "20260811010000_postgresql_baseline",
      encryptFile,
      runTool: fakeTool,
      now: new Date(createdAt),
    });
  }
  const safetyCandidates = await listPostgresqlBackups(retentionSafetyDirectory);
  const corruptPath = path.join(retentionSafetyDirectory, safetyCandidates[0].fileName);
  const corruptPayload = await fs.readFile(corruptPath);
  corruptPayload[corruptPayload.length - 1] ^= 0xff;
  await fs.writeFile(corruptPath, corruptPayload);
  await assert.rejects(
    verifyPostgresqlBackupsAndApplyRetention({
      backupDirectory: retentionSafetyDirectory,
      connectionString,
      binDirectory: root,
      privateDirectory,
      retentionCount: 1,
      decryptFile,
      runTool: fakeTool,
    }),
    (error) => error?.code === "POSTGRESQL_BACKUP_CORRUPT"
  );
  assert.equal(
    (await listPostgresqlBackups(retentionSafetyDirectory)).length,
    2,
    "A failed integrity pass deleted a recoverable backup."
  );

  console.log(
    "PostgreSQL native backup publication, integrity, retention, and staged restore contracts verified."
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
