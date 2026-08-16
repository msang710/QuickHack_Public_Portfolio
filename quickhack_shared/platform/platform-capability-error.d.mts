export const PLATFORM_CAPABILITY_ERROR_CODES: readonly [
  "UNSUPPORTED_PLATFORM",
  "CAPABILITY_UNAVAILABLE",
  "DEPENDENCY_MISSING",
  "DEPENDENCY_INVALID",
  "DEPENDENCY_VERSION_MISMATCH"
];

export type PlatformCapabilityErrorCode =
  (typeof PLATFORM_CAPABILITY_ERROR_CODES)[number];

export type PlatformCapabilityErrorDetails = Readonly<{
  role?: string;
  capability?: string;
  platform?: string;
  dependency?: string;
  tool?: string;
  requiredRange?: string;
  requiredMajor?: number;
  detectedVersion?: string | null;
  detectedMajor?: number;
  ownerStage?: string;
  recovery?: string;
}>;

export type PlatformCapabilityErrorInput = PlatformCapabilityErrorDetails & {
  message?: string;
};

export class PlatformCapabilityError extends Error {
  readonly code: PlatformCapabilityErrorCode;
  readonly details?: PlatformCapabilityErrorDetails;
  constructor(
    code: PlatformCapabilityErrorCode,
    message: string,
    details?: PlatformCapabilityErrorDetails
  );
  toJSON(): Readonly<{
    name: string;
    code: PlatformCapabilityErrorCode;
    message: string;
    details?: PlatformCapabilityErrorDetails;
  }>;
}

export function unsupportedPlatform(
  input?: PlatformCapabilityErrorInput
): PlatformCapabilityError;
export function capabilityUnavailable(
  input?: PlatformCapabilityErrorInput
): PlatformCapabilityError;
export function dependencyMissing(
  input?: PlatformCapabilityErrorInput
): PlatformCapabilityError;
export function dependencyInvalid(
  input?: PlatformCapabilityErrorInput
): PlatformCapabilityError;
export function dependencyVersionMismatch(
  input?: PlatformCapabilityErrorInput
): PlatformCapabilityError;
