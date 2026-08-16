export const PLATFORM_CAPABILITY_ERROR_CODES = Object.freeze([
  "UNSUPPORTED_PLATFORM",
  "CAPABILITY_UNAVAILABLE",
  "DEPENDENCY_MISSING",
  "DEPENDENCY_INVALID",
  "DEPENDENCY_VERSION_MISMATCH",
]);

const errorCodes = new Set(PLATFORM_CAPABILITY_ERROR_CODES);
const safeDetailKeys = new Set([
  "role",
  "capability",
  "platform",
  "dependency",
  "tool",
  "requiredRange",
  "requiredMajor",
  "detectedVersion",
  "detectedMajor",
  "ownerStage",
  "recovery",
]);

function safeDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }

  const result = {};
  for (const key of safeDetailKeys) {
    if (!Object.hasOwn(details, key)) continue;
    const value = details[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? Object.freeze(result) : undefined;
}

export class PlatformCapabilityError extends Error {
  constructor(code, message, details = undefined) {
    if (!errorCodes.has(code)) {
      throw new TypeError(`Unknown platform capability error code: ${code}`);
    }
    super(String(message || code));
    this.name = "PlatformCapabilityError";
    this.code = code;
    this.details = safeDetails(details);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

function createError(code, input = {}) {
  const message = String(input.message || code);
  const { message: _message, ...details } = input;
  return new PlatformCapabilityError(code, message, details);
}

export function unsupportedPlatform(input = {}) {
  return createError("UNSUPPORTED_PLATFORM", input);
}

export function capabilityUnavailable(input = {}) {
  return createError("CAPABILITY_UNAVAILABLE", input);
}

export function dependencyMissing(input = {}) {
  return createError("DEPENDENCY_MISSING", input);
}

export function dependencyInvalid(input = {}) {
  return createError("DEPENDENCY_INVALID", input);
}

export function dependencyVersionMismatch(input = {}) {
  return createError("DEPENDENCY_VERSION_MISMATCH", input);
}
