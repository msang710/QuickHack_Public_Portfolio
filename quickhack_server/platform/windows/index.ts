import type { ServerPlatformCapabilities } from "../contracts.ts";
import { windowsServerProcessExecution } from "./process-execution.ts";
import { windowsServerRuntimeDirectories } from "./runtime-directories.ts";
import {
  WINDOWS_SERVER_SECRET_SCOPE_ENV,
  createWindowsServerSecretProtector,
  resolveWindowsServerSecretScope,
} from "./server-secret-protector.mjs";
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
    scope: resolveWindowsServerSecretScope(
      process.env[WINDOWS_SERVER_SECRET_SCOPE_ENV]
    ),
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
