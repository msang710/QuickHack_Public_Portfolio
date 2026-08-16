import type {
  ServerPlatformCapabilities,
} from "../contracts.ts";
import { linuxServerProcessExecution } from "./process-execution.ts";
import { linuxServerRuntimeDirectories } from "./runtime-directories.ts";
import { createLinuxServerSecretProtector } from "./server-secret-protector.mjs";
import { createLinuxQhkeyMasterKeyProvider } from "./qhkey-master-key-provider.mjs";
import { createLinuxRemovableVolumeProvider } from "./removable-volume-provider.mjs";
import { createLinuxPostgresqlServiceController } from "./postgresql-service-controller.mjs";
import { readPackageRuntimeIdentitySync } from "../../../quickhack_shared/core/package-runtime-identity.mjs";

export function createLinuxServerPlatform(
  platform = "linux"
): ServerPlatformCapabilities {
  const runtimeDirectories = linuxServerRuntimeDirectories;
  const processExecution = linuxServerProcessExecution;

  const secretProtector = createLinuxServerSecretProtector({ platform });
  const qhkeyMasterKey = createLinuxQhkeyMasterKeyProvider({ platform });
  const removableVolume = createLinuxRemovableVolumeProvider({ platform });

  const packageIdentity = readPackageRuntimeIdentitySync();
  const serviceUnits = packageIdentity?.artifactKind === "DEMONSTRATION_SERVER"
    ? {
        POSTGRESQL: "quickhack-demonstration-postgresql.service",
        APPLICATION: "quickhack-demonstration-console.service",
      }
    : packageIdentity?.artifactKind === "OPERATIONAL_SERVER"
      ? {
          POSTGRESQL: "quickhack-operational-postgresql.service",
          APPLICATION: "quickhack-operational-console.service",
        }
      : undefined;
  const postgresqlService = createLinuxPostgresqlServiceController({
    platform,
    ...(serviceUnits ? { units: serviceUnits } : {}),
  });

  return Object.freeze({
    runtimeDirectories,
    processExecution,
    secretProtector,
    qhkeyMasterKey,
    removableVolume,
    postgresqlService,
  });
}
