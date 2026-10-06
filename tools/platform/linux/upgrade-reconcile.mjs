import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLinuxPackageLifecycle } from "./package-lifecycle.mjs";
import { linuxArtifactConfig } from "../../../packaging/linux/linux-artifact-config.mjs";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";

const ARTIFACTS = Object.freeze({
  DEMONSTRATION_SERVER: "demo-server",
  OPERATIONAL_SERVER: "operational-server",
});

function stopConsole(unit) {
  return new Promise((resolve, reject) => {
    const env = createChildProcessEnvironment({ policy: createLinuxChildProcessPolicy(), source: process.env });
    execFile("/usr/bin/systemctl", ["stop", unit], { timeout: 30_000, env }, (error) => error ? reject(error) : resolve());
  });
}

export async function reconcileLinuxUpgrade(artifactKind, options = {}) {
  const target = ARTIFACTS[artifactKind];
  if (!target) throw new TypeError("A server artifact is required for upgrade reconciliation.");
  const markerPath = options.markerPath ?? `/var/lib/quickhack/upgrade-state/${linuxArtifactConfig(target).flavorSlug}-upgrade.pending`;
  const lifecycle = options.lifecycle ?? createLinuxPackageLifecycle();
  const stop = options.stopConsole ?? stopConsole;
  const unit = linuxArtifactConfig(target).services.console;
  const marker = await fs.lstat(markerPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!marker) return { state: "SKIPPED" };
  if (!marker.isFile() || marker.isSymbolicLink()) {
    const error = new Error("The upgrade marker is invalid.");
    error.code = "UPGRADE_MARKER_INVALID";
    throw error;
  }
  try {
    const result = await lifecycle.repair({ artifactKind, upgradeReconcile: true });
    await fs.rm(markerPath, { force: true });
    return result;
  } catch (repairError) {
    await stop(unit).catch(() => undefined);
    throw repairError;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const artifactKind = process.argv[2];
    const result = await reconcileLinuxUpgrade(artifactKind);
    process.stdout.write(`UPGRADE_RECONCILED=${result.state}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code || "UPGRADE_RECONCILE_FAILED"}: Upgrade reconciliation failed. Inspect the QuickHack console journal.\n`);
    process.exitCode = 1;
  }
}
