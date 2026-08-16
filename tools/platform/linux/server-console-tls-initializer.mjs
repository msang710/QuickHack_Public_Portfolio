import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  certificateSha256,
  inspectCaCertificate,
  readClientTrustBundleSync,
  writeClientTrustBundleSync,
} from "../../trust-bundle.mjs";

export const OPENSSL_EXECUTABLE = "/usr/bin/openssl";
const MODES = new Set(["INITIALIZE", "ROTATE", "FINALIZE_ROTATION"]);

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeHostName(value) {
  const host = String(value ?? "").trim().toLowerCase();
  if (!host || host.length > 253 || !/^[a-z0-9:.-]+$/u.test(host) || host.includes("..")) {
    throw new TypeError("A TLS host name is invalid.");
  }
  return host;
}

function subjectAlternativeName(host) {
  return host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)
    ? `IP:${host}`
    : `DNS:${host}`;
}

async function safeRegularFile(filePath, required = false) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat) {
    if (required) throw typedError("TLS_ISSUER_INCOMPLETE", `Required TLS issuer file is missing: ${filePath}`);
    return false;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) {
    throw typedError("TLS_ISSUER_INVALID", `TLS issuer file is unsafe: ${filePath}`);
  }
  return true;
}

async function assertExecutable(filePath) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw typedError("DEPENDENCY_MISSING", "The fixed OpenSSL dependency is unavailable.");
  }
}

function readExistingBundleIfPresent(clientConfigDirectory) {
  try {
    return readClientTrustBundleSync(clientConfigDirectory);
  } catch (error) {
    if (error?.code === "TRUST_BUNDLE_INCOMPLETE") {
      return null;
    }
    throw error;
  }
}

export async function initializeLinuxServerConsoleTls(input) {
  const runtime = input.runtime;
  if (!runtime || typeof runtime.execFileText !== "function") {
    throw new TypeError("The Linux console runtime is required for TLS initialization.");
  }
  const executable = input.opensslExecutable ?? OPENSSL_EXECUTABLE;
  await assertExecutable(executable);
  const mode = String(input.mode ?? "INITIALIZE").trim().toUpperCase();
  if (!MODES.has(mode)) throw new TypeError("Unsupported TLS initialization mode.");
  const hosts = [...new Set((input.hostNames ?? []).map(safeHostName))];
  const primaryHost = safeHostName(input.primaryHost ?? hosts[0]);
  if (!hosts.includes(primaryHost)) hosts.unshift(primaryHost);
  if (hosts.length === 0) throw new TypeError("At least one TLS host name is required.");
  const httpsPort = Number(input.httpsPort);
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) {
    throw new TypeError("HTTPS port is invalid.");
  }

  const tlsDirectory = path.resolve(input.dataDir, "security", "tls");
  const parent = path.dirname(tlsDirectory);
  const temporary = path.join(parent, `.tls.${process.pid}.${randomUUID()}.prepared`);
  const rollback = path.join(parent, `.tls.${process.pid}.${randomUUID()}.rollback`);
  const existing = {
    caKey: path.join(tlsDirectory, "quickhack-ca-key.pem"),
    ca: path.join(tlsDirectory, "quickhack-ca.pem"),
    previousCa: path.join(tlsDirectory, "quickhack-previous-ca.pem"),
    crossSignedCa: path.join(tlsDirectory, "quickhack-current-cross-signed.pem"),
    clientConfig: path.join(tlsDirectory, "client-config"),
  };
  const files = {
    caKey: path.join(temporary, "quickhack-ca-key.pem"),
    ca: path.join(temporary, "quickhack-ca.pem"),
    previousCa: path.join(temporary, "quickhack-previous-ca.pem"),
    crossSignedCa: path.join(temporary, "quickhack-current-cross-signed.pem"),
    crossRequest: path.join(temporary, "quickhack-current-cross-signed.csr"),
    crossExtension: path.join(temporary, "cross-signed-ca-extension.conf"),
    crossSerial: path.join(temporary, "cross-signed-ca.srl"),
    serverChain: path.join(temporary, "server-chain.pem"),
    serverKey: path.join(temporary, "server-key.pem"),
    request: path.join(temporary, "server.csr"),
    certificate: path.join(temporary, "server-certificate.pem"),
    extension: path.join(temporary, "server-extension.conf"),
    pfx: path.join(temporary, "server.pfx"),
    passphrase: path.join(temporary, "server-pfx-passphrase.txt"),
    metadata: path.join(temporary, "metadata.json"),
    clientConfig: path.join(temporary, "client-config"),
  };
  const existingKey = await safeRegularFile(existing.caKey);
  const existingCa = await safeRegularFile(existing.ca);
  if (existingKey !== existingCa) {
    throw typedError("TLS_ISSUER_INCOMPLETE", "Existing QuickHack CA key/certificate pair is incomplete.");
  }
  let oldBundle = null;
  if (existingKey) {
    inspectCaCertificate(await fs.readFile(existing.ca, "utf8"), { label: "existing current CA" });
    const clientConfigStat = await fs.lstat(existing.clientConfig).catch(() => null);
    if (clientConfigStat) {
      if (!clientConfigStat.isDirectory() || clientConfigStat.isSymbolicLink()) {
        throw typedError("TRUST_BUNDLE_INVALID", "Existing client-config directory is unsafe.");
      }
      oldBundle = readExistingBundleIfPresent(existing.clientConfig);
      if (!oldBundle) {
        throw typedError("TRUST_BUNDLE_INVALID", "Existing client-config directory is incomplete.");
      }
      if (oldBundle.manifest.currentCaSha256 !== certificateSha256(await fs.readFile(existing.ca))) {
        throw typedError("TRUST_BUNDLE_INVALID", "Existing client bundle does not match its current issuer.");
      }
    }
  }
  const rotationActive = Boolean(oldBundle?.manifest.previousCaSha256);
  if (rotationActive) {
    await safeRegularFile(existing.previousCa, true);
    await safeRegularFile(existing.crossSignedCa, true);
    if (certificateSha256(await fs.readFile(existing.previousCa)) !== oldBundle.manifest.previousCaSha256) {
      throw typedError("TRUST_BUNDLE_INVALID", "Existing previous CA does not match its client bundle.");
    }
  } else if (await safeRegularFile(existing.previousCa)) {
    throw typedError("TRUST_BUNDLE_INVALID", "A stale previous CA exists outside a rotation window.");
  } else if (await safeRegularFile(existing.crossSignedCa)) {
    throw typedError("TRUST_BUNDLE_INVALID", "A stale cross-signed CA exists outside a rotation window.");
  }
  if (mode === "ROTATE" && !existingKey) {
    throw typedError("TLS_ROTATION_REQUIRES_CURRENT_CA", "CA rotation requires an existing current CA.");
  }
  if (mode === "ROTATE" && rotationActive) {
    throw typedError("TLS_ROTATION_ALREADY_ACTIVE", "Finalize the current CA rotation before starting another.");
  }
  if (mode === "FINALIZE_ROTATION" && !rotationActive) {
    throw typedError("TLS_ROTATION_NOT_ACTIVE", "There is no active CA rotation to finalize.");
  }

  const passphrase = randomBytes(32).toString("base64url");
  const generatedAt = new Date().toISOString();
  let rotationNotBefore = "";
  let createdNewRoot = false;
  let movedExisting = false;
  let published = false;
  try {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.mkdir(temporary, { mode: 0o700 });
    await fs.writeFile(
      files.extension,
      `subjectAltName=${hosts.map(subjectAlternativeName).join(",")}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n`,
      { mode: 0o600, flag: "wx" }
    );
    await fs.writeFile(files.passphrase, `${passphrase}\n`, { mode: 0o600, flag: "wx" });
    const run = async (args) => {
      const result = await runtime.execFileText(executable, args, { cwd: temporary, timeout: 120_000 });
      if (!result.ok) {
        throw typedError("TLS_INITIALIZATION_FAILED", "OpenSSL certificate generation failed.");
      }
      return result;
    };

    let generatedRootCommonName = "";
    if (mode === "ROTATE" || !existingKey) {
      createdNewRoot = true;
      generatedRootCommonName = `QuickHack Local Root CA ${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      await run(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", files.caKey]);
      await run(["req", "-x509", "-new", "-key", files.caKey, "-sha256", "-days", "3650", "-subj", `/CN=${generatedRootCommonName}`, "-addext", "basicConstraints=critical,CA:TRUE,pathlen:1", "-addext", "keyUsage=critical,keyCertSign,cRLSign,digitalSignature", "-out", files.ca]);
    } else {
      await fs.copyFile(existing.caKey, files.caKey, fsConstants.COPYFILE_EXCL);
      await fs.copyFile(existing.ca, files.ca, fsConstants.COPYFILE_EXCL);
      await run(["pkey", "-in", files.caKey, "-check", "-noout"]);
    }

    if (mode === "ROTATE") {
      await fs.copyFile(existing.ca, files.previousCa, fsConstants.COPYFILE_EXCL);
      await fs.writeFile(
        files.crossExtension,
        "[v3_ca]\nbasicConstraints=critical,CA:TRUE,pathlen:1\nkeyUsage=critical,keyCertSign,cRLSign,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n",
        { mode: 0o600, flag: "wx" }
      );
      await run(["req", "-new", "-key", files.caKey, "-subj", `/CN=${generatedRootCommonName}`, "-out", files.crossRequest]);
      await run([
        "x509", "-req", "-in", files.crossRequest,
        "-CA", existing.ca, "-CAkey", existing.caKey,
        "-CAserial", files.crossSerial, "-CAcreateserial",
        "-days", "3650", "-sha256",
        "-extfile", files.crossExtension, "-extensions", "v3_ca",
        "-out", files.crossSignedCa,
      ]);
      rotationNotBefore = generatedAt;
    } else if (mode === "INITIALIZE" && rotationActive) {
      await fs.copyFile(existing.previousCa, files.previousCa, fsConstants.COPYFILE_EXCL);
      await fs.copyFile(existing.crossSignedCa, files.crossSignedCa, fsConstants.COPYFILE_EXCL);
      rotationNotBefore = oldBundle.manifest.rotationNotBefore;
    }

    await run(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", files.serverKey]);
    await run(["req", "-new", "-key", files.serverKey, "-subj", `/CN=${primaryHost}`, "-out", files.request]);
    await run(["x509", "-req", "-in", files.request, "-CA", files.ca, "-CAkey", files.caKey, "-CAcreateserial", "-days", "365", "-sha256", "-extfile", files.extension, "-out", files.certificate]);
    if (rotationNotBefore) {
      await fs.writeFile(
        files.serverChain,
        `${await fs.readFile(files.crossSignedCa, "utf8")}${await fs.readFile(files.previousCa, "utf8")}`,
        { mode: 0o600, flag: "wx" }
      );
    } else {
      await fs.copyFile(files.ca, files.serverChain, fsConstants.COPYFILE_EXCL);
    }
    await run(["pkcs12", "-export", "-out", files.pfx, "-inkey", files.serverKey, "-in", files.certificate, "-certfile", files.serverChain, "-passout", `file:${files.passphrase}`]);

    const currentCaPem = await fs.readFile(files.ca, "utf8");
    const previousCaPem = rotationNotBefore ? await fs.readFile(files.previousCa, "utf8") : "";
    const origin = `https://${primaryHost.includes(":") ? `[${primaryHost}]` : primaryHost}:${httpsPort}`;
    const bundle = writeClientTrustBundleSync(files.clientConfig, {
      origin,
      currentCaPem,
      previousCaPem,
      ...(rotationNotBefore ? { rotationNotBefore } : {}),
      generatedAt,
    });
    const currentCertificate = new X509Certificate(await fs.readFile(files.ca));
    const serverCertificate = new X509Certificate(await fs.readFile(files.certificate));
    await fs.writeFile(
      files.metadata,
      `${JSON.stringify({
        schemaVersion: 2,
        serverUrl: origin,
        hostNames: hosts,
        primaryHost,
        httpsPort,
        generatedAt,
        provider: "openssl",
        createdNewRoot,
        currentCaSha256: bundle.manifest.currentCaSha256,
        ...(bundle.manifest.previousCaSha256 ? { previousCaSha256: bundle.manifest.previousCaSha256, rotationNotBefore } : {}),
        rootNotAfter: new Date(currentCertificate.validTo).toISOString(),
        serverNotAfter: new Date(serverCertificate.validTo).toISOString(),
      }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" }
    );

    for (const filePath of [files.caKey, files.serverKey, files.pfx, files.passphrase, files.metadata]) {
      await fs.chmod(filePath, 0o600);
    }
    for (const filePath of [files.ca, files.certificate, ...(rotationNotBefore ? [files.previousCa, files.crossSignedCa] : [])]) {
      await fs.chmod(filePath, 0o644);
    }
    await fs.rm(files.request, { force: true });
    await fs.rm(files.extension, { force: true });
    await fs.rm(files.crossRequest, { force: true });
    await fs.rm(files.crossExtension, { force: true });
    await fs.rm(files.crossSerial, { force: true });
    await fs.rm(files.serverChain, { force: true });
    await fs.rm(path.join(temporary, "quickhack-ca.srl"), { force: true });

    const targetStat = await fs.lstat(tlsDirectory).catch(() => null);
    if (targetStat) {
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        throw typedError("TLS_TARGET_UNSAFE", "The TLS target is not a safe directory.");
      }
      await fs.rename(tlsDirectory, rollback);
      movedExisting = true;
    }
    await fs.rename(temporary, tlsDirectory);
    published = true;
    if (movedExisting) await fs.rm(rollback, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    if (movedExisting && !published) {
      const current = await fs.lstat(tlsDirectory).catch(() => null);
      if (!current) await fs.rename(rollback, tlsDirectory).catch(() => undefined);
    }
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
