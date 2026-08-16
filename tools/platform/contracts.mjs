export const OPERATOR_PLATFORM_CAPABILITIES = Object.freeze([
  "process-execution",
  "launcher",
  "package-lifecycle",
  "removable-volume-provider",
  "server-console-runtime",
  "one-shot-process",
  "service-lifecycle",
]);

export const OPERATOR_PACKAGE_TARGETS = Object.freeze([
  "demo-server",
  "demo-client",
  "operational-server",
  "operational-client",
]);

export function assertOperatorPlatform(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("Operator platform is required.");
  }
  if (value.role !== "operator" || typeof value.platform !== "string") {
    throw new TypeError("Operator platform identity is invalid.");
  }
  for (const key of [
    "processExecution",
    "launcher",
    "packageLifecycle",
    "removableVolume",
    "serverConsoleRuntime",
    "oneShotProcess",
    "serviceLifecycle",
  ]) {
    const capability = value[key];
    if (
      !capability ||
      typeof capability !== "object" ||
      !capability.descriptor ||
      capability.descriptor.role !== "operator" ||
      capability.descriptor.platform !== value.platform
    ) {
      throw new TypeError(`Operator platform capability is invalid: ${key}.`);
    }
  }
  return value;
}
