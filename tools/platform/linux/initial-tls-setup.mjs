import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readServerRuntimeConfigSync } from "../../../quickhack_shared/core/server-runtime-config.mjs";
import { getQuickHackTlsStatus, initializeQuickHackTls, quickHackTlsPaths } from "../../server-console-tls.mjs";

export function initialTlsHosts(networkInterfaces = os.networkInterfaces(), hostname = os.hostname(), configuredHost = "", allowLocalhost = false) {
  const addresses = Object.values(networkInterfaces).flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => String(entry.address).trim().toLowerCase())
    .filter((entry) => entry && !entry.startsWith("169.254."))
    .sort();
  const normalizedHostname = String(hostname ?? "").trim().toLowerCase();
  const safeHostname = /^[a-z0-9.-]{1,253}$/u.test(normalizedHostname) && !normalizedHostname.includes("..")
    ? normalizedHostname : "";
  const selected = String(configuredHost ?? "").trim().toLowerCase();
  if (!selected && addresses.length !== 1 && !allowLocalhost) {
    const error = new Error("Set publicHost in the server runtime configuration before TLS initialization.");
    error.code = "TLS_HOST_SELECTION_REQUIRED";
    throw error;
  }
  const primaryHost = selected || (addresses.length === 1 ? addresses[0] : "localhost");
  return Object.freeze({ primaryHost, hostNames: Object.freeze([...new Set([primaryHost, ...addresses, safeHostname, "127.0.0.1", "localhost"].filter(Boolean))]) });
}

export function tlsHostSelectionStatus(tlsStatus, configuredHost = "", networkInterfaces, hostname, allowLocalhost = false) {
  if (!tlsStatus.ready) return Object.freeze({ matches: false, code: null });
  let selected = String(configuredHost ?? "").trim().toLowerCase();
  try {
    if (!selected) selected = initialTlsHosts(networkInterfaces ?? os.networkInterfaces(), hostname ?? os.hostname(), "", allowLocalhost).primaryHost;
  } catch (error) {
    return Object.freeze({ matches: false, code: error?.code === "TLS_HOST_SELECTION_REQUIRED" ? error.code : "TLS_HOST_DISCOVERY_UNAVAILABLE" });
  }
  const matches = new URL(tlsStatus.trustBundle.origin).hostname.toLowerCase() === selected;
  return Object.freeze({ matches, code: matches ? null : "TLS_HOST_CHANGED" });
}

export async function ensureInitialTls(dataDirectory, options = {}) {
  const current = getQuickHackTlsStatus(dataDirectory);
  const selectedHost = String(options.publicHost ?? "").trim().toLowerCase();
  if (current.ready) {
    const selection = tlsHostSelectionStatus(current, selectedHost, options.networkInterfaces, options.hostname, options.allowLocalhost);
    if (selection.matches) {
      return Object.freeze({ state: "READY", created: false, renewed: false });
    }
    if (!selectedHost) {
      const error = new Error("The server address changed; set publicHost before renewing TLS.");
      error.code = selection.code;
      throw error;
    }
    const hosts = options.hosts ?? initialTlsHosts(os.networkInterfaces(), os.hostname(), selectedHost);
    await initializeQuickHackTls({ dataDir: dataDirectory, httpsPort: 3443, mode: "INITIALIZE", ...hosts, ...(options.runtime ? { runtime: options.runtime } : {}) });
    return Object.freeze({ state: "READY", created: false, renewed: true });
  }
  const tlsDirectory = quickHackTlsPaths(dataDirectory).tlsDir;
  if (fs.existsSync(tlsDirectory)) {
    const error = new Error("Existing TLS material requires explicit recovery.");
    error.code = "TLS_RECOVERY_REQUIRED";
    throw error;
  }
  const hosts = options.hosts ?? initialTlsHosts(os.networkInterfaces(), os.hostname(), options.publicHost ?? "");
  await initializeQuickHackTls({ dataDir: dataDirectory, httpsPort: 3443, mode: "INITIALIZE", ...hosts, ...(options.runtime ? { runtime: options.runtime } : {}) });
  return Object.freeze({ state: "READY", created: true, renewed: false });
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== "--runtime-config" || !process.argv[3] || process.argv.length !== 4) throw new TypeError("A runtime config is required.");
    const runtimeConfig = readServerRuntimeConfigSync({ configPath: process.argv[3], kind: "operational" }).config;
    const result = await ensureInitialTls(runtimeConfig.dataDirectory, { publicHost: runtimeConfig.publicHost });
    process.stdout.write(`INITIAL_TLS=${result.state}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code || "INITIAL_TLS_FAILED"}: TLS setup failed.\n`);
    process.exitCode = 1;
  }
}
