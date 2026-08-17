import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { resolveClientRuntimePlan } from "./client-runtime-plan.mjs";
import {
  CLIENT_RUNTIME_HOST,
  CLIENT_RUNTIME_PORT,
  clientRuntimePortForArtifact,
  normalizeServerUrl,
  resolveClientTrustBundle,
} from "./client-runtime-config.mjs";
import { probeCentralServer } from "./client-runtime-probe.mjs";
import {
  QUICKHACK_PACKAGE_MANIFEST_FILENAME,
  activatePackageRuntimeIdentity,
} from "../quickhack_shared/core/package-runtime-identity.mjs";
import {
  initializeClientPrintSpool,
} from "./client-print-spool-core.mjs";
import {
  composeClientPlatform,
} from "../quickhack_client/platform/compose-client-platform.ts";
import { composeProcessExecution } from "./platform/compose-process-execution.mjs";
import { CLIENT_RUNTIME_BOOTSTRAP_FILENAME } from "./client-runtime-bootstrap.mjs";
import {
  assertObservedClientRuntimeOwnership,
  createClientRuntimeOwnerStateStore,
  launchClientRuntimeWithOwnerState,
  waitForClientRuntime,
} from "./client-runtime-owner-state.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const adjacentPackageManifest = path.join(root, QUICKHACK_PACKAGE_MANIFEST_FILENAME);
const configuredPackageManifest = String(process.env.QUICKHACK_PACKAGE_MANIFEST ?? "").trim();
const packageIdentity = activatePackageRuntimeIdentity({
  manifestPath: configuredPackageManifest || (fs.existsSync(adjacentPackageManifest) ? adjacentPackageManifest : ""),
  runtimeRole: "CLIENT",
});
const clientPlatform = composeClientPlatform();
const processExecution = composeProcessExecution();
const runtimeDirectories = clientPlatform.runtimeDirectories.resolve({
  appRoot: root,
  environment: process.env,
  deployment: packageIdentity ? "system-service" : "development",
  ...(packageIdentity ? { artifactKind: packageIdentity.artifactKind } : {}),
});
const host = CLIENT_RUNTIME_HOST;
const port = packageIdentity
  ? clientRuntimePortForArtifact(packageIdentity.artifactKind)
  : CLIENT_RUNTIME_PORT;
const clientUrl = `http://${host}:${port}`;
const runtimeStateDir = runtimeDirectories.stateDir;
const logDir = runtimeDirectories.logDir;
const logPath = path.join(logDir, "client-runtime.log");
const statePath = path.join(runtimeStateDir, `client-${port}.json`);
const ownerState = createClientRuntimeOwnerStateStore({ statePath });

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateOwnedDetachedProcess(pid, options) {
  processExecution.terminateOwnedDetachedProcess(pid, options);
}

function captureSourceNextEnv(runtimePlan) {
  if (runtimePlan.mode !== "next-source") return null;

  const filename = path.join(root, "next-env.d.ts");
  return fs.existsSync(filename)
    ? { filename, content: fs.readFileSync(filename, "utf8") }
    : null;
}

function restoreSourceNextEnv(snapshot) {
  if (!snapshot || !fs.existsSync(snapshot.filename)) return;

  const current = fs.readFileSync(snapshot.filename, "utf8");
  if (current !== snapshot.content) {
    fs.writeFileSync(snapshot.filename, snapshot.content, "utf8");
  }
}

async function probeRuntime(timeoutMs = 1200) {
  try {
    const response = await fetch(`${clientUrl}/api/runtime`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => null);

    return {
      reachable: true,
      role: typeof payload?.role === "string" ? payload.role : "",
      serverUrl: typeof payload?.serverUrl === "string" ? payload.serverUrl : "",
      instanceId:
        typeof payload?.instanceId === "string" ? payload.instanceId : "",
      runtimeContractVersion:
        Number.isInteger(payload?.runtimeContractVersion)
          ? payload.runtimeContractVersion
          : 0,
      deploymentFlavor:
        typeof payload?.deploymentFlavor === "string"
          ? payload.deploymentFlavor
          : "",
      artifactKind:
        typeof payload?.artifactKind === "string" ? payload.artifactKind : "",
    };
  } catch {
    return {
      reachable: false,
      role: "",
      serverUrl: "",
      instanceId: "",
      runtimeContractVersion: 0,
      deploymentFlavor: "",
      artifactKind: "",
    };
  }
}

function assertMatchingLocalClient(existing) {
  if (!packageIdentity) return;
  if (
    existing.runtimeContractVersion !== packageIdentity.runtimeContractVersion ||
    existing.deploymentFlavor !== packageIdentity.deploymentFlavor ||
    existing.artifactKind !== packageIdentity.artifactKind
  ) {
    const error = new Error(`Port ${port} is owned by a different QuickHack client artifact.`);
    error.code = "PACKAGE_FLAVOR_MISMATCH";
    throw error;
  }
}

async function stopOwnedRuntime(existingRuntime) {
  const existing = existingRuntime || (await probeRuntime());
  const stateResult = ownerState.read();

  if (!existing.reachable) {
    if (
      stateResult.status === "VALID" &&
      stateResult.state.state === "CLAIMED" &&
      isProcessRunning(stateResult.state.pid)
    ) {
      const error = new Error("The client runtime process is alive, but its endpoint identity cannot be verified.");
      error.code = "CLIENT_RUNTIME_OWNERSHIP_UNVERIFIED";
      throw error;
    }
    if (stateResult.status !== "MISSING") ownerState.recoverInactive();
    return false;
  }

  if (existing.role !== "client") {
    throw new Error(`Port ${port} is already used by a non-client service.`);
  }
  assertMatchingLocalClient(existing);

  const state = requireObservedRuntimeOwnership(existing, stateResult);

  terminateOwnedDetachedProcess(state.pid);
  let stopped = await waitForClientRuntime(async () => {
    const current = await probeRuntime(300);
    return !isProcessRunning(state.pid) && (!current.reachable || current.instanceId !== state.instanceId);
  }, 5000, 200);
  if (!stopped && isProcessRunning(state.pid)) {
    terminateOwnedDetachedProcess(state.pid, { force: true });
    stopped = await waitForClientRuntime(async () => {
      const current = await probeRuntime(300);
      return !isProcessRunning(state.pid) && (!current.reachable || current.instanceId !== state.instanceId);
    }, 5000, 200);
  }
  if (!stopped) {
    const error = new Error("The owned client runtime endpoint did not stop.");
    error.code = "CLIENT_RUNTIME_STOP_TIMEOUT";
    throw error;
  }
  ownerState.removeOwned({ ownerToken: state.ownerToken, instanceId: state.instanceId, pid: state.pid });
  return true;
}

function requireObservedRuntimeOwnership(existing, stateResult = ownerState.read()) {
  const current = stateResult.status === "LEGACY"
    ? { status: "VALID", state: ownerState.adoptLegacy(existing) }
    : stateResult;
  return assertObservedClientRuntimeOwnership(existing, current, isProcessRunning);
}

async function startRuntime(serverUrl, caCertificateFile) {
  const existing = await probeRuntime();

  if (existing.reachable) {
    if (existing.role !== "client") {
      throw new Error(`Port ${port} is already used by a non-client service.`);
    }
    assertMatchingLocalClient(existing);

    if (normalizeServerUrl(existing.serverUrl) === serverUrl) {
      requireObservedRuntimeOwnership(existing);
      console.log(`[QuickHack Client] Local runtime is ready: ${clientUrl}`);
      return;
    }

    await stopOwnedRuntime(existing);
  } else {
    const stateResult = ownerState.read();
    if (
      stateResult.status === "VALID" &&
      stateResult.state.state === "CLAIMED" &&
      isProcessRunning(stateResult.state.pid)
    ) {
      const error = new Error("A claimed client runtime is still starting or is not yet reachable.");
      error.code = "CLIENT_RUNTIME_START_IN_PROGRESS";
      throw error;
    }
    if (stateResult.status !== "MISSING") ownerState.recoverInactive();
  }

  const runtimePlan = resolveClientRuntimePlan({
    root,
    host,
    port,
  });
  const sourceNextEnvSnapshot = captureSourceNextEnv(runtimePlan);
  await probeCentralServer(serverUrl, caCertificateFile, 5000, packageIdentity);
  let printSpoolStartupError = null;
  try {
    const printSpool = await initializeClientPrintSpool({
      clientDataDir: runtimeStateDir,
      platform: clientPlatform.platform,
      applyWindowsAcl: (directory) =>
        clientPlatform.printerBackend.secureSpoolDirectory({
          appRoot: root,
          runtimeDir: runtimeDirectories.runtimeDir,
          environment: process.env,
          directory,
        }),
    });
    if (printSpool.recoveredCount > 0 || printSpool.skippedCount > 0) {
      console.warn(
        `[QuickHack Client] Print spool startup cleanup: recovered=${printSpool.recoveredCount}, skipped=${printSpool.skippedCount}`
      );
    }
  } catch (error) {
    printSpoolStartupError = {
      code:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "PRINT_SPOOL_SECURITY_INITIALIZATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
    console.warn(
      `[QuickHack Client] Label printing is disabled: ${printSpoolStartupError.code}: ${printSpoolStartupError.message}`
    );
  }
  const instanceId = crypto.randomBytes(24).toString("hex");
  const ownerToken = crypto.randomBytes(24).toString("hex");
  const preparedState = {
    ownerToken,
    port,
    clientUrl,
    serverUrl,
    caCertificateFile,
    instanceId,
    entry: runtimePlan.entry,
    runtimeMode: runtimePlan.mode,
    artifactKind: packageIdentity?.artifactKind ?? "",
    startedAt: new Date().toISOString(),
  };
  try {
    await launchClientRuntimeWithOwnerState({
      stateStore: ownerState,
      preparedState,
      spawnBootstrap(prepared) {
        fs.mkdirSync(logDir, { recursive: true });
        const logFd = fs.openSync(logPath, "a");
        try {
          return processExecution.spawnOwnedDetached(process.execPath, [
            CLIENT_RUNTIME_BOOTSTRAP_FILENAME,
            "--state-path",
            statePath,
            "--owner-token",
            prepared.ownerToken,
            "--instance-id",
            prepared.instanceId,
            "--cwd",
            runtimePlan.cwd,
            "--",
            ...runtimePlan.args,
          ], {
            cwd: root,
            stdio: ["ignore", logFd, logFd],
            env: processExecution.childEnvironment({
              executableDirectories: [path.dirname(process.execPath)],
              overrides: {
                PORT: String(port),
                HOST: host,
                HOSTNAME: host,
                NODE_ENV: runtimePlan.nodeEnv,
                QUICKHACK_RUNTIME_ROLE: "client",
                QUICKHACK_SERVER_URL: serverUrl,
                QUICKHACK_APP_ROOT: root,
                QUICKHACK_RUNTIME_DIR: runtimeDirectories.runtimeDir,
                QUICKHACK_CLIENT_INSTANCE_ID: instanceId,
                QUICKHACK_CLIENT_TRUST_BUNDLE_DIR: path.dirname(caCertificateFile),
                ...(packageIdentity
                  ? { QUICKHACK_PACKAGE_MANIFEST: packageIdentity.manifestPath }
                  : {}),
                QUICKHACK_PRINT_SPOOL_INITIALIZED: "1",
                ...(printSpoolStartupError
                  ? {
                      QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_CODE: printSpoolStartupError.code,
                      QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_MESSAGE: printSpoolStartupError.message,
                    }
                  : {}),
                NODE_EXTRA_CA_CERTS: caCertificateFile,
                ...(runtimePlan.nextDistDir
                  ? { QUICKHACK_NEXT_DIST_DIR: runtimePlan.nextDistDir }
                  : {}),
              },
            }),
          });
        } finally {
          fs.closeSync(logFd);
        }
      },
      terminateOwnedDetachedProcess,
      isProcessRunning,
      probeRuntime,
      waitFor: waitForClientRuntime,
      timeoutMs: runtimePlan.mode === "next-source" ? 45000 : 20000,
    });
  } catch (error) {
    if (error?.code === "CLIENT_RUNTIME_READINESS_TIMEOUT") {
      error.message = `Client runtime did not start. Check ${logPath}`;
    }
    throw error;
  } finally {
    restoreSourceNextEnv(sourceNextEnvSnapshot);
  }

  console.log(`[QuickHack Client] Local runtime is ready: ${clientUrl}`);
  console.log(`[QuickHack Client] Central server: ${serverUrl}`);
  console.log(`[QuickHack Client] Runtime: ${runtimePlan.label}`);
}

async function main() {
  const command = process.argv[2] || "start";

  if (command === "status") {
    const current = await probeRuntime();

    if (current.role !== "client") {
      throw new Error(`QuickHack client runtime is not running on ${clientUrl}.`);
    }

    console.log(`[QuickHack Client] Local runtime: ${clientUrl}`);
    console.log(`[QuickHack Client] Central server: ${current.serverUrl || "not configured"}`);
    return;
  }

  if (!["start", "stop", "restart"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const commandLock = ownerState.acquireCommandLock();
  try {
    if (command === "stop") {
      const stopped = await stopOwnedRuntime();
      console.log(
        stopped
          ? "[QuickHack Client] Local runtime stopped."
          : "[QuickHack Client] Local runtime was not running."
      );
      return;
    }
    if (command === "restart") await stopOwnedRuntime();
    const packageConfigDir = packageIdentity ? runtimeDirectories.configDir : "";
    const trustBundle = resolveClientTrustBundle(root, Date.now(), packageConfigDir);
    const serverUrl = trustBundle.origin;
    const caCertificateFile = trustBundle.paths.combinedCa;
    await startRuntime(serverUrl, caCertificateFile);
  } finally {
    commandLock.release();
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error && typeof error === "object" && "code" in error
      ? `${error.code}: `
      : "";
    console.error(`[QuickHack Client] ${code}${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
