import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClientPrintSpoolError,
  acknowledgeClientPrintSpoolRecovery,
  armClientPrintSpoolAttempt,
  createPrivatePrintSpoolFile,
  getClientPrintSpoolPaths,
  initializeClientPrintSpool,
  inspectClientPrintSpoolRecovery,
  parseClientPrintSpoolFileName,
  pruneAcknowledgedClientPrintArtifacts,
  removePrivatePrintSpoolFile,
} from "../../tools/client-print-spool-core.mjs";
import { LOGEN_LABEL_TEMPLATE } from "@/quickhack_shared/shipment/logen-label";

const root = await mkdtemp(path.join(os.tmpdir(), "quickhack-print-spool-"));
const clientDataDir = process.platform === "win32"
  ? path.join(root, "QuickHack", "client")
  : path.join(root, "quickhack");
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const requestKey = "LOGEN-LABEL-77-123e4567-e89b-42d3-a456-426614174000";
const payloadHash = "b".repeat(64);
const trackingNumber = "12345678901";
const sensitiveText = "RECIPIENT-PRIVATE-TEXT";

try {
  const initial = await initializeClientPrintSpool({
    clientDataDir,
    platform: "linux",
  });
  assert.equal(initial.recoveredCount, 0);
  assert.equal(initial.skippedCount, 0);

  const bitmap = Buffer.alloc(
    (LOGEN_LABEL_TEMPLATE.widthDots / 8) *
      LOGEN_LABEL_TEMPLATE.lengthDots
  );
  bitmap.write(sensitiveText, 0, "ascii");
  if (process.platform === "win32") {
    process.env.LOCALAPPDATA = root;
  } else {
    process.env.XDG_STATE_HOME = root;
  }
  process.env.QUICKHACK_PRINT_SPOOL_INITIALIZED = "1";
  delete process.env.QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_CODE;
  delete process.env.QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_MESSAGE;
  const printerService = await import(
    "@/quickhack_client/printing/printer-service"
  );
  const labels = [
    {
      issueItemId: 1,
      issueSequence: 1,
      trackingNumber,
      bitmapBase64: bitmap.toString("base64"),
    },
  ];
  const payload = printerService.buildLogenTsplForTest(
    { printerName: "TSC DA200" },
    labels
  );
  const contentHash = (
    await import("node:crypto")
  ).createHash("sha256").update(payload).digest("hex");
  assert.deepEqual(
    parseClientPrintSpoolFileName(`${requestKey}-${contentHash}.bin`),
    { requestKey, contentHash }
  );
  assert.equal(
    parseClientPrintSpoolFileName(`${requestKey}-${contentHash}.bin.extra`),
    null
  );

  const spoolPath = await createPrivatePrintSpoolFile({
    clientDataDir,
    requestKey,
    contentHash,
    payload,
    platform: "linux",
  });
  if (process.platform !== "win32") {
    assert.equal((await lstat(spoolPath)).mode & 0o777, 0o600);
  }
  await assert.rejects(
    createPrivatePrintSpoolFile({
      clientDataDir,
      requestKey,
      contentHash,
      payload,
      platform: "linux",
    }),
    (error) =>
      error instanceof ClientPrintSpoolError &&
      error.code === "PRINT_SPOOL_FILE_CREATE_FAILED"
  );

  const { spoolDir, recoveryDir, recoveryIndexDir, jobsDir } =
    getClientPrintSpoolPaths({ clientDataDir });
  await writeFile(path.join(spoolDir, "do-not-delete.txt"), sensitiveText);
  const outsideTarget = path.join(root, "outside-sensitive.txt");
  await writeFile(outsideTarget, sensitiveText);
  let symlinkCreated = false;
  try {
    await symlink(
      outsideTarget,
      path.join(
        spoolDir,
        "LOGEN-LABEL-78-123e4567-e89b-42d3-a456-426614174001-" +
          `${"c".repeat(64)}.bin`
      ),
      "file"
    );
    symlinkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(String(error?.code))) {
      throw error;
    }
  }

  const recovered = await initializeClientPrintSpool({
    clientDataDir,
    platform: "linux",
    now: () => new Date("2026-07-31T01:02:03.000Z"),
  });
  assert.equal(recovered.recoveredCount, 1);
  assert.equal(recovered.skippedCount, symlinkCreated ? 2 : 1);
  assert.equal(
    (await readFile(outsideTarget, "utf8")),
    sensitiveText,
    "Startup cleanup followed and modified a symlink target."
  );
  assert(
    (await readdir(spoolDir)).includes("do-not-delete.txt"),
    "Startup cleanup deleted a filename outside the strict spool contract."
  );

  const recovery = await inspectClientPrintSpoolRecovery({
    clientDataDir,
    requestKey,
    contentHash,
  });
  assert.equal(recovery.status, "MATCH");
  assert.equal(recovery.marker?.status, "UNKNOWN");
  assert.equal(recovery.marker?.reasonCode, "ORPHANED_PRINT_SPOOL");
  const conflicting = await inspectClientPrintSpoolRecovery({
    clientDataDir,
    requestKey,
    contentHash: "d".repeat(64),
  });
  assert.equal(conflicting.status, "CONFLICT");
  const markerSource = (
    await Promise.all(
      (await readdir(recoveryIndexDir)).map((name) =>
        readFile(path.join(recoveryIndexDir, name), "utf8")
      )
    )
  ).join("\n");
  assert(!markerSource.includes(sensitiveText));
  assert(!markerSource.includes(trackingNumber));
  assert(!markerSource.includes("TSC DA200"));

  const legacyRequestKey =
    "LOGEN-LABEL-81-123e4567-e89b-42d3-a456-426614174004";
  const legacyHash = "1".repeat(64);
  await writeFile(
    path.join(
      recoveryDir,
      `${legacyRequestKey}-${legacyHash}.unknown.json`
    ),
    `${JSON.stringify({
      version: 1,
      status: "UNKNOWN",
      reasonCode: "PRINT_ATTEMPT_STARTED",
      requestKey: legacyRequestKey,
      contentHash: legacyHash,
      recoveredAt: "2026-07-31T01:02:03.000Z",
    })}\n`,
    "utf8"
  );
  const legacyMigration = await initializeClientPrintSpool({
    clientDataDir,
    platform: "linux",
  });
  assert.equal(legacyMigration.migratedRecoveryCount, 1);
  assert.equal(
    (
      await inspectClientPrintSpoolRecovery({
        clientDataDir,
        requestKey: legacyRequestKey,
        contentHash: legacyHash,
      })
    ).status,
    "MATCH",
    "A legacy recovery marker was not migrated into the direct index."
  );
  assert(
    !(await readdir(recoveryDir)).includes(
      `${legacyRequestKey}-${legacyHash}.unknown.json`
    ),
    "A durable indexed marker did not replace its legacy marker."
  );

  const legacyConflictRequestKey =
    "LOGEN-LABEL-82-123e4567-e89b-42d3-a456-426614174005";
  for (const legacyConflictHash of ["2".repeat(64), "3".repeat(64)]) {
    await writeFile(
      path.join(
        recoveryDir,
        `${legacyConflictRequestKey}-${legacyConflictHash}.unknown.json`
      ),
      `${JSON.stringify({
        version: 1,
        status: "UNKNOWN",
        reasonCode: "PRINT_ATTEMPT_STARTED",
        requestKey: legacyConflictRequestKey,
        contentHash: legacyConflictHash,
        recoveredAt: "2026-07-31T01:02:03.000Z",
      })}\n`,
      "utf8"
    );
  }
  const conflictMigration = await initializeClientPrintSpool({
    clientDataDir,
    platform: "linux",
  });
  assert.equal(conflictMigration.conflictedRecoveryCount, 1);
  assert.equal(
    (
      await inspectClientPrintSpoolRecovery({
        clientDataDir,
        requestKey: legacyConflictRequestKey,
        contentHash: "2".repeat(64),
      })
    ).status,
    "CONFLICT",
    "Conflicting legacy markers did not remain fail-closed."
  );

  const job = await printerService.printLogenLabels({
    requestKey,
    payloadHash,
    printerName: "TSC DA200",
    labels,
  });
  assert.equal(job.status, "UNKNOWN");
  assert.equal(job.errorCode, "ORPHANED_PRINT_SPOOL_RECOVERED");
  assert.equal(
    (await printerService.printLogenLabels({
      requestKey,
      payloadHash,
      printerName: "TSC DA200",
      labels,
    })).status,
    "UNKNOWN",
    "The recovered request did not remain idempotently UNKNOWN."
  );
  const acknowledgedRecoveredJob =
    await printerService.acknowledgeLocalPrintJob({
      requestKey,
      resolution: "PRINTED",
    });
  assert.equal(
    acknowledgedRecoveredJob.acknowledgement?.resolution,
    "PRINTED"
  );

  const crashWindowRequestKey =
    "LOGEN-LABEL-80-123e4567-e89b-42d3-a456-426614174003";
  const crashWindowSpool = await createPrivatePrintSpoolFile({
    clientDataDir,
    requestKey: crashWindowRequestKey,
    contentHash,
    payload,
    platform: "linux",
  });
  const armedMarker = await armClientPrintSpoolAttempt({
    clientDataDir,
    requestKey: crashWindowRequestKey,
    contentHash,
  });
  assert.equal(armedMarker.reasonCode, "PRINT_ATTEMPT_STARTED");
  await removePrivatePrintSpoolFile(crashWindowSpool, { clientDataDir });
  await mkdir(jobsDir, { recursive: true });
  await writeFile(
    path.join(jobsDir, `${crashWindowRequestKey}.json`),
    '{"truncated":'
  );
  const crashWindowResult = await printerService.printLogenLabels({
    requestKey: crashWindowRequestKey,
    payloadHash,
    printerName: "TSC DA200",
    labels,
  });
  assert.equal(crashWindowResult.status, "UNKNOWN");
  assert.equal(
    crashWindowResult.errorCode,
    "ORPHANED_PRINT_SPOOL_RECOVERED",
    "A damaged ledger with no remaining spool was allowed to reprint."
  );
  await writeFile(
    path.join(jobsDir, `${crashWindowRequestKey}.json`),
    `${JSON.stringify({
      ...crashWindowResult,
      requestKey,
      contentHash,
    })}\n`,
    "utf8"
  );
  await assert.rejects(
    printerService.acknowledgeLocalPrintJob({
      requestKey: crashWindowRequestKey,
      resolution: "PRINTED",
    }),
    (error) => error?.code === "PRINT_LEDGER_NOT_ACKNOWLEDGEABLE",
    "A ledger whose embedded identity differs from its filename was acknowledged."
  );

  async function createResolvedArtifact(requestKeyValue, acknowledgedAt) {
    const spool = await createPrivatePrintSpoolFile({
      clientDataDir,
      requestKey: requestKeyValue,
      contentHash,
      payload,
      platform: "linux",
    });
    await armClientPrintSpoolAttempt({
      clientDataDir,
      requestKey: requestKeyValue,
      contentHash,
    });
    await removePrivatePrintSpoolFile(spool, { clientDataDir });
    await acknowledgeClientPrintSpoolRecovery({
      clientDataDir,
      requestKey: requestKeyValue,
      contentHash,
      resolution: "CONFIRMED",
      acknowledgedAt,
    });
    await writeFile(
      path.join(jobsDir, `${requestKeyValue}.json`),
      `${JSON.stringify({
        requestKey: requestKeyValue,
        contentHash,
        status: "SPOOLED",
        acknowledgement: {
          resolution: "CONFIRMED",
          acknowledgedAt,
        },
      })}\n`,
      "utf8"
    );
  }

  const oldArtifactKeys = [
    "LOGEN-LABEL-90-123e4567-e89b-42d3-a456-426614174010",
    "LOGEN-LABEL-91-123e4567-e89b-42d3-a456-426614174011",
  ];
  for (const oldArtifactKey of oldArtifactKeys) {
    await createResolvedArtifact(
      oldArtifactKey,
      "2026-05-31T23:59:59.999Z"
    );
  }
  const exactCutoffKey =
    "LOGEN-LABEL-92-123e4567-e89b-42d3-a456-426614174012";
  await createResolvedArtifact(exactCutoffKey, "2026-06-01T00:00:00.000Z");
  const dryRunLifecycle = await pruneAcknowledgedClientPrintArtifacts({
    clientDataDir,
    now: new Date("2026-07-01T00:00:00.000Z"),
    dryRun: true,
    maxBatchSize: 1,
  });
  assert.equal(dryRunLifecycle.attemptedCount, 1);
  assert.equal(dryRunLifecycle.changedCount, 0);
  const firstLifecycle = await pruneAcknowledgedClientPrintArtifacts({
    clientDataDir,
    now: new Date("2026-07-01T00:00:00.000Z"),
    maxBatchSize: 1,
  });
  assert.equal(firstLifecycle.changedCount, 1);
  assert.equal(firstLifecycle.backlogCount, 1);
  const secondLifecycle = await pruneAcknowledgedClientPrintArtifacts({
    clientDataDir,
    now: new Date("2026-07-01T00:00:00.000Z"),
    maxBatchSize: 1,
  });
  assert.equal(secondLifecycle.changedCount, 1);
  assert.equal(secondLifecycle.backlogCount, 0);
  assert.equal(
    (await lstat(path.join(jobsDir, `${exactCutoffKey}.json`))).isFile(),
    true,
    "An acknowledgement exactly at the strict cutoff was deleted."
  );
  assert.equal(
    (
      await inspectClientPrintSpoolRecovery({
        clientDataDir,
        requestKey: crashWindowRequestKey,
        contentHash,
      })
    ).status,
    "MATCH",
    "An unacknowledged UNKNOWN marker was deleted."
  );

  process.env.QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_CODE =
    "PRINT_SPOOL_TEST_FAIL_CLOSED";
  process.env.QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_MESSAGE =
    "simulated startup privacy failure";
  await assert.rejects(
    printerService.printLogenLabels({
      requestKey: "LOGEN-LABEL-79-123e4567-e89b-42d3-a456-426614174002",
      payloadHash: "e".repeat(64),
      printerName: "TSC DA200",
      labels,
    }),
    (error) =>
      error instanceof Error &&
      error.code === "PRINT_SPOOL_TEST_FAIL_CLOSED" &&
      error.uncertain === true
  );
  assert.equal(
    typeof printerService.getPrinterSettings().printerName,
    "string",
    "A print-only fail-close disabled unrelated client printer settings."
  );
  delete process.env.QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_CODE;
  delete process.env.QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_MESSAGE;

  const aclFailureRoot = path.join(root, "acl-failure");
  await assert.rejects(
    initializeClientPrintSpool({
      clientDataDir: aclFailureRoot,
      platform: "win32",
      applyWindowsAcl: async () => {
        throw new Error("simulated ACL failure");
      },
    }),
    (error) =>
      error instanceof ClientPrintSpoolError &&
      error.code === "PRINT_SPOOL_SECURITY_INITIALIZATION_FAILED"
  );
  const aclSuccessRoot = path.join(root, "acl-success");
  const expectedAclPaths = getClientPrintSpoolPaths({
    clientDataDir: aclSuccessRoot,
  });
  const appliedAclDirectories = [];
  const aclSuccess = await initializeClientPrintSpool({
    clientDataDir: aclSuccessRoot,
    platform: "win32",
    applyWindowsAcl: async (directory) => {
      appliedAclDirectories.push(directory);
    },
  });
  assert.equal(aclSuccess.ok, true);
  assert.deepEqual(appliedAclDirectories, [
    expectedAclPaths.spoolDir,
    expectedAclPaths.recoveryDir,
    expectedAclPaths.recoveryIndexDir,
    expectedAclPaths.jobsDir,
  ]);

  const launcherSource = await readFile(
    path.join(process.cwd(), "tools", "client-runtime-launcher.mjs"),
    "utf8"
  );
  const reuseReturn = launcherSource.indexOf(
    "if (normalizeServerUrl(existing.serverUrl) === serverUrl)"
  );
  const startupCleanup = launcherSource.indexOf(
    "await initializeClientPrintSpool"
  );
  const runtimeSpawn = launcherSource.indexOf(
    "return processExecution.spawnOwnedDetached(process.execPath"
  );
  assert(reuseReturn >= 0 && startupCleanup > reuseReturn);
  assert(runtimeSpawn > startupCleanup);

  const packageSource = await readFile(
    path.join(process.cwd(), "packaging", "create-staging-package.mjs"),
    "utf8"
  );
  const launcherSourceCs = await readFile(
    path.join(
      process.cwd(),
      "packaging",
      "windows-launcher",
      "QuickHackLauncher.cs"
    ),
    "utf8"
  );
  const manifest = await readFile(
    path.join(process.cwd(), "packaging", "demo-build.manifest.json"),
    "utf8"
  );
  for (const source of [packageSource, launcherSourceCs, manifest]) {
    assert.match(source, /client-print-spool-core\.mjs/);
  }
  const spoolCoreSource = await readFile(
    path.join(process.cwd(), "tools", "client-print-spool-core.mjs"),
    "utf8"
  );
  const inspectSource = spoolCoreSource.slice(
    spoolCoreSource.indexOf(
      "export async function inspectClientPrintSpoolRecovery"
    ),
    spoolCoreSource.indexOf(
      "export async function acknowledgeClientPrintSpoolRecovery"
    )
  );
  assert.doesNotMatch(
    inspectSource,
    /readdir\s*\(/,
    "Each print recovery lookup must not enumerate the shared recovery directory."
  );

  console.log("Client print spool privacy and UNKNOWN recovery verified.");
} finally {
  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData;
  }
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
  }
  await rm(root, { recursive: true, force: true });
}
