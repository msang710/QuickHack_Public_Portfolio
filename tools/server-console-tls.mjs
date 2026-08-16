import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";

function readJson(filename) {
  if (!fs.existsSync(filename)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function certificateSummary(filename) {
  if (!fs.existsSync(filename)) {
    return null;
  }

  try {
    const certificate = new crypto.X509Certificate(fs.readFileSync(filename));
    return {
      subject: certificate.subject,
      issuer: certificate.issuer,
      fingerprint256: certificate.fingerprint256,
      validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: new Date(certificate.validTo).toISOString(),
      expired: new Date(certificate.validTo).getTime() <= Date.now(),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      expired: true,
    };
  }
}

export function quickHackTlsPaths(dataDir) {
  const tlsDir = path.join(dataDir, "security", "tls");

  return {
    tlsDir,
    metadata: path.join(tlsDir, "metadata.json"),
    serverPfx: path.join(tlsDir, "server.pfx"),
    serverPassphrase: path.join(tlsDir, "server-pfx-passphrase.txt"),
    rootCaPem: path.join(tlsDir, "quickhack-ca.pem"),
    serverCertificatePem: path.join(tlsDir, "server-certificate.pem"),
    clientConfigDir: path.join(tlsDir, "client-config"),
  };
}

export function getQuickHackTlsStatus(dataDir) {
  const paths = quickHackTlsPaths(dataDir);
  const metadata = readJson(paths.metadata);
  const rootCertificate = certificateSummary(paths.rootCaPem);
  const serverCertificate = certificateSummary(paths.serverCertificatePem);
  const requiredFiles = [
    paths.serverPfx,
    paths.serverPassphrase,
    paths.rootCaPem,
    paths.serverCertificatePem,
    paths.metadata,
  ];
  const missingFiles = requiredFiles.filter((filename) => !fs.existsSync(filename));
  const ready =
    missingFiles.length === 0 &&
    Boolean(metadata?.serverUrl) &&
    !rootCertificate?.expired &&
    !serverCertificate?.expired;

  return {
    ready,
    missingFiles,
    metadata,
    rootCertificate,
    serverCertificate,
    paths,
  };
}

export async function initializeQuickHackTls(input) {
  const runtime = input.runtime ?? composeOperatorPlatform().serverConsoleRuntime;
  await runtime.initializeTls({ ...input, runtime: undefined });

  const status = getQuickHackTlsStatus(input.dataDir);

  if (!status.ready) {
    throw new Error(
      `HTTPS certificate files are incomplete: ${status.missingFiles.join(", ")}`
    );
  }

  return status;
}
