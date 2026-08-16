export const PROCESS_ENVIRONMENT_POLICY_VERSION = 1;

export function assertProcessEnvironmentPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("A child process environment policy is required.");
  }
  if (policy.version !== PROCESS_ENVIRONMENT_POLICY_VERSION) {
    throw new TypeError("The child process environment policy version is unsupported.");
  }
  if (!Array.isArray(policy.inheritedNames) || !Array.isArray(policy.basePathEntries)) {
    throw new TypeError("The child process environment policy is incomplete.");
  }
  if (policy.pathName !== "PATH" && policy.pathName !== "Path") {
    throw new TypeError("The child process PATH field is invalid.");
  }
  if (policy.pathDelimiter !== ":" && policy.pathDelimiter !== ";") {
    throw new TypeError("The child process PATH delimiter is invalid.");
  }
  if (!policy.requiredValues || typeof policy.requiredValues !== "object") {
    throw new TypeError("The child process required environment values are invalid.");
  }
  return policy;
}

export function createCommandPlan({ executable, arguments: commandArguments = [] }) {
  const normalizedExecutable = String(executable ?? "").trim();
  if (
    !normalizedExecutable ||
    !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(normalizedExecutable)
  ) {
    throw new TypeError("An absolute process executable is required.");
  }
  if (!Array.isArray(commandArguments)) {
    throw new TypeError("Process arguments must be an array.");
  }
  return Object.freeze({
    executable: normalizedExecutable,
    arguments: Object.freeze(commandArguments.map((value) => String(value))),
  });
}
