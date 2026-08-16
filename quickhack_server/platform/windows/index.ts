import type { ServerPlatformCapabilities } from "../contracts.ts";
import { windowsServerProcessExecution } from "./process-execution.ts";
import { windowsServerRuntimeDirectories } from "./runtime-directories.ts";
import { createWindowsServerSecretProtector } from "./server-secret-protector.mjs";
import { createWindowsQhkeyMasterKeyProvider } from "./qhkey-master-key-provider.mjs";
import { createWindowsRemovableVolumeProvider } from "./removable-volume-provider.mjs";
import { createWindowsPostgresqlServiceController } from "./postgresql-service-controller.mjs";

export function createWindowsServerPlatform(
  platform = "win32"
): ServerPlatformCapabilities {
  const runtimeDirectories = windowsServerRuntimeDirectories;
  const processExecution = windowsServerProcessExecution;

  const secretProtector = createWindowsServerSecretProtector({
    platform,
  }).protector;
  const qhkeyMasterKey = createWindowsQhkeyMasterKeyProvider({ platform });
  const removableVolume = createWindowsRemovableVolumeProvider({ platform });

  const postgresqlService = createWindowsPostgresqlServiceController({ platform });

  return Object.freeze({
    runtimeDirectories,
    processExecution,
    secretProtector,
    qhkeyMasterKey,
    removableVolume,
    postgresqlService,
  });
}
