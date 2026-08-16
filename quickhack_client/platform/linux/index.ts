import type {
  ClientPlatformCapabilities,
} from "../contracts.ts";
import { linuxAdbExecutableResolver } from "./adb-executable-resolver.ts";
import { linuxPrinterBackend } from "./printer-backend.ts";
import { linuxClientRuntimeDirectories } from "./runtime-directories.ts";

export function createLinuxClientPlatform(
  platform = "linux"
): ClientPlatformCapabilities {
  if (platform !== "linux") {
    throw new TypeError(`Linux client adapter received platform: ${platform}.`);
  }

  return Object.freeze({
    runtimeDirectories: linuxClientRuntimeDirectories,
    adbExecutableResolver: linuxAdbExecutableResolver,
    printerBackend: linuxPrinterBackend,
  });
}
