import { unsupportedPlatform } from "../../quickhack_shared/platform/platform-capability-error.mjs";
import type {
  ServerPlatform,
  ServerPlatformCapabilities,
} from "./contracts.ts";
import { createLinuxServerPlatform } from "./linux/index.ts";
import { createWindowsServerPlatform } from "./windows/index.ts";

export type ServerPlatformFactory = (
  platform: string
) => ServerPlatformCapabilities;

export type ComposeServerPlatformOptions = Readonly<{
  platform?: string;
  adapters?: Readonly<Record<string, ServerPlatformFactory>>;
}>;

const defaultAdapters: Readonly<Record<string, ServerPlatformFactory>> =
  Object.freeze({
    win32: createWindowsServerPlatform,
    linux: createLinuxServerPlatform,
  });

export function composeServerPlatform(
  options: ComposeServerPlatformOptions = {}
): ServerPlatform {
  const platform = options.platform ?? process.platform;
  const factory = options.adapters?.[platform] ?? defaultAdapters[platform];

  if (!factory) {
    throw unsupportedPlatform({
      role: "server",
      platform,
      recovery: "Run QuickHack on a supported Windows or Linux host.",
      message: `QuickHack server does not support platform: ${platform}.`,
    });
  }

  return Object.freeze({
    role: "server",
    platform,
    ...factory(platform),
  });
}
