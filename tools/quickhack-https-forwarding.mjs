import net from "node:net";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function normalizeRemoteAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  const mappedIpv4 = address.startsWith("::ffff:") ? address.slice(7) : "";

  if (mappedIpv4 && net.isIP(mappedIpv4) === 4) {
    return mappedIpv4;
  }

  if (net.isIP(address) === 0) {
    throw new Error("QuickHack HTTPS gateway received an invalid client address.");
  }

  return address;
}

export function isLoopbackHost(value) {
  return LOOPBACK_HOSTS.has(String(value || "").trim().toLowerCase());
}

export function normalizeHttpAuthority(value) {
  const authority = String(value || "").trim().toLowerCase();

  if (!authority || /[\s/@?#]/.test(authority)) {
    throw new Error("QuickHack HTTPS gateway received an invalid Host authority.");
  }

  let parsed;
  try {
    parsed = new URL(`https://${authority}`);
  } catch {
    throw new Error("QuickHack HTTPS gateway received an invalid Host authority.");
  }

  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("QuickHack HTTPS gateway received an invalid Host authority.");
  }

  return parsed.host.toLowerCase();
}

export function hostAuthority(hostname, port) {
  const host = String(hostname || "").trim().toLowerCase();
  const bracketedHost = net.isIP(host) === 6 ? `[${host}]` : host;
  return normalizeHttpAuthority(`${bracketedHost}:${port}`);
}

export function buildTrustedForwardingHeaders(
  requestHeaders,
  remoteAddress,
  { publicAuthority, upstreamAuthority }
) {
  const headers = {};

  for (const [name, value] of Object.entries(requestHeaders || {})) {
    const normalizedName = name.toLowerCase();

    if (
      normalizedName === "host" ||
      normalizedName === "forwarded" ||
      normalizedName === "x-real-ip" ||
      normalizedName.startsWith("x-forwarded-")
    ) {
      continue;
    }

    headers[normalizedName] = value;
  }

  const clientAddress = normalizeRemoteAddress(remoteAddress);
  headers.host = normalizeHttpAuthority(upstreamAuthority);
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-host"] = normalizeHttpAuthority(publicAuthority);
  headers["x-forwarded-for"] = clientAddress;
  headers["x-real-ip"] = clientAddress;

  return headers;
}
