export type PublicErrorStatus = 400 | 401 | 403 | 404 | 409 | 503;

export type PublicErrorDetails =
  | Record<string, unknown>
  | readonly unknown[];

type PublicErrorInput = {
  status: PublicErrorStatus;
  code: string;
  message: string;
  details?: PublicErrorDetails;
};

export function normalizePublicErrorCode(value: string) {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "REQUEST_FAILED";
}

/**
 * An error whose status, code, and message are explicitly safe to expose to a
 * QuickHack client. All other thrown values are treated as internal failures.
 */
export class PublicError extends Error {
  readonly status: PublicErrorStatus;
  readonly code: string;
  readonly details?: PublicErrorDetails;

  constructor(input: PublicErrorInput) {
    super(input.message);
    this.name = "PublicError";
    this.status = input.status;
    this.code = normalizePublicErrorCode(input.code);
    this.details = input.details;
  }
}

export function publicBadRequest(
  code: string,
  message: string,
  details?: PublicErrorDetails
) {
  return new PublicError({ status: 400, code, message, details });
}

export function publicNotFound(
  code: string,
  message: string,
  details?: PublicErrorDetails
) {
  return new PublicError({ status: 404, code, message, details });
}

export function publicForbidden(
  code: string,
  message: string,
  details?: PublicErrorDetails
) {
  return new PublicError({ status: 403, code, message, details });
}

export function publicConflict(
  code: string,
  message: string,
  details?: PublicErrorDetails
) {
  return new PublicError({ status: 409, code, message, details });
}

export function publicUnavailable(
  code: string,
  message: string,
  details?: PublicErrorDetails
) {
  return new PublicError({ status: 503, code, message, details });
}
