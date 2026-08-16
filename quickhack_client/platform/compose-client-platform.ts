import { unsupportedPlatform } from "../../quickhack_shared/platform/platform-capability-error.mjs";
import type {
  ClientPlatform,
  ClientPlatformCapabilities,
} from "./contracts.ts";
import { createLinuxClientPlatform } from "./linux/index.ts";
import { createWindowsClientPlatform } from "./windows/index.ts";

export type ClientPlatformFactory = (
  platform: string
) => ClientPlatformCapabilities;

export type ComposeClientPlatformOptions = Readonly<{
  platform?: string;
  adapters?: Readonly<Record<string, ClientPlatformFactory>>;
}>;

const defaultAdapters: Readonly<Record<string, ClientPlatformFactory>> =
  Object.freeze({
    win32: createWindowsClientPlatform,
    linux: createLinuxClientPlatform,
  });

export function composeClientPlatform(
  options: ComposeClientPlatformOptions = {}
): ClientPlatform {
  const platform = options.platform ?? process.platform;
  const factory = options.adapters?.[platform] ?? defaultAdapters[platform];

  if (!factory) {
    throw unsupportedPlatform({
      role: "client",
      platform,
      recovery: "Run QuickHack on a supported Windows or Linux host.",
      message: `QuickHack client does not support platform: ${platform}.`,
    });
  }

  return Object.freeze({
    role: "client",
    platform,
    ...factory(platform),
  });
}
