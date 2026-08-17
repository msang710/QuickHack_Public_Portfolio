import { unsupportedPlatform } from "../../quickhack_shared/platform/platform-capability-error.mjs";
import { createLinuxOperatorProcessExecution } from "./linux/process-execution.mjs";
import { createWindowsOperatorProcessExecution } from "./windows/process-execution.mjs";

const defaultAdapters = Object.freeze({
  win32: createWindowsOperatorProcessExecution,
  linux: createLinuxOperatorProcessExecution,
});

export function composeProcessExecution(options = {}) {
  const platform = options.platform ?? process.platform;
  const factory = options.adapters?.[platform] ?? defaultAdapters[platform];

  if (!factory) {
    throw unsupportedPlatform({
      role: "operator",
      platform,
      recovery: "Run QuickHack tools on a supported Windows or Linux host.",
      message: `QuickHack process execution does not support platform: ${platform}.`,
    });
  }

  return factory(platform, options.factoryOptions);
}
