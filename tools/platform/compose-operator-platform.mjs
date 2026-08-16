import { unsupportedPlatform } from "../../quickhack_shared/platform/platform-capability-error.mjs";
import { assertOperatorPlatform } from "./contracts.mjs";
import { createLinuxOperatorPlatform } from "./linux/index.mjs";
import { createWindowsOperatorPlatform } from "./windows/index.mjs";

const defaultAdapters = Object.freeze({
  win32: createWindowsOperatorPlatform,
  linux: createLinuxOperatorPlatform,
});

export function composeOperatorPlatform(options = {}) {
  const platform = options.platform ?? process.platform;
  const factory = options.adapters?.[platform] ?? defaultAdapters[platform];

  if (!factory) {
    throw unsupportedPlatform({
      role: "operator",
      platform,
      recovery: "Run QuickHack tools on a supported Windows or Linux host.",
      message: `QuickHack operator tools do not support platform: ${platform}.`,
    });
  }

  return assertOperatorPlatform(
    Object.freeze({
      ...factory(platform),
      role: "operator",
      platform,
    })
  );
}
