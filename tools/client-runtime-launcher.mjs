import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { resolveClientRuntimePlan } from "./client-runtime-plan.mjs";
import {
  CLIENT_RUNTIME_HOST,
  CLIENT_RUNTIME_PORT,
  clientRuntimePortForArtifact,
  normalizeServerUrl,
  resolveClientCaCertificateFile,
  resolveClientServerUrl,
} from "./client-runtime-config.mjs";
import {
  QUICKHACK_PACKAGE_MANIFEST_FILENAME,
  activatePackageRuntimeIdentity,
  assertClientServerPackagePair,
} from "../quickhack_shared/core/package-runtime-identity.mjs";
import {
  initializeClientPrintSpool,
} from "./client-print-spool-core.mjs";
import {
  composeClientPlatform,
} from "../quickhack_client/platform/compose-client-platform.ts";
import { createLinuxOperatorProcessExecution } from "./platform/linux/process-execution.mjs";
import { createWindowsOperatorProcessExecution } from "./platform/windows/process-execution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const adjacentPackageManifest = path.join(root, QUICKHACK_PACKAGE_MANIFEST_FILENAME);
const configuredPackageManifest = String(process.env.QUICKHACK_PACKAGE_MANIFEST ?? "").trim();
const packageIdentity = activatePackageRuntimeIdentity({
  manifestPath: configuredPackageManifest || (fs.existsSync(adjacentPackageManifest) ? adjacentPackageManifest : ""),
  runtimeRole: "CLIENT",
});
const clientPlatform = composeClientPlatform();
const processExecution = process.platform === "win32"
  ? createWindowsOperatorProcessExecution()
  : createLinuxOperatorProcessExecution();
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

export function probeCentralServer(serverUrl, caCertificateFile, timeoutMs = 5000, expectedIdentity = packageIdentity) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      `${serverUrl}/api/runtime`,
      {
        method: "GET",
        ca: fs.readFileSync(caCertificateFile),
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let payload = null;

          try {
            payload = JSON.parse(body);
          } catch {}

          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 500
          ) {
            reject(
              new Error(
                `QuickHack central server health check failed. HTTP ${response.statusCode || "unknown"}`
              )
            );
            return;
          }

          try {
            if (expectedIdentity) {
              assertClientServerPackagePair(expectedIdentity, payload);
            } else if (payload?.role === "client") {
              throw new Error("The configured central server is another client runtime.");
            }
          } catch (error) {
            reject(error);
            return;
          }

          resolve(payload);
        });
      }
    );

    request.on("timeout", () =>
      request.destroy(new Error("QuickHack central server connection timed out."))
    );
    request.on("error", reject);
    request.end();
  });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(runtimeStateDir, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function removeState() {
  fs.rmSync(statePath, { force: true });
}

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

function terminateOwnedProcess(pid) {
  processExecution.terminateOwnedProcess(pid);
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

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await predicate();

    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return null;
}

async function stopOwnedRuntime(existingRuntime) {
  const existing = existingRuntime || (await probeRuntime());

  if (!existing.reachable) {
    removeState();
    return false;
  }

  if (existing.role !== "client") {
    throw new Error(`Port ${port} is already used by a non-client service.`);
  }
  assertMatchingLocalClient(existing);

  const state = readState();

  if (
    !state ||
    state.instanceId !== existing.instanceId ||
    !isProcessRunning(state.pid)
  ) {
    throw new Error(
      `A client runtime is already running on port ${port}, but this launcher does not own it.`
    );
  }

  terminateOwnedProcess(state.pid);
  await waitFor(async () => !(await probeRuntime(300)).reachable, 5000, 200);
  removeState();
  return true;
}

async function startRuntime(serverUrl, caCertificateFile) {
  const existing = await probeRuntime();

  if (existing.reachable) {
    if (existing.role !== "client") {
      throw new Error(`Port ${port} is already used by a non-client service.`);
    }
    assertMatchingLocalClient(existing);

    if (normalizeServerUrl(existing.serverUrl) === serverUrl) {
      console.log(`[QuickHack Client] Local runtime is ready: ${clientUrl}`);
      return;
    }

    await stopOwnedRuntime(existing);
  }

  const runtimePlan = resolveClientRuntimePlan({
    root,
    host,
    port,
  });
  const sourceNextEnvSnapshot = captureSourceNextEnv(runtimePlan);
  await probeCentralServer(serverUrl, caCertificateFile);
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
  fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, runtimePlan.args, {
    cwd: runtimePlan.cwd,
    detached: true,
    windowsHide: true,
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
      ...(packageIdentity
        ? { QUICKHACK_PACKAGE_MANIFEST: packageIdentity.manifestPath }
        : {}),
      QUICKHACK_PRINT_SPOOL_INITIALIZED: "1",
      ...(printSpoolStartupError
        ? {
            QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_CODE:
              printSpoolStartupError.code,
            QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_MESSAGE:
              printSpoolStartupError.message,
          }
        : {}),
      NODE_EXTRA_CA_CERTS: caCertificateFile,
      ...(runtimePlan.nextDistDir
        ? { QUICKHACK_NEXT_DIST_DIR: runtimePlan.nextDistDir }
        : {}),
      },
    }),
  });

  fs.closeSync(logFd);
  child.unref();
  writeState({
    pid: child.pid,
    port,
    clientUrl,
    serverUrl,
    caCertificateFile,
    instanceId,
    entry: runtimePlan.entry,
    runtimeMode: runtimePlan.mode,
    artifactKind: packageIdentity?.artifactKind ?? "",
    startedAt: new Date().toISOString(),
  });

  const ready = await waitFor(async () => {
    if (!isProcessRunning(child.pid)) {
      return null;
    }

    const probe = await probeRuntime();
    return probe.role === "client" && probe.instanceId === instanceId
      ? probe
      : null;
  }, runtimePlan.mode === "next-source" ? 45000 : 20000);
  restoreSourceNextEnv(sourceNextEnvSnapshot);

  if (!ready) {
    removeState();
    throw new Error(`Client runtime did not start. Check ${logPath}`);
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

  if (command === "stop") {
    const stopped = await stopOwnedRuntime();
    console.log(
      stopped
        ? "[QuickHack Client] Local runtime stopped."
        : "[QuickHack Client] Local runtime was not running."
    );
    return;
  }

  if (command === "restart") {
    await stopOwnedRuntime();
  } else if (command !== "start") {
    throw new Error(`Unknown command: ${command}`);
  }

  const packageConfigDir = packageIdentity ? runtimeDirectories.configDir : "";
  const serverUrl = resolveClientServerUrl(root, port, packageConfigDir);
  const caCertificateFile = resolveClientCaCertificateFile(root, Date.now(), packageConfigDir);
  await startRuntime(serverUrl, caCertificateFile);
}

main().catch((error) => {
  const code = error && typeof error === "object" && "code" in error
    ? `${error.code}: `
    : "";
  console.error(`[QuickHack Client] ${code}${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
