import assert from "node:assert/strict";
import {
  PLATFORM_CAPABILITY_ERROR_CODES,
  PlatformCapabilityError,
  capabilityUnavailable,
  dependencyInvalid,
  dependencyMissing,
  dependencyVersionMismatch,
  unsupportedPlatform,
} from "../../quickhack_shared/platform/platform-capability-error.mjs";
import {
  NativeRuntimeContractError,
  assertNativeRuntimeCapabilities,
} from "../../quickhack_shared/platform/native-runtime-contract.mjs";

assert.deepEqual(PLATFORM_CAPABILITY_ERROR_CODES, [
  "UNSUPPORTED_PLATFORM",
  "CAPABILITY_UNAVAILABLE",
  "DEPENDENCY_MISSING",
  "DEPENDENCY_INVALID",
  "DEPENDENCY_VERSION_MISMATCH",
]);

const unavailable = capabilityUnavailable({
  role: "server",
  capability: "server-secret-protector",
  platform: "linux",
  ownerStage: "PR-06",
  recovery: "Complete PR-06 before enabling this Linux capability.",
  message: "Server secret protection is not available.",
  secret: "must-not-leak",
  credentialPath: "C:\\secret.txt",
  commandLine: "unsafe --password=value",
});
assert.ok(unavailable instanceof PlatformCapabilityError);
assert.equal(unavailable.code, "CAPABILITY_UNAVAILABLE");
assert.deepEqual(unavailable.details, {
  role: "server",
  capability: "server-secret-protector",
  platform: "linux",
  ownerStage: "PR-06",
  recovery: "Complete PR-06 before enabling this Linux capability.",
});
assert.doesNotMatch(JSON.stringify(unavailable), /must-not-leak|secret\.txt|password/);

for (const [error, code] of [
  [unsupportedPlatform({ platform: "aix" }), "UNSUPPORTED_PLATFORM"],
  [dependencyInvalid({ dependency: "adb" }), "DEPENDENCY_INVALID"],
  [dependencyMissing({ dependency: "postgresql" }), "DEPENDENCY_MISSING"],
  [
    dependencyVersionMismatch({
      dependency: "postgresql",
      requiredMajor: 18,
      detectedMajor: 17,
    }),
    "DEPENDENCY_VERSION_MISMATCH",
  ],
]) {
  assert.ok(error instanceof PlatformCapabilityError);
  assert.equal(error.code, code);
}

assert.throws(
  () => new PlatformCapabilityError("UNKNOWN", "invalid"),
  /Unknown platform capability error code/
);
assert.throws(
  () => assertNativeRuntimeCapabilities({ node: "23.0.0" }),
  (error) =>
    error instanceof NativeRuntimeContractError &&
    error instanceof PlatformCapabilityError &&
    error.code === "DEPENDENCY_VERSION_MISMATCH" &&
    error.details?.requiredRange === ">=24 <25"
);

console.log("Platform capability error and native runtime compatibility verified.");
