import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const OPENSSL_EXECUTABLE = "/usr/bin/openssl";

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

async function assertExecutable(filePath) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    const error = new Error("The fixed OpenSSL dependency is unavailable.");
    error.code = "DEPENDENCY_MISSING";
    throw error;
  }
}

export async function initializeLinuxServerConsoleTls(input) {
  const runtime = input.runtime;
  if (!runtime || typeof runtime.execFileText !== "function") {
    throw new TypeError("The Linux console runtime is required for TLS initialization.");
  }
  await assertExecutable(input.opensslExecutable ?? OPENSSL_EXECUTABLE);
  const executable = input.opensslExecutable ?? OPENSSL_EXECUTABLE;
  const hosts = [...new Set((input.hostNames ?? []).map(safeHostName))];
  if (hosts.length === 0) throw new TypeError("At least one TLS host name is required.");
  const tlsDirectory = path.resolve(input.dataDir, "security", "tls");
  const parent = path.dirname(tlsDirectory);
  const temporary = path.join(parent, `.tls.${process.pid}.${randomUUID()}.prepared`);
  const rollback = path.join(parent, `.tls.${process.pid}.${randomUUID()}.rollback`);
  const files = {
    caKey: path.join(temporary, "quickhack-ca-key.pem"),
    ca: path.join(temporary, "quickhack-ca.pem"),
    serverKey: path.join(temporary, "server-key.pem"),
    request: path.join(temporary, "server.csr"),
    certificate: path.join(temporary, "server-certificate.pem"),
    extension: path.join(temporary, "server-extension.conf"),
    pfx: path.join(temporary, "server.pfx"),
    passphrase: path.join(temporary, "server-pfx-passphrase.txt"),
    metadata: path.join(temporary, "metadata.json"),
  };
  const passphrase = randomBytes(32).toString("base64url");
  let movedExisting = false;
  try {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.mkdir(temporary, { mode: 0o700 });
    await fs.writeFile(files.extension, `subjectAltName=${hosts.map(subjectAlternativeName).join(",")}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600, flag: "wx" });
    await fs.writeFile(files.passphrase, `${passphrase}\n`, { mode: 0o600, flag: "wx" });
    const run = async (args) => {
      const result = await runtime.execFileText(executable, args, { cwd: temporary, timeout: 120_000 });
      if (!result.ok) {
        const error = new Error("OpenSSL certificate generation failed.");
        error.code = "TLS_INITIALIZATION_FAILED";
        throw error;
      }
    };
    await run(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", files.caKey]);
    await run(["req", "-x509", "-new", "-key", files.caKey, "-sha256", "-days", "3650", "-subj", "/CN=QuickHack Local CA", "-out", files.ca]);
    await run(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", files.serverKey]);
    await run(["req", "-new", "-key", files.serverKey, "-subj", `/CN=${hosts[0]}`, "-out", files.request]);
    await run(["x509", "-req", "-in", files.request, "-CA", files.ca, "-CAkey", files.caKey, "-CAcreateserial", "-days", "825", "-sha256", "-extfile", files.extension, "-out", files.certificate]);
    await run(["pkcs12", "-export", "-out", files.pfx, "-inkey", files.serverKey, "-in", files.certificate, "-certfile", files.ca, "-passout", `file:${files.passphrase}`]);
    await fs.writeFile(
      files.metadata,
      `${JSON.stringify({ schemaVersion: 1, serverUrl: `https://${hosts[0]}:${input.httpsPort}`, hostNames: hosts, generatedAt: new Date().toISOString(), provider: "openssl" }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" }
    );
    for (const filePath of [files.caKey, files.serverKey, files.pfx, files.passphrase, files.metadata]) await fs.chmod(filePath, 0o600);
    for (const filePath of [files.ca, files.certificate]) await fs.chmod(filePath, 0o644);
    await fs.rm(files.request, { force: true });
    await fs.rm(files.extension, { force: true });
    const existing = await fs.lstat(tlsDirectory).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("The TLS target is not a safe directory.");
      await fs.rename(tlsDirectory, rollback);
      movedExisting = true;
    }
    await fs.rename(temporary, tlsDirectory);
    if (movedExisting) await fs.rm(rollback, { recursive: true, force: true });
  } catch (error) {
    if (movedExisting) {
      const current = await fs.lstat(tlsDirectory).catch(() => null);
      if (!current) await fs.rename(rollback, tlsDirectory).catch(() => undefined);
    }
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
