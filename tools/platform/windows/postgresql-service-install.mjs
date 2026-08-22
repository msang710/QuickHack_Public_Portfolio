import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  postgresqlCredentialPath,
  protectedPostgresqlCredentialFile,
  resolvePostgresqlConnectionStringSync,
} from "../../../quickhack_server/core/database/postgresql-credential.mjs";
import {
  secureWindowsDirectoryAcl,
} from "../../../quickhack_server/security/windows-user-protected-secret.mjs";
import { getServerSecretProtector } from "../../../quickhack_server/platform/server-runtime.ts";
import {
  runPowerShellScript,
} from "../../../quickhack_server/security/async-powershell.mjs";
import { createChildProcessEnvironment } from "../../../quickhack_shared/core/child-process-environment.mjs";
import { createWindowsChildProcessPolicy } from "../../../quickhack_shared/platform/windows/child-process-policy.mjs";
import { readServerRuntimeConfigSync } from "../../../quickhack_shared/core/server-runtime-config.mjs";
import { createPostgresqlPackageManifest } from "../../../quickhack_shared/core/package-flavor-contract.mjs";
import {
  POSTGRESQL_MAJOR_VERSION,
  POSTGRESQL_TOOL_CAPABILITIES,
  assertPostgresqlToolVersions,
} from "../../../quickhack_shared/platform/native-runtime-contract.mjs";
import { createPostgresqlServiceCore } from "../../postgresql-service-core.mjs";
import {
  assertPostgresqlServiceOwnership,
  postgresqlServiceRegistrationPlan,
} from "./postgresql-service-ownership.mjs";

const { Pool } = pg;
export const QUICKHACK_POSTGRESQL_SERVICE_NAME = "QuickHackPostgreSQL";
const QUICKHACK_POSTGRESQL_SERVICE_NAMES = new Set([
  QUICKHACK_POSTGRESQL_SERVICE_NAME,
  "QuickHackDemoPostgreSQL",
  "QuickHackOperationalPostgreSQL",
]);
const POSTGRESQL_MAJOR = String(POSTGRESQL_MAJOR_VERSION);
const WINDOWS_SERVICE_QUERY_TIMEOUT_MS = 60_000;

function parseArguments(argv) {
  const values = {
    installDir: "",
    dataDir: "",
    runtimeConfig: "",
    serviceName: QUICKHACK_POSTGRESQL_SERVICE_NAME,
    serviceOwnership: "COMPATIBILITY",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--install-dir") values.installDir = argv[++index] || "";
    else if (argument === "--data-dir") values.dataDir = argv[++index] || "";
    else if (argument === "--runtime-config") values.runtimeConfig = argv[++index] || "";
    else if (argument === "--service-name") values.serviceName = argv[++index] || "";
    else if (argument === "--service-ownership") values.serviceOwnership = argv[++index] || "";
    else throw new Error(`Unsupported argument: ${argument}`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!value) throw new Error(`PostgreSQL service installation requires ${key}.`);
  }
  return {
    installDir: path.resolve(values.installDir),
    dataDir: path.resolve(values.dataDir),
    runtimeConfig: path.resolve(values.runtimeConfig),
    serviceName: values.serviceName,
    serviceOwnership: assertPostgresqlServiceOwnership(values.serviceOwnership),
  };
}

function assertServiceName(value) {
  const serviceName = String(value || QUICKHACK_POSTGRESQL_SERVICE_NAME).trim();
  if (!QUICKHACK_POSTGRESQL_SERVICE_NAMES.has(serviceName)) {
    throw new TypeError("Unsupported QuickHack PostgreSQL service identity.");
  }
  return serviceName;
}

function executable(binDirectory, name) {
  return path.join(binDirectory, process.platform === "win32" ? `${name}.exe` : name);
}

async function runExecutable(file, args, options = {}) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Required PostgreSQL executable was not found: ${path.basename(file)}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: createChildProcessEnvironment({
        policy: createWindowsChildProcessPolicy(process.env),
        source: process.env,
        executableDirectories: [path.dirname(file)],
      }),
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(file)} failed: ${stderr.slice(-3000)}`));
    });
  });
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Unsafe PostgreSQL identifier in runtime configuration.");
  }
  return `"${value}"`;
}

async function writeCredential(role, dataDir, password) {
  const secretProtector = getServerSecretProtector();
  const credentialPath = postgresqlCredentialPath(role, dataDir);
  const directory = path.dirname(credentialPath);
  await secretProtector.ensureDirectory(directory);
  const passwordPayload = Buffer.from(password, "utf8");
  let payload;
  const temporaryPath = path.join(
    directory,
    `.${path.basename(credentialPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    payload = await protectedPostgresqlCredentialFile(
      passwordPayload,
      secretProtector
    );
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temporaryPath, credentialPath);
  } finally {
    passwordPayload.fill(0);
    payload?.fill(0);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function generatedPassword() {
  return randomBytes(32).toString("base64url");
}

async function assertPostgresqlMajor(binDirectory) {
  const observedVersions = {};
  for (const tool of POSTGRESQL_TOOL_CAPABILITIES.service) {
    const result = await runExecutable(executable(binDirectory, tool), ["--version"]);
    observedVersions[tool] = `${result.stdout}\n${result.stderr}`.trim();
  }
  return assertPostgresqlToolVersions(observedVersions, { capability: "service" });
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      reject(new Error(`PostgreSQL port ${port} is already in use.`));
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

async function securePostgresqlClusterDirectory(clusterDirectory) {
  await secureWindowsDirectoryAcl(clusterDirectory, {
    includeNetworkService: true,
  });
}

function initializationFailure(code, cause) {
  const error = new Error("QuickHack PostgreSQL initialization substep did not complete.", {
    cause,
  });
  error.code = code;
  return error;
}

async function initializationStep(code, operation) {
  try {
    return await operation();
  } catch (error) {
    throw initializationFailure(code, error);
  }
}

function initdbFailureCode(error) {
  const source = String(error?.message ?? "");
  if (/File exists/iu.test(source)) {
    return "POSTGRESQL_INITIALIZE_INITDB_TARGET_EXISTS_FAILED";
  }
  if (/(?:Access is denied|Permission denied)/iu.test(source)) {
    return "POSTGRESQL_INITIALIZE_INITDB_ACCESS_FAILED";
  }
  return "POSTGRESQL_INITIALIZE_INITDB_PROCESS_FAILED";
}

async function initializeCluster({ binDirectory, clusterDirectory, operatorPassword }) {
  await initializationStep(
    "POSTGRESQL_INITIALIZE_PARENT_ACL_FAILED",
    () => securePostgresqlClusterDirectory(path.dirname(clusterDirectory))
  );
  const stagingDirectory = await fs.lstat(clusterDirectory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stagingDirectory) {
    throw initializationFailure(
      "POSTGRESQL_INITIALIZE_STAGING_EXISTS_FAILED",
      new Error("The PostgreSQL initialization staging directory already exists.")
    );
  }
  const pipeName = `\\\\.\\pipe\\quickhack-initdb-${process.pid}-${randomUUID()}`;
  let delivered = false;
  const passwordPipe = net.createServer((socket) => {
    socket.on("error", () => undefined);
    if (delivered) {
      socket.destroy();
      return;
    }
    delivered = true;
    socket.write(operatorPassword, "utf8");
    socket.end("\n", "utf8");
  });
  await new Promise((resolve, reject) => {
    passwordPipe.once("error", reject);
    passwordPipe.listen(pipeName, () => {
      resolve();
    });
  });
  try {
    try {
      await runExecutable(executable(binDirectory, "initdb"), [
        "--pgdata", clusterDirectory,
        "--username", "quickhack_operator",
        "--pwfile", pipeName,
        "--auth-host", "scram-sha-256",
        "--auth-local", "scram-sha-256",
        "--encoding", "UTF8",
        "--locale", "C",
      ]);
    } catch (error) {
      throw initializationFailure(initdbFailureCode(error), error);
    }
    if (!delivered) throw new Error("PostgreSQL initdb did not consume its protected bootstrap input.");
    await initializationStep(
      "POSTGRESQL_INITIALIZE_TARGET_ACL_FAILED",
      () => securePostgresqlClusterDirectory(clusterDirectory)
    );
  } finally {
    await new Promise((resolve) => passwordPipe.close(resolve));
  }
}

async function writeTextFileAtomic(filePath, source) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const payload = Buffer.from(source, "utf8");
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } finally {
    payload.fill(0);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function ensureManagedPostgresqlConfiguration(clusterDirectory, port) {
  const mainPath = path.join(clusterDirectory, "postgresql.conf");
  const managedFileName = "quickhack-managed.conf";
  const managedPath = path.join(clusterDirectory, managedFileName);
  const managedSource = [
    `# QuickHack managed PostgreSQL ${POSTGRESQL_MAJOR} boundary. Installer-owned.`,
    "listen_addresses = '127.0.0.1'",
    `port = ${port}`,
    "password_encryption = 'scram-sha-256'",
    "ssl = off",
    "logging_collector = on",
    "log_connections = on",
    "log_disconnections = on",
    "",
  ].join("\n");
  await writeTextFileAtomic(managedPath, managedSource);
  const mainSource = await fs.readFile(mainPath, "utf8");
  const withoutManagedIncludes = mainSource
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*include(?:_if_exists)?\s*=\s*['\"]quickhack-managed\.conf['\"]\s*(?:#.*)?$/i.test(
          line
        )
    )
    .join("\n")
    .replace(/\s*$/, "");
  await writeTextFileAtomic(
    mainPath,
    `${withoutManagedIncludes}\n\ninclude = '${managedFileName}'\n`
  );
}

async function ensureServiceRegistered(binDirectory, clusterDirectory, serviceName) {
  const encodedPath = Buffer.from(clusterDirectory, "utf8").toString("base64");
  const state = await runPowerShellScript(
    "$ErrorActionPreference='Stop'; " +
      "$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())); " +
      `$service=Get-CimInstance Win32_Service -Filter \"Name='${serviceName}'\" -ErrorAction SilentlyContinue; ` +
      "if($null -eq $service){'MISSING'}elseif($service.PathName.IndexOf($path,[StringComparison]::OrdinalIgnoreCase) -ge 0){'MATCH'}else{'MISMATCH'}",
    {
      inputLine: encodedPath,
      timeoutMs: WINDOWS_SERVICE_QUERY_TIMEOUT_MS,
      timeoutAttempts: 2,
      maxOutputBytes: 64 * 1024,
    }
  );
  if (state === "MISMATCH") {
    throw new Error("The QuickHack PostgreSQL service points to another data directory.");
  }
  if (state === "MATCH") return;
  await runExecutable(executable(binDirectory, "pg_ctl"), [
    "register",
    "-N", serviceName,
    "-D", clusterDirectory,
    "-S", "auto",
    "-U", "NT AUTHORITY\\NetworkService",
  ]);
}

async function ensurePackagedServiceRegistered(plan) {
  const encodedPath = Buffer.from(plan.expectedHostPath, "utf8").toString("base64");
  const state = await runPowerShellScript(
    "$ErrorActionPreference='Stop'; " +
      "$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())); " +
      `$service=Get-CimInstance Win32_Service -Filter \"Name='${plan.serviceName}'\" -ErrorAction SilentlyContinue; ` +
      "if($null -eq $service){'MISSING'}elseif($service.PathName.IndexOf($path,[StringComparison]::OrdinalIgnoreCase) -ge 0){'MATCH'}else{'MISMATCH'}",
    {
      inputLine: encodedPath,
      timeoutMs: WINDOWS_SERVICE_QUERY_TIMEOUT_MS,
      timeoutAttempts: 2,
      maxOutputBytes: 64 * 1024,
    }
  );
  if (state === "MISSING") {
    const error = new Error("The package-owned QuickHack PostgreSQL service is missing.");
    error.code = "PACKAGED_POSTGRESQL_SERVICE_MISSING";
    throw error;
  }
  if (state !== "MATCH") {
    const error = new Error("The QuickHack PostgreSQL service is not owned by the current package.");
    error.code = "PACKAGED_POSTGRESQL_SERVICE_MISMATCH";
    throw error;
  }
}

async function publishPostgresqlReadinessMarker(markerPath) {
  const directory = path.dirname(markerPath);
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile("QUICKHACK_POSTGRES_CLUSTER_READY_V1\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, markerPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function postgresqlServiceControlStep(code, operation) {
  try {
    return await operation();
  } catch {
    const error = new Error("QuickHack PostgreSQL service control did not complete.");
    error.code = code;
    throw error;
  }
}

async function ensureServiceStarted(serviceName) {
  const initialStatus = await postgresqlServiceControlStep(
    "POSTGRESQL_START_SERVICE_QUERY_FAILED",
    () => runPowerShellScript(
      "$ErrorActionPreference='Stop'; " +
        `(Get-Service -Name '${serviceName}' -ErrorAction Stop).Status.ToString()`,
      { timeoutMs: WINDOWS_SERVICE_QUERY_TIMEOUT_MS, maxOutputBytes: 64 * 1024 }
    )
  );
  if (initialStatus === "Running") {
    await postgresqlServiceControlStep(
      "POSTGRESQL_START_SERVICE_STOP_COMMAND_FAILED",
      () => runPowerShellScript(
        "$ErrorActionPreference='Stop'; " +
          `Stop-Service -Name '${serviceName}' -Force -ErrorAction Stop; 'STOP_REQUESTED'`,
        { timeoutMs: WINDOWS_SERVICE_QUERY_TIMEOUT_MS, maxOutputBytes: 64 * 1024 }
      )
    );
    await postgresqlServiceControlStep(
      "POSTGRESQL_START_SERVICE_WAIT_STOPPED_FAILED",
      () => runPowerShellScript(
        "$ErrorActionPreference='Stop'; " +
          `$service=Get-Service -Name '${serviceName}' -ErrorAction Stop; ` +
          "$service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(60)); " +
          "$service.Refresh(); " +
          "if($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped){throw 'STOP_POSTCONDITION_FAILED'}; 'STOPPED'",
        { timeoutMs: 70_000, maxOutputBytes: 64 * 1024 }
      )
    );
  }
  await postgresqlServiceControlStep(
    "POSTGRESQL_START_SERVICE_START_COMMAND_FAILED",
    () => runPowerShellScript(
      "$ErrorActionPreference='Stop'; " +
        `Start-Service -Name '${serviceName}' -ErrorAction Stop; 'START_REQUESTED'`,
      { timeoutMs: WINDOWS_SERVICE_QUERY_TIMEOUT_MS, maxOutputBytes: 64 * 1024 }
    )
  );
  await postgresqlServiceControlStep(
    "POSTGRESQL_START_SERVICE_WAIT_RUNNING_FAILED",
    () => runPowerShellScript(
      "$ErrorActionPreference='Stop'; " +
        `$service=Get-Service -Name '${serviceName}' -ErrorAction Stop; ` +
        "$service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(60)); " +
        "$service.Refresh(); " +
        "if($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running){throw 'RUNNING_POSTCONDITION_FAILED'}; 'RUNNING'",
      { timeoutMs: 70_000, maxOutputBytes: 64 * 1024 }
    )
  );
  await postgresqlServiceControlStep(
    "POSTGRESQL_START_SERVICE_POSTCONDITION_FAILED",
    async () => {
      const source = await runPowerShellScript(
        "$ErrorActionPreference='Stop'; " +
          "$deadline=[DateTime]::UtcNow.AddSeconds(60); " +
          "do{ " +
          `$service=Get-CimInstance Win32_Service -Filter "Name='${serviceName}'" -ErrorAction Stop; ` +
          "if($service.State -eq 'Running' -and [int]$service.ProcessId -gt 0 -and [int]$service.ExitCode -eq 0){ " +
          "[pscustomobject]@{state=[string]$service.State;processId=[int]$service.ProcessId;exitCode=[int]$service.ExitCode}|ConvertTo-Json -Compress; exit 0 }; " +
          "Start-Sleep -Milliseconds 250 " +
          "}while([DateTime]::UtcNow -lt $deadline); " +
          "throw 'SERVICE_POSTCONDITION_TIMEOUT'",
        { timeoutMs: 70_000, maxOutputBytes: 64 * 1024 }
      );
      const observed = JSON.parse(source);
      if (
        observed?.state !== "Running" ||
        !Number.isSafeInteger(observed?.processId) ||
        observed.processId < 1 ||
        observed?.exitCode !== 0
      ) {
        throw new Error("QuickHack PostgreSQL service start postcondition failed.");
      }
    }
  );
}

async function roleExists(client, roleName) {
  const result = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
  return result.rowCount === 1;
}

async function databaseExists(client, databaseName) {
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
  return result.rowCount === 1;
}

async function provisionRolesAndDatabases({ connectionString, config, passwords }) {
  const pool = new Pool({
    connectionString,
    application_name: "quickhack-postgresql-provisioning",
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  const client = await pool.connect();
  const manifest = createPostgresqlPackageManifest(config);
  try {
    const settings = await client.query(`
      SELECT
        current_setting('listen_addresses') AS listen_addresses,
        current_setting('port') AS port,
        current_setting('password_encryption') AS password_encryption,
        current_setting('ssl') AS ssl
    `);
    const row = settings.rows[0] ?? {};
    const actual = [
      String(row.listen_addresses ?? ""),
      String(row.port ?? ""),
      String(row.password_encryption ?? ""),
      String(row.ssl ?? ""),
    ];
    if (
      actual[0] !== "127.0.0.1" ||
      actual[1] !== String(config.database.port) ||
      actual[2] !== "scram-sha-256" ||
      actual[3] !== "off"
    ) {
      throw new Error("The running PostgreSQL service does not match the QuickHack security configuration.");
    }
    if (manifest.flavor === "OPERATIONAL") {
      const forbidden = await client.query(`
        SELECT 'database' AS kind, datname AS name
        FROM pg_database
        WHERE datname LIKE 'quickhack_mock_%'
        UNION ALL
        SELECT 'role' AS kind, rolname AS name
        FROM pg_roles
        WHERE rolname LIKE 'quickhack_mock_%'
        ORDER BY kind, name
      `);
      if (forbidden.rowCount > 0) {
        throw new Error(
          "Operational package installation stopped because demonstration PostgreSQL catalogs require operator review."
        );
      }
    }
    for (const role of manifest.roles.filter((item) => item.kind !== "operator")) {
      const roleName = role.user;
      const password = passwords[role.kind];
      if (!/^[A-Za-z0-9_-]{43}$/.test(password)) {
        throw new Error(`The stored password for ${roleName} is invalid.`);
      }
      if (!(await roleExists(client, roleName))) {
        await client.query(
          `CREATE ROLE ${quoteIdentifier(roleName)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`
        );
      } else {
        await client.query(
          `ALTER ROLE ${quoteIdentifier(roleName)} WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`
        );
      }
    }
    for (const database of manifest.databases) {
      const databaseName = database.name;
      const owner = manifest.roles.find(
        (role) => role.kind === database.ownerRole
      )?.user;
      if (!owner) throw new Error("The PostgreSQL database owner manifest is invalid.");
      if (!(await databaseExists(client, databaseName))) {
        await client.query(
          `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(owner)} TEMPLATE template0 ENCODING 'UTF8'`
        );
      } else {
        await client.query(
          `ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO ${quoteIdentifier(owner)}`
        );
      }
    }
    const allLoginRoles = manifest.roles.map((role) => quoteIdentifier(role.user));
    for (const database of manifest.databases) {
      await client.query(
        `REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE ${quoteIdentifier(database.name)} FROM PUBLIC, ${allLoginRoles.join(", ")}`
      );
    }
    const mainDatabase = manifest.databases.find((database) => database.kind === "main");
    const runtimeRole = manifest.roles.find((role) => role.kind === "runtime");
    const backupRole = manifest.roles.find((role) => role.kind === "backup");
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(mainDatabase.name)} TO ${quoteIdentifier(runtimeRole.user)}, ${quoteIdentifier(backupRole.user)}`
    );
    for (const database of manifest.databases.filter(
      (item) => item.kind !== "main"
    )) {
      const owner = manifest.roles.find(
        (role) => role.kind === database.ownerRole
      );
      await client.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database.name)} TO ${quoteIdentifier(owner.user)}`
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}

function passwordFromConnectionString(connectionString) {
  const password = decodeURIComponent(new URL(connectionString).password);
  if (!/^[A-Za-z0-9_-]{43}$/.test(password)) {
    throw new Error("A stored QuickHack PostgreSQL role password is invalid.");
  }
  return password;
}

function credentialExists(role, dataDir) {
  return fs.lstat(postgresqlCredentialPath(role, dataDir))
    .then((stat) => stat.isFile() && !stat.isSymbolicLink())
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
}

async function loadOrCreateRolePasswords(dataDir, config, runtimeConfigPath) {
  const passwords = {};
  const manifest = createPostgresqlPackageManifest(config);
  for (const role of manifest.roles.map((item) => item.kind)) {
    if (await credentialExists(role, dataDir)) {
      passwords[role] = passwordFromConnectionString(
        resolvePostgresqlConnectionStringSync({
          role,
          applicationName: "quickhack-postgresql-install-repair",
          runtimeConfigPath,
        })
      );
    } else {
      passwords[role] = generatedPassword();
      await writeCredential(role, dataDir, passwords[role]);
    }
  }
  return passwords;
}

export async function installPostgresqlService(input) {
  if (process.platform !== "win32") {
    throw new Error("QuickHack Windows PostgreSQL service installation is Windows-only.");
  }
  const config = readServerRuntimeConfigSync({
    configPath: input.runtimeConfig,
    kind: "operational",
  }).config;
  const serviceName = assertServiceName(input.serviceName);
  const serviceOwnership = assertPostgresqlServiceOwnership(input.serviceOwnership);
  const adapter = {
    async inspect(context) {
      const binDirectory = path.join(context.installDir, "runtime", "postgresql", "bin");
      const clusterDirectory = path.join(
        context.dataDir,
        "postgresql",
        POSTGRESQL_MAJOR,
        "data"
      );
      const existingVersion = String(
        await fs.readFile(path.join(clusterDirectory, "PG_VERSION"), "utf8").catch(() => "")
      ).trim();
      if (existingVersion && existingVersion !== POSTGRESQL_MAJOR) {
        throw new Error(`Unsupported PostgreSQL data directory version: ${existingVersion}`);
      }
      return {
        fresh: !existingVersion,
        existingVersion,
        binDirectory,
        clusterDirectory,
        clusterParent: path.dirname(clusterDirectory),
        serviceName,
        serviceOwnership,
      };
    },
    async validateToolchain({ observed }) {
      await assertPostgresqlMajor(observed.binDirectory);
    },
    async assertPortAvailable({ runtimeConfig }) {
      await assertPortAvailable(runtimeConfig.database.port);
    },
    async prepareCredentials(context) {
      await securePostgresqlClusterDirectory(context.observed.clusterParent);
      return {
        state: "WINDOWS_COMPATIBILITY_PREPARED",
        passwords: await loadOrCreateRolePasswords(
          context.dataDir,
          context.runtimeConfig,
          context.runtimeConfigPath
        ),
      };
    },
    async initializeCluster({ observed, credentialToken }) {
      const existingCluster = await fs.lstat(observed.clusterDirectory).catch(() => null);
      if (existingCluster) {
        const entries = existingCluster.isDirectory()
          ? await fs.readdir(observed.clusterDirectory)
          : ["not-a-directory"];
        if (entries.length !== 0) {
          throw new Error("The PostgreSQL data directory is incomplete and requires operator review.");
        }
        await fs.rmdir(observed.clusterDirectory);
      }
      const stagingCluster = path.join(
        observed.clusterParent,
        `.data.initializing.${process.pid}.${randomUUID()}`
      );
      try {
        await initializeCluster({
          binDirectory: observed.binDirectory,
          clusterDirectory: stagingCluster,
          operatorPassword: credentialToken.passwords.operator,
        });
        await initializationStep(
          "POSTGRESQL_INITIALIZE_ATOMIC_RENAME_FAILED",
          () => fs.rename(stagingCluster, observed.clusterDirectory)
        );
      } finally {
        await fs.rm(stagingCluster, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    async configureCluster({ observed, runtimeConfig }) {
      await securePostgresqlClusterDirectory(observed.clusterDirectory);
      await ensureManagedPostgresqlConfiguration(
        observed.clusterDirectory,
        runtimeConfig.database.port
      );
    },
    async registerService(context) {
      const plan = postgresqlServiceRegistrationPlan({
        serviceOwnership: context.observed.serviceOwnership,
        serviceName: context.observed.serviceName,
        installDir: context.installDir,
        dataDir: context.dataDir,
      });
      if (plan.ownership === "PACKAGED") {
        await ensurePackagedServiceRegistered(plan);
        await publishPostgresqlReadinessMarker(plan.readinessMarkerPath);
      } else {
        await ensureServiceRegistered(
          context.observed.binDirectory,
          context.observed.clusterDirectory,
          context.observed.serviceName
        );
      }
    },
    async startService({ observed }) {
      await ensureServiceStarted(observed.serviceName);
    },
    async provisionCatalog(context) {
      const operatorConnectionString = resolvePostgresqlConnectionStringSync({
        role: "operator",
        applicationName: "quickhack-postgresql-provisioning",
        runtimeConfigPath: context.runtimeConfigPath,
      });
      await provisionRolesAndDatabases({
        connectionString: operatorConnectionString,
        config: context.runtimeConfig,
        passwords: context.credentialToken.passwords,
      });
    },
    async commitCredentials({ credentialToken }) {
      return { state: "WINDOWS_COMPATIBILITY_ACTIVE", credentialToken };
    },
    async rollbackCredentials() {},
    async disposeCredentials(credentialToken) {
      for (const key of Object.keys(credentialToken.passwords ?? {})) {
        credentialToken.passwords[key] = "";
      }
    },
  };
  return createPostgresqlServiceCore(adapter).installOrRepair({
    installDir: input.installDir,
    dataDir: input.dataDir,
    runtimeConfig: config,
    runtimeConfigPath: input.runtimeConfig,
  });
}

function isMainModule() {
  return path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const result = await installPostgresqlService(parseArguments(process.argv.slice(2)));
    console.log(`QuickHack PostgreSQL service ready: ${result.serviceName}`);
  } catch (error) {
    console.error(
      `QuickHack PostgreSQL service setup failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
