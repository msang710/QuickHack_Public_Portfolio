import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import pg from "pg";
import { readServerRuntimeConfigSync } from "../../../quickhack_shared/core/server-runtime-config.mjs";
import { POSTGRESQL_MAJOR_VERSION, POSTGRESQL_TOOL_CAPABILITIES, assertPostgresqlToolVersions } from "../../../quickhack_shared/platform/native-runtime-contract.mjs";
import { createLinuxPostgresqlServiceController } from "../../../quickhack_server/platform/linux/postgresql-service-controller.mjs";
import { createPostgresqlServiceCore } from "../../postgresql-service-core.mjs";
import { createLinuxPostgresqlCredentialTransaction } from "./postgresql-credential-transaction.mjs";
import { createSystemdCredentialProvisioner, systemdCredentialCiphertextPath } from "./systemd-credential-provisioner.mjs";
import { runSystemdCredentialProcess } from "./systemd-credential-process.mjs";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../../quickhack_shared/platform/linux/child-process-policy.mjs";

const { Pool } = pg;
const POSTGRESQL_MAJOR = String(POSTGRESQL_MAJOR_VERSION);

function createInstallerRuntime(environment = process.env) {
  function childEnvironment({ executableDirectories = [], overrides = {} } = {}) {
    return createChildProcessEnvironment({
      policy: createLinuxChildProcessPolicy(environment),
      source: environment,
      executableDirectories,
      overrides,
    });
  }
  function execFileText(file, args, options = {}) {
    if (!path.posix.isAbsolute(file)) throw new TypeError("Linux PostgreSQL processes require an absolute executable path.");
    return new Promise((resolve) => {
      execFile(file, args, {
        shell: false,
        timeout: options.timeout ?? options.timeoutMs ?? 120_000,
        maxBuffer: 256 * 1024,
        env: options.env ?? childEnvironment({ executableDirectories: [path.dirname(file)] }),
      }, (error, stdout, stderr) => resolve({
        ok: !error,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        code: typeof error?.code === "number" ? error.code : null,
      }));
    });
  }
  return Object.freeze({ childEnvironment, execFileText });
}

function identifier(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(normalized)) throw new Error("A PostgreSQL manifest identifier is invalid.");
  return `"${normalized}"`;
}

function passwordText(buffer) {
  const value = buffer?.toString("utf8") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("A PostgreSQL password payload is invalid.");
  return value;
}

async function pathExists(filePath) {
  try { await fs.lstat(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function assertLoopbackPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => reject(new Error(`PostgreSQL port ${port} is already in use.`)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

async function resolveServiceIdentity(runtime, userName) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(userName)) throw new Error("The PostgreSQL service user is invalid.");
  const uidResult = await runtime.execFileText("/usr/bin/id", ["-u", userName]);
  const gidResult = await runtime.execFileText("/usr/bin/id", ["-g", userName]);
  const uid = Number(uidResult.stdout.trim());
  const gid = Number(gidResult.stdout.trim());
  if (!uidResult.ok || !gidResult.ok || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1) {
    const error = new Error("The PostgreSQL service identity is unavailable.");
    error.code = "SERVICE_IDENTITY_MISSING";
    throw error;
  }
  return { userName, uid, gid };
}

async function assertRegularExecutable(filePath) {
  if (!path.posix.isAbsolute(filePath)) throw new Error("PostgreSQL executables must use absolute paths.");
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    const error = new Error("A required PostgreSQL executable is unavailable.");
    error.code = "DEPENDENCY_MISSING";
    throw error;
  }
}

async function runAsServiceUserWithSecretFd(runtime, identity, executable, args, secret) {
  const runuser = "/usr/bin/runuser";
  await assertRegularExecutable(runuser);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(
      runuser,
      ["--user", identity.userName, "--", executable, ...args],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: runtime.childEnvironment({ executableDirectories: ["/usr/bin", path.dirname(executable)] }),
      }
    );
    let outputBytes = 0;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error("The PostgreSQL initialization operation timed out.");
      error.code = "POSTGRESQL_NATIVE_OPERATION_TIMEOUT";
      finish(error);
    }, 120_000);
    const bound = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 256 * 1024) child.kill("SIGKILL");
    };
    child.stdout.on("data", bound);
    child.stderr.on("data", bound);
    child.once("error", (error) => {
      finish(error);
    });
    child.once("exit", (code) => {
      if (code === 0 && outputBytes <= 256 * 1024) finish();
      else {
        const error = new Error("A PostgreSQL native operation failed.");
        error.code = outputBytes > 256 * 1024 ? "POSTGRESQL_NATIVE_OUTPUT_LIMIT" : "POSTGRESQL_NATIVE_OPERATION_FAILED";
        finish(error);
      }
    });
    child.stdio[3].once("error", () => {
      child.kill("SIGKILL");
      const error = new Error("The PostgreSQL bootstrap input pipe failed.");
      error.code = "POSTGRESQL_SECRET_PIPE_FAILED";
      finish(error);
    });
    child.stdio[3].write(secret);
    child.stdio[3].end("\n");
  });
}

async function writeAtomic(filePath, source, identity) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chown(temporary, identity.uid, identity.gid);
  await fs.rename(temporary, filePath);
}

async function provisionCatalog({ runtimeConfig, manifest, passwords }) {
  const operator = manifest.roles.find((role) => role.kind === "operator");
  const operatorPassword = passwordText(passwords.get("operator"));
  const connectionString = `postgresql://${encodeURIComponent(operator.user)}:${encodeURIComponent(operatorPassword)}@127.0.0.1:${runtimeConfig.database.port}/postgres?application_name=quickhack-linux-provisioning`;
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 60_000 });
  const client = await pool.connect();
  try {
    const settings = await client.query("SELECT current_setting('listen_addresses') AS listen_addresses, current_setting('port') AS port, current_setting('password_encryption') AS password_encryption, current_setting('ssl') AS ssl");
    const current = settings.rows[0] ?? {};
    if (String(current.listen_addresses) !== "127.0.0.1" || String(current.port) !== String(runtimeConfig.database.port) || String(current.password_encryption) !== "scram-sha-256" || String(current.ssl) !== "off") {
      throw new Error("The active PostgreSQL security configuration does not match QuickHack.");
    }
    if (manifest.flavor === "OPERATIONAL") {
      const forbidden = await client.query("SELECT datname AS name FROM pg_database WHERE datname LIKE 'quickhack_mock_%' UNION ALL SELECT rolname AS name FROM pg_roles WHERE rolname LIKE 'quickhack_mock_%'");
      if (forbidden.rowCount > 0) throw new Error("Demonstration PostgreSQL catalogs exist on an operational server.");
    }
    for (const role of manifest.roles.filter((item) => item.kind !== "operator")) {
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role.user]);
      const verb = exists.rowCount === 0 ? "CREATE ROLE" : "ALTER ROLE";
      await client.query(`${verb} ${identifier(role.user)} WITH LOGIN PASSWORD '${passwordText(passwords.get(role.kind))}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    }
    for (const database of manifest.databases) {
      const owner = manifest.roles.find((role) => role.kind === database.ownerRole);
      const exists = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [database.name]);
      if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${identifier(database.name)} OWNER ${identifier(owner.user)} TEMPLATE template0 ENCODING 'UTF8'`);
      else await client.query(`ALTER DATABASE ${identifier(database.name)} OWNER TO ${identifier(owner.user)}`);
    }
    const allRoles = manifest.roles.map((role) => identifier(role.user)).join(", ");
    for (const database of manifest.databases) await client.query(`REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE ${identifier(database.name)} FROM PUBLIC, ${allRoles}`);
    const main = manifest.databases.find((database) => database.kind === "main");
    const runtime = manifest.roles.find((role) => role.kind === "runtime");
    const backup = manifest.roles.find((role) => role.kind === "backup");
    await client.query(`GRANT CONNECT ON DATABASE ${identifier(main.name)} TO ${identifier(runtime.user)}, ${identifier(backup.user)}`);
    for (const database of manifest.databases.filter((item) => item.kind !== "main")) {
      const owner = manifest.roles.find((role) => role.kind === database.ownerRole);
      await client.query(`GRANT CONNECT ON DATABASE ${identifier(database.name)} TO ${identifier(owner.user)}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

export async function installLinuxPostgresqlService(input, options = {}) {
  const getuid = options.getuid ?? process.getuid?.bind(process);
  if (typeof getuid !== "function" || getuid() !== 0) {
    const error = new Error("Administrator authentication is required for PostgreSQL install or repair.");
    error.code = "POSTGRESQL_ROOT_REQUIRED";
    throw error;
  }
  const runtimeConfig = readServerRuntimeConfigSync({ configPath: input.runtimeConfig, kind: "operational" }).config;
  const runtime = options.runtime ?? createInstallerRuntime();
  const serviceUser = input.serviceUser ?? "quickhack-postgresql";
  const identity = await (options.resolveServiceIdentity ?? resolveServiceIdentity)(runtime, serviceUser);
  const binDirectory = path.resolve(input.postgresqlBinDirectory ?? "/usr/bin");
  const clusterDirectory = path.resolve(input.dataDir, "postgresql", POSTGRESQL_MAJOR, "data");
  const clusterParent = path.dirname(clusterDirectory);
  const controller = options.controller ?? createLinuxPostgresqlServiceController({ platform: "linux" });
  const provisioner = options.provisioner ?? createSystemdCredentialProvisioner();
  const credentialTransaction = createLinuxPostgresqlCredentialTransaction({
    provisioner,
    readExisting: async (identityValue) => {
      const ciphertext = systemdCredentialCiphertextPath(identityValue);
      if (!(await pathExists(ciphertext))) return null;
      return runSystemdCredentialProcess(["decrypt", `--name=${identityValue.id}`, ciphertext, "-"]);
    },
  });
  const executables = Object.fromEntries(POSTGRESQL_TOOL_CAPABILITIES.service.map((tool) => [tool, path.join(binDirectory, tool)]));
  const adapter = {
    async inspect() {
      const existingVersion = String(await fs.readFile(path.join(clusterDirectory, "PG_VERSION"), "utf8").catch(() => "")).trim();
      if (existingVersion && existingVersion !== POSTGRESQL_MAJOR) throw new Error(`Unsupported PostgreSQL data directory version: ${existingVersion}`);
      return { fresh: !existingVersion, existingVersion, serviceName: controller.descriptor.id, clusterDirectory };
    },
    async validateToolchain() {
      const versions = {};
      for (const [tool, executable] of Object.entries(executables)) {
        await assertRegularExecutable(executable);
        const result = await runtime.execFileText(executable, ["--version"]);
        if (!result.ok) throw new Error("PostgreSQL toolchain validation failed.");
        versions[tool] = `${result.stdout}\n${result.stderr}`.trim();
      }
      assertPostgresqlToolVersions(versions, { capability: "service" });
    },
    async assertPortAvailable() {
      const status = await controller.status();
      if (status.state === "ACTIVE") throw new Error("A fresh PostgreSQL port is already owned by the configured service.");
      await assertLoopbackPortAvailable(runtimeConfig.database.port);
    },
    async prepareCredentials() { return credentialTransaction.prepare(runtimeConfig); },
    async initializeCluster({ credentialToken }) {
      await fs.mkdir(clusterParent, { recursive: true, mode: 0o700 });
      await fs.chown(clusterParent, identity.uid, identity.gid);
      const staging = path.join(clusterParent, `.data.initializing.${process.pid}.${randomUUID()}`);
      try {
        await fs.mkdir(staging, { mode: 0o700 });
        await fs.chown(staging, identity.uid, identity.gid);
        const operatorSecret = credentialToken.passwords.get("operator");
        passwordText(operatorSecret);
        await runAsServiceUserWithSecretFd(
          runtime,
          identity,
          executables.initdb,
          ["--pgdata", staging, "--username", "quickhack_operator", "--pwfile=/proc/self/fd/3", "--auth-host", "scram-sha-256", "--auth-local", "scram-sha-256", "--encoding", "UTF8", "--locale", "C"],
          operatorSecret
        );
        await fs.rename(staging, clusterDirectory);
      } finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    async configureCluster() {
      const managedName = "quickhack-managed.conf";
      await writeAtomic(path.join(clusterDirectory, managedName), [`# QuickHack managed PostgreSQL ${POSTGRESQL_MAJOR} boundary.`, "listen_addresses = '127.0.0.1'", `port = ${runtimeConfig.database.port}`, "password_encryption = 'scram-sha-256'", "ssl = off", "logging_collector = on", "log_connections = on", "log_disconnections = on", ""].join("\n"), identity);
      const mainPath = path.join(clusterDirectory, "postgresql.conf");
      const current = await fs.readFile(mainPath, "utf8");
      const cleaned = current.split(/\r?\n/u).filter((line) => !/^\s*include(?:_if_exists)?\s*=\s*['"]quickhack-managed\.conf['"]/iu.test(line)).join("\n").replace(/\s*$/u, "");
      await writeAtomic(mainPath, `${cleaned}\n\ninclude = '${managedName}'\n`, identity);
    },
    async registerService() {
      const status = await controller.status();
      if (status.state === "MISSING") {
        const error = new Error("The PostgreSQL unit template has not been installed by the package.");
        error.code = "SERVICE_UNIT_MISSING";
        throw error;
      }
    },
    async startService() { await controller.restart(); },
    async provisionCatalog({ manifest, credentialToken }) { await provisionCatalog({ runtimeConfig, manifest, passwords: credentialToken.passwords }); },
    async commitCredentials({ credentialToken }) { return credentialTransaction.commit(credentialToken); },
    async activateCredentials({ committedToken }) { return credentialTransaction.activate(committedToken); },
    async rollbackCredentials({ committedToken, credentialToken }) { return credentialTransaction.rollback(committedToken ?? credentialToken); },
    async disposeCredentials(token) { return credentialTransaction.dispose(token); },
  };
  return createPostgresqlServiceCore(adapter).installOrRepair({ runtimeConfig });
}
