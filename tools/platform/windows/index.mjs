import { fileURLToPath } from "node:url";
import {
  OPERATOR_PACKAGE_TARGETS,
  assertOperatorPlatform,
} from "../contracts.mjs";
import { createWindowsOperatorProcessExecution } from "./process-execution.mjs";
import { createWindowsRemovableVolumeProvider } from "../../../quickhack_server/platform/windows/removable-volume-provider.mjs";
import { createWindowsServerConsoleRuntime } from "./server-console-runtime.mjs";
import { createWindowsServiceProcess } from "./windows-service-process.mjs";
import { windowsArtifactConfig } from "../../../packaging/windows/windows-artifact-config.mjs";

function descriptor(id, platform, ownerStage) {
  return Object.freeze({
    id,
    role: "operator",
    platform,
    state: "COMPATIBILITY",
    ownerStage,
  });
}

export function createWindowsOperatorPlatform(platform = "win32") {
  const processExecution = createWindowsOperatorProcessExecution(platform);
  const launcher = Object.freeze({
    descriptor: descriptor("launcher", platform, "PR-09"),
    async resolveClientRuntimePlan(input) {
      const launcherModule = await import("../../client-runtime-plan.mjs");
      return launcherModule.resolveClientRuntimePlan(input);
    },
  });

  const packageLifecycle = Object.freeze({
    descriptor: Object.freeze({
      ...descriptor("package-lifecycle", platform, "PR-10"),
      state: "READY",
    }),
    artifact(target) {
      return windowsArtifactConfig(target);
    },
    stageCommand(target) {
      if (!OPERATOR_PACKAGE_TARGETS.includes(target)) {
        throw new TypeError(`Unsupported package target: ${target}.`);
      }
      return Object.freeze({
        executable: process.execPath,
        arguments: Object.freeze([
          fileURLToPath(
            new URL(
              "../../../packaging/windows/create-staging-package.mjs",
              import.meta.url
            )
          ),
          `--target=${target}`,
        ]),
      });
    },
  });

  const removableVolume = createWindowsRemovableVolumeProvider({
    platform,
    role: "operator",
  });
  const serverConsoleRuntime = createWindowsServerConsoleRuntime();
  const oneShotProcess = Object.freeze({
    descriptor: descriptor("one-shot-process", platform, "PR-09"),
    create(input) {
      if (!input?.directOneShot || typeof input.directOneShot.execute !== "function") {
        throw new TypeError("The direct Windows one-shot process is required.");
      }
      return input.directOneShot;
    },
  });
  const nativeServiceLifecycle = createWindowsServiceProcess();
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
