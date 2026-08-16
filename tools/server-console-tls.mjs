import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { composeOperatorPlatform } from "./platform/compose-operator-platform.mjs";
import {
  certificateSha256,
  readClientTrustBundleSync,
  trustBundlePaths,
} from "./trust-bundle.mjs";

function readJson(filename) {
  if (!fs.existsSync(filename)) return null;
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return null;
  }
}

function certificateSummary(filename) {
  if (!fs.existsSync(filename)) return null;
  try {
    const certificate = new crypto.X509Certificate(fs.readFileSync(filename));
    return {
      certificate,
      subject: certificate.subject,
      issuer: certificate.issuer,
      fingerprint256: certificate.fingerprint256,
      fingerprintSha256: certificateSha256(certificate),
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

function safeDirectory(filename) {
  try {
    const stat = fs.lstatSync(filename);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeFile(filename, maxBytes = 4 * 1024 * 1024) {
  try {
    const stat = fs.lstatSync(filename);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size > 0 &&
      stat.size <= maxBytes
    );
  } catch {
    return false;
  }
}

function serverCertificateMatchesOrigin(serverCertificate, origin) {
  const host = new URL(origin).hostname;
  return net.isIP(host)
    ? Boolean(serverCertificate.checkIP(host))
    : Boolean(serverCertificate.checkHost(host, { wildcards: false }));
}

export function quickHackTlsPaths(dataDir) {
  const tlsDir = path.join(dataDir, "security", "tls");
  const clientConfigDir = path.join(tlsDir, "client-config");
  return {
    tlsDir,
    metadata: path.join(tlsDir, "metadata.json"),
    serverPfx: path.join(tlsDir, "server.pfx"),
    serverPassphrase: path.join(tlsDir, "server-pfx-passphrase.txt"),
    rootCaPem: path.join(tlsDir, "quickhack-ca.pem"),
    previousCaPem: path.join(tlsDir, "quickhack-previous-ca.pem"),
    crossSignedCaPem: path.join(tlsDir, "quickhack-current-cross-signed.pem"),
    serverCertificatePem: path.join(tlsDir, "server-certificate.pem"),
    linuxCaKey: path.join(tlsDir, "quickhack-ca-key.pem"),
    nativeIssuerPrivate: path.join(tlsDir, "issuer", "root-ca-private.bin"),
    clientConfigDir,
    clientConfig: trustBundlePaths(clientConfigDir),
  };
}

export function getQuickHackTlsStatus(dataDir) {
  const paths = quickHackTlsPaths(dataDir);
  const metadata = readJson(paths.metadata);
  const rootCertificate = certificateSummary(paths.rootCaPem);
  const previousRootCertificate = certificateSummary(paths.previousCaPem);
  const crossSignedCertificate = certificateSummary(paths.crossSignedCaPem);
  const serverCertificate = certificateSummary(paths.serverCertificatePem);
  const requiredFiles = [
    paths.serverPfx,
    paths.serverPassphrase,
    paths.rootCaPem,
    paths.serverCertificatePem,
    paths.metadata,
  ];
  const missingFiles = requiredFiles.filter((filename) => !safeFile(filename));
  const errors = [];
  let trustBundle = null;

  if (!safeDirectory(paths.tlsDir)) errors.push("TLS_DIRECTORY_UNSAFE");
  try {
    trustBundle = readClientTrustBundleSync(paths.clientConfigDir);
  } catch (error) {
    errors.push(error?.code || "TRUST_BUNDLE_INVALID");
  }
  const rotationActive = Boolean(trustBundle?.manifest.previousCaSha256);
  if (rotationActive) {
    if (!safeFile(paths.previousCaPem)) missingFiles.push(paths.previousCaPem);
    if (!safeFile(paths.crossSignedCaPem)) missingFiles.push(paths.crossSignedCaPem);
  } else {
    if (safeFile(paths.previousCaPem)) errors.push("TLS_PREVIOUS_CA_STALE");
    if (safeFile(paths.crossSignedCaPem)) errors.push("TLS_CROSS_SIGNED_CA_STALE");
  }

  const provider = String(metadata?.provider ?? "");
  if (provider === "openssl") {
    if (!safeFile(paths.linuxCaKey)) missingFiles.push(paths.linuxCaKey);
  } else if (provider === "native-secret") {
    if (!safeFile(paths.nativeIssuerPrivate)) missingFiles.push(paths.nativeIssuerPrivate);
  } else if (metadata) {
    errors.push("TLS_PROVIDER_INVALID");
  }

  if (!metadata || metadata.schemaVersion !== 2) {
    errors.push("TLS_METADATA_INVALID");
  }
  if (trustBundle && metadata) {
    if (metadata.serverUrl !== trustBundle.origin) errors.push("TLS_ORIGIN_MISMATCH");
    if (metadata.currentCaSha256 !== trustBundle.manifest.currentCaSha256) {
      errors.push("TLS_CURRENT_CA_MISMATCH");
    }
    if ((metadata.previousCaSha256 ?? "") !== (trustBundle.manifest.previousCaSha256 ?? "")) {
      errors.push("TLS_PREVIOUS_CA_MISMATCH");
    }
    if ((metadata.rotationNotBefore ?? "") !== (trustBundle.manifest.rotationNotBefore ?? "")) {
      errors.push("TLS_ROTATION_METADATA_MISMATCH");
    }
    const origin = new URL(trustBundle.origin);
    const expectedPort = Number(origin.port || 443);
    if (
      metadata.httpsPort !== expectedPort ||
      metadata.primaryHost !== origin.hostname ||
      !Array.isArray(metadata.hostNames) ||
      !metadata.hostNames.includes(origin.hostname)
    ) {
      errors.push("TLS_HOST_METADATA_MISMATCH");
    }
  }
  if (trustBundle && rootCertificate?.certificate) {
    if (rootCertificate.fingerprintSha256 !== trustBundle.manifest.currentCaSha256) {
      errors.push("TLS_ROOT_CA_MISMATCH");
    }
  } else if (missingFiles.length === 0) {
    errors.push("TLS_ROOT_CA_INVALID");
  }
  if (rotationActive && trustBundle) {
    try {
      if (
        !previousRootCertificate?.certificate ||
        previousRootCertificate.expired ||
        previousRootCertificate.fingerprintSha256 !== trustBundle.manifest.previousCaSha256
      ) {
        errors.push("TLS_PREVIOUS_CA_INVALID");
      }
      const currentPublicKey = rootCertificate?.certificate?.publicKey.export({
        type: "spki",
        format: "der",
      });
      const crossSignedPublicKey = crossSignedCertificate?.certificate?.publicKey.export({
        type: "spki",
        format: "der",
      });
      if (
        !rootCertificate?.certificate ||
        !previousRootCertificate?.certificate ||
        !crossSignedCertificate?.certificate ||
        crossSignedCertificate.expired ||
        !crossSignedCertificate.certificate.ca ||
        !Buffer.from(currentPublicKey).equals(Buffer.from(crossSignedPublicKey)) ||
        !crossSignedCertificate.certificate.checkIssued(previousRootCertificate.certificate) ||
        !crossSignedCertificate.certificate.verify(previousRootCertificate.certificate.publicKey)
      ) {
        errors.push("TLS_CROSS_SIGNED_CA_INVALID");
      }
    } catch {
      errors.push("TLS_CROSS_SIGNED_CA_INVALID");
    }
  }
  if (trustBundle && rootCertificate?.certificate && serverCertificate?.certificate) {
    try {
      if (
        serverCertificate.expired ||
        !serverCertificate.certificate.checkIssued(rootCertificate.certificate) ||
        !serverCertificate.certificate.verify(rootCertificate.certificate.publicKey) ||
        !serverCertificateMatchesOrigin(serverCertificate.certificate, trustBundle.origin)
      ) {
        errors.push("TLS_SERVER_CERTIFICATE_MISMATCH");
      }
    } catch {
      errors.push("TLS_SERVER_CERTIFICATE_MISMATCH");
    }
  } else if (missingFiles.length === 0) {
    errors.push("TLS_SERVER_CERTIFICATE_INVALID");
  }
  if (missingFiles.length === 0) {
    try {
      const passphrase = fs.readFileSync(paths.serverPassphrase, "utf8").trim();
      if (!passphrase) throw new Error("empty passphrase");
      tls.createSecureContext({ pfx: fs.readFileSync(paths.serverPfx), passphrase });
    } catch {
      errors.push("TLS_PFX_INVALID");
    }
  }

  const uniqueMissingFiles = [...new Set(missingFiles)];
  const uniqueErrors = [...new Set(errors)];
  const ready = uniqueMissingFiles.length === 0 && uniqueErrors.length === 0;
  return {
    ready,
    missingFiles: uniqueMissingFiles,
    errors: uniqueErrors,
    metadata,
    trustBundle,
    rootCertificate: rootCertificate
      ? { ...rootCertificate, certificate: undefined }
      : null,
    previousRootCertificate: previousRootCertificate
      ? { ...previousRootCertificate, certificate: undefined }
      : null,
    crossSignedCertificate: crossSignedCertificate
      ? { ...crossSignedCertificate, certificate: undefined }
      : null,
    serverCertificate: serverCertificate
      ? { ...serverCertificate, certificate: undefined }
      : null,
    paths,
  };
}

export async function initializeQuickHackTls(input) {
  const runtime = input.runtime ?? composeOperatorPlatform().serverConsoleRuntime;
  await runtime.initializeTls({ ...input, runtime: undefined });
  const status = getQuickHackTlsStatus(input.dataDir);
  if (!status.ready) {
    const error = new Error(
      `HTTPS certificate files are invalid: ${[...status.missingFiles, ...status.errors].join(", ")}`
    );
    error.code = "TLS_READINESS_FAILED";
    throw error;
  }
  return status;
}
