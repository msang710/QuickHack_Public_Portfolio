import fs from "node:fs";
import path from "node:path";
import {
  assertPackageFlavor,
  createPostgresqlPackageManifest,
} from "./package-flavor-contract.mjs";

export const SERVER_RUNTIME_CONFIG_SCHEMA_VERSION = 3;
export const SERVER_RUNTIME_CONFIG_FILE_NAME = "server-runtime.json";
export const SOURCE_SERVER_RUNTIME_CONFIG_RELATIVE_PATH = path.join(
  "config",
  "server-console.local.json"
);

const CONFIG_KEYS = new Set([
  "schemaVersion",
  "packageFlavor",
  "environment",
  "coupangWriteApiEnabled",
  "logenWriteApiEnabled",
  "dataDirectory",
  "backupRetentionCount",
  "database",
]);
const ENVIRONMENTS = new Set(["development", "production"]);
const DATABASE_KEYS = new Set([
  "host",
  "port",
  "name",
  "runtimeUser",
  "migratorUser",
]);
const DEMONSTRATION_DATABASE_KEYS = new Set([
  ...DATABASE_KEYS,
  "coupangMockName",
  "coupangMockUser",
  "logenMockName",
  "logenMockUser",
]);

export class ServerRuntimeConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ServerRuntimeConfigError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ServerRuntimeConfigError(code, message);
}

function isGitControlPath(controlPath) {
  try {
    const stat = fs.lstatSync(controlPath);
    return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile());
  } catch {
    return false;
  }
}

export function findQuickHackSourceRoot(startDirectory = process.cwd()) {
  let current = path.resolve(startDirectory);

  for (let depth = 0; depth < 10; depth += 1) {
    if (
      isGitControlPath(path.join(current, ".git")) &&
      fs.existsSync(path.join(current, "package.json"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return "";
}

export function sourceServerRuntimeConfigPath(sourceRoot) {
  return path.join(path.resolve(sourceRoot), SOURCE_SERVER_RUNTIME_CONFIG_RELATIVE_PATH);
}

export function operationalServerRuntimeConfigPath(configDirectory) {
  const normalized = String(configDirectory || "").trim();
  if (!normalized || !path.isAbsolute(normalized)) {
    fail(
      "SERVER_RUNTIME_CONFIG_DIRECTORY_REQUIRED",
      "An absolute operational server config directory is required."
    );
  }
  return path.join(path.resolve(normalized), SERVER_RUNTIME_CONFIG_FILE_NAME);
}

export function resolveServerRuntimeConfigLocation({
  startDirectory = process.cwd(),
  operationalConfigDirectory,
  argv = process.argv,
} = {}) {
  const argumentIndex = Array.isArray(argv)
    ? argv.indexOf("--runtime-config")
    : -1;
  if (argumentIndex >= 0) {
    const configuredPath = String(argv[argumentIndex + 1] || "").trim();
    if (!configuredPath) {
      fail(
        "SERVER_RUNTIME_CONFIG_ARGUMENT_INVALID",
        "--runtime-config 뒤에 설정 파일 경로가 필요합니다."
      );
    }
    return {
      kind: "operational",
      sourceRoot: "",
      configPath: path.resolve(configuredPath),
    };
  }

  const sourceRoot = findQuickHackSourceRoot(startDirectory);

  if (sourceRoot) {
    return {
      kind: "source",
      sourceRoot,
      configPath: sourceServerRuntimeConfigPath(sourceRoot),
    };
  }

  return {
    kind: "operational",
    sourceRoot: "",
    configPath: operationalServerRuntimeConfigPath(operationalConfigDirectory),
  };
}

export function defaultSourceServerRuntimeConfig(sourceRoot) {
  return {
    schemaVersion: SERVER_RUNTIME_CONFIG_SCHEMA_VERSION,
    packageFlavor: "DEMONSTRATION",
    environment: "development",
    coupangWriteApiEnabled: true,
    logenWriteApiEnabled: true,
    dataDirectory: path.join(path.resolve(sourceRoot), "database"),
    backupRetentionCount: 30,
    database: {
      host: "127.0.0.1",
      port: 5432,
      name: "quickhack",
      runtimeUser: "quickhack_runtime",
      migratorUser: "quickhack_migrator",
      coupangMockName: "quickhack_mock_coupang",
      coupangMockUser: "quickhack_mock_coupang",
      logenMockName: "quickhack_mock_logen",
      logenMockUser: "quickhack_mock_logen",
    },
  };
}

function databaseIdentifier(value, fieldName) {
  const normalized = String(value ?? "").trim();

  if (!/^[a-z][a-z0-9_]{0,62}$/.test(normalized)) {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      `서버 런타임 설정의 database.${fieldName} 값이 올바르지 않습니다.`
    );
  }

  return normalized;
}

function validateDatabaseConfig(value, packageFlavor) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "서버 런타임 설정의 database 값이 올바르지 않습니다."
    );
  }

  const allowedKeys =
    packageFlavor === "DEMONSTRATION"
      ? DEMONSTRATION_DATABASE_KEYS
      : DATABASE_KEYS;
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "서버 런타임 설정의 database에 지원하지 않는 항목이 있습니다."
    );
  }

  const host = String(value.host ?? "").trim().toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "QuickHack PostgreSQL host는 loopback 주소여야 합니다."
    );
  }

  const port = Number(value.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "QuickHack PostgreSQL port가 올바르지 않습니다."
    );
  }

  const normalized = {
    host,
    port,
    name: databaseIdentifier(value.name, "name"),
    runtimeUser: databaseIdentifier(value.runtimeUser, "runtimeUser"),
    migratorUser: databaseIdentifier(value.migratorUser, "migratorUser"),
  };
  if (packageFlavor === "DEMONSTRATION") {
    normalized.coupangMockName = databaseIdentifier(
      value.coupangMockName,
      "coupangMockName"
    );
    normalized.coupangMockUser = databaseIdentifier(
      value.coupangMockUser,
      "coupangMockUser"
    );
    normalized.logenMockName = databaseIdentifier(
      value.logenMockName,
      "logenMockName"
    );
    normalized.logenMockUser = databaseIdentifier(
      value.logenMockUser,
      "logenMockUser"
    );
  }
  return normalized;
}

function enumValue(value, allowed, fieldName) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (!allowed.has(normalized)) {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      `서버 런타임 설정의 ${fieldName} 값이 올바르지 않습니다.`
    );
  }

  return normalized;
}

export function validateServerRuntimeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SERVER_RUNTIME_CONFIG_INVALID", "서버 런타임 설정 형식이 올바르지 않습니다.");
  }

  const unknownKeys = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "서버 런타임 설정에 지원하지 않는 항목이 있습니다."
    );
  }

  if (value.schemaVersion !== SERVER_RUNTIME_CONFIG_SCHEMA_VERSION) {
    fail(
      "SERVER_RUNTIME_CONFIG_VERSION_UNSUPPORTED",
      "지원하지 않는 서버 런타임 설정 버전입니다."
    );
  }

  if (typeof value.coupangWriteApiEnabled !== "boolean") {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "서버 런타임 설정의 coupangWriteApiEnabled 값이 올바르지 않습니다."
    );
  }

  if (typeof value.logenWriteApiEnabled !== "boolean") {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "서버 런타임 설정의 logenWriteApiEnabled 값이 올바르지 않습니다."
    );
  }

  const dataDirectoryText = String(value.dataDirectory ?? "").trim();
  if (!dataDirectoryText || !path.isAbsolute(dataDirectoryText)) {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "서버 런타임 data directory는 절대 경로여야 합니다."
    );
  }

  const backupRetentionCount = Number(value.backupRetentionCount);
  if (!Number.isSafeInteger(backupRetentionCount) || backupRetentionCount <= 0) {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "서버 런타임 backup retention 값이 올바르지 않습니다."
    );
  }

  const packageFlavor = assertPackageFlavor(value.packageFlavor);
  const normalized = {
    schemaVersion: SERVER_RUNTIME_CONFIG_SCHEMA_VERSION,
    packageFlavor,
    environment: enumValue(value.environment, ENVIRONMENTS, "environment"),
    coupangWriteApiEnabled: value.coupangWriteApiEnabled,
    logenWriteApiEnabled: value.logenWriteApiEnabled,
    dataDirectory: path.normalize(path.resolve(dataDirectoryText)),
    backupRetentionCount,
    database: validateDatabaseConfig(value.database, packageFlavor),
  };
  createPostgresqlPackageManifest(normalized);
  return normalized;
}

export function readServerRuntimeConfigSync(options = {}) {
  const location = options.configPath
    ? {
        kind: options.kind || "operational",
        sourceRoot: options.sourceRoot || "",
        configPath: path.resolve(options.configPath),
      }
    : resolveServerRuntimeConfigLocation(options);

  let source;
  try {
    source = fs.readFileSync(location.configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && location.kind === "source") {
      return {
        config: defaultSourceServerRuntimeConfig(location.sourceRoot),
        location,
        persisted: false,
      };
    }

    fail(
      "SERVER_RUNTIME_CONFIG_MISSING",
      "운영 서버 런타임 설정을 찾을 수 없습니다. 설치 초기화를 다시 실행하세요."
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail(
      "SERVER_RUNTIME_CONFIG_INVALID",
      "서버 런타임 설정 JSON이 손상되었습니다."
    );
  }

  return {
    config: validateServerRuntimeConfig(parsed),
    location,
    persisted: true,
  };
}

export function writeServerRuntimeConfigAtomicSync(configPath, value) {
  const normalized = validateServerRuntimeConfig(value);
  const resolvedPath = path.resolve(configPath);
  const directory = path.dirname(resolvedPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.tmp`
  );

  fs.mkdirSync(directory, { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, resolvedPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {}
    throw error;
  }

  return normalized;
}
