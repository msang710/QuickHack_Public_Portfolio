import { fileURLToPath } from "node:url";
import { OPERATOR_PACKAGE_TARGETS, assertOperatorPlatform } from "../contracts.mjs";
import { createLinuxOperatorProcessExecution } from "./process-execution.mjs";
import { createLinuxRemovableVolumeProvider } from "../../../quickhack_server/platform/linux/removable-volume-provider.mjs";
import { createLinuxServerConsoleRuntime } from "./server-console-runtime.mjs";
import { createSystemdOneShotProcess } from "./systemd-one-shot-process.mjs";
import { createSystemdServiceProcess } from "./systemd-service-process.mjs";
import { readPackageRuntimeIdentitySync } from "../../../quickhack_shared/core/package-runtime-identity.mjs";
import { linuxArtifactConfig } from "../../../packaging/linux/linux-artifact-config.mjs";
import { createLinuxPackageLifecycle } from "./package-lifecycle.mjs";

function descriptor(id, platform, ownerStage) {
  return Object.freeze({
    id,
    role: "operator",
    platform,
    state: "READY",
    ownerStage,
  });
}

export function createLinuxOperatorPlatform(platform = "linux") {
  const processExecution = createLinuxOperatorProcessExecution(platform);
  const launcher = Object.freeze({
    descriptor: descriptor("launcher", platform, "PR-09"),
    async resolveClientRuntimePlan(input) {
      const launcherModule = await import("../../client-runtime-plan.mjs");
      return launcherModule.resolveClientRuntimePlan(input);
    },
  });

  const lifecycle = createLinuxPackageLifecycle();
  const packageLifecycle = Object.freeze({
    descriptor: descriptor("package-lifecycle", platform, "PR-10"),
    artifact(target) {
      return linuxArtifactConfig(target);
    },
    stageCommand(target) {
      if (!OPERATOR_PACKAGE_TARGETS.includes(target)) throw new TypeError(`Unsupported package target: ${target}.`);
      return Object.freeze({
        executable: process.execPath,
        arguments: Object.freeze([
          fileURLToPath(new URL("../../../packaging/linux/create-staging-package.mjs", import.meta.url)),
          `--target=${target}`,
        ]),
      });
    },
    setup: lifecycle.setup,
    repair: lifecycle.repair,
    uninstall: lifecycle.uninstall,
    purge: lifecycle.purge,
  });

  const removableVolume = createLinuxRemovableVolumeProvider({
    platform,
    role: "operator",
  });
  const serverConsoleRuntime = createLinuxServerConsoleRuntime();
  const oneShotProcess = Object.freeze({
    descriptor: descriptor("one-shot-process", platform, "PR-09"),
    create() {
      return createSystemdOneShotProcess();
    },
  });
  const packageIdentity = readPackageRuntimeIdentitySync();
  const serviceConfig = packageIdentity?.runtimeRole === "SERVER"
    ? linuxArtifactConfig(packageIdentity.packageTarget).services
    : null;
  const nativeServiceLifecycle = createSystemdServiceProcess({
    ...(serviceConfig ? { units: { POSTGRESQL: serviceConfig.postgresql, APPLICATION: serviceConfig.console } } : {}),
  });
  const serviceLifecycle = Object.freeze({
    descriptor: descriptor("service-lifecycle", platform, "PR-09"),
    status: nativeServiceLifecycle.status,
    operate: nativeServiceLifecycle.operate,
  });

  return assertOperatorPlatform(
    Object.freeze({
      role: "operator",
      platform,
      processExecution,
      launcher,
      packageLifecycle,
      removableVolume,
      serverConsoleRuntime,
      oneShotProcess,
      serviceLifecycle,
    })
  );
}
