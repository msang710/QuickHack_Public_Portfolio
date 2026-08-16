import type {
  ClientPlatformCapabilities,
} from "../contracts.ts";
import { windowsAdbExecutableResolver } from "./adb-executable-resolver.ts";
import { windowsPrinterBackend } from "./printer-backend.ts";
import { windowsClientRuntimeDirectories } from "./runtime-directories.ts";

export function createWindowsClientPlatform(
  platform = "win32"
): ClientPlatformCapabilities {
  if (platform !== "win32") {
    throw new TypeError(`Windows client adapter received platform: ${platform}.`);
  }

  return Object.freeze({
    runtimeDirectories: windowsClientRuntimeDirectories,
    adbExecutableResolver: windowsAdbExecutableResolver,
    printerBackend: windowsPrinterBackend,
  });
}
