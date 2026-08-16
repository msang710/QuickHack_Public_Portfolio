export const QUICKHACK_HSTS_HEADER_VALUE: "max-age=31536000";
export const QUICKHACK_HTTPS_TERMINATION_ENV: "QUICKHACK_HTTPS_TERMINATED";
export const QUICKHACK_PUBLIC_ORIGIN_ENV: "QUICKHACK_PUBLIC_SERVER_ORIGIN";

export function normalizePublicHttpsOrigin(value: unknown): string;
export function resolveTransportSecurityPolicy(input?: {
  runtimeRole?: unknown;
  production?: boolean;
  httpsTerminated?: unknown;
  publicOrigin?: unknown;
}): Readonly<{
  runtimeRole: string;
  production: boolean;
  httpsTerminated: boolean;
  publicOrigin: string;
  secureSessionCookie: boolean;
}>;
export function isTrustedLoopbackCookieHop(input?: {
  runtimeRole?: unknown;
  remoteOrigin?: unknown;
  localOrigin?: unknown;
  hostHeader?: unknown;
}): boolean;
