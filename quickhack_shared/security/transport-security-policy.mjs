export const QUICKHACK_HSTS_HEADER_VALUE = "max-age=31536000";
export const QUICKHACK_HTTPS_TERMINATION_ENV = "QUICKHACK_HTTPS_TERMINATED";
export const QUICKHACK_PUBLIC_ORIGIN_ENV = "QUICKHACK_PUBLIC_SERVER_ORIGIN";

function exactFlag(value) {
  return String(value ?? "").trim() === "1";
}

export function normalizePublicHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? "").trim());
  } catch {
    throw new TypeError("QuickHack public server origin is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("QuickHack public server origin must be an HTTPS origin.");
  }
  return parsed.origin;
}

export function resolveTransportSecurityPolicy(input = {}) {
  const runtimeRole = String(input.runtimeRole ?? "").trim().toLowerCase();
  const production = input.production === true;
  const httpsTerminated = exactFlag(input.httpsTerminated);
  const rawPublicOrigin = String(input.publicOrigin ?? "").trim();
  const publicOrigin = rawPublicOrigin
    ? normalizePublicHttpsOrigin(rawPublicOrigin)
    : "";

  if (httpsTerminated && runtimeRole !== "server") {
    throw new TypeError("HTTPS termination may only be asserted by the server runtime.");
  }
  if (httpsTerminated && !publicOrigin) {
    throw new TypeError("HTTPS-terminated server runtime requires a public origin.");
  }

  return Object.freeze({
    runtimeRole,
    production,
    httpsTerminated,
    publicOrigin,
    secureSessionCookie:
      runtimeRole === "server" && (production || httpsTerminated),
  });
}

export function isTrustedLoopbackCookieHop(input = {}) {
  if (String(input.runtimeRole ?? "").trim().toLowerCase() !== "client") {
    return false;
  }

  let remote;
  let local;
  let authority;
  try {
    remote = new URL(String(input.remoteOrigin ?? ""));
    local = new URL(String(input.localOrigin ?? ""));
    authority = new URL(`http://${String(input.hostHeader ?? "")}`);
  } catch {
    return false;
  }

  return (
    remote.protocol === "https:" &&
    remote.origin === normalizePublicHttpsOrigin(remote.origin) &&
    local.protocol === "http:" &&
    local.hostname === "127.0.0.1" &&
    ["3001", "3002"].includes(local.port) &&
    authority.hostname === "127.0.0.1" &&
    authority.port === local.port &&
    authority.pathname === "/" &&
    !authority.username &&
    !authority.password
  );
}
