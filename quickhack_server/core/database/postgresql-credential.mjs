import fs from "node:fs";
import path from "node:path";
import {
  createServerRuntimeConfigService,
  getServerSecretProtector,
  serverRuntimeConfigService,
} from "../../platform/server-runtime.ts";
import { readServerRuntimeConfigSync } from "../../../quickhack_shared/core/server-runtime-config.mjs";
import { createPostgresqlPackageManifest } from "../../../quickhack_shared/core/package-flavor-contract.mjs";
import { serverSecretFilePrefix } from "../../platform/server-secret-file-format.mjs";
import { serverSecretIdentity } from "../../platform/server-secret-identity.mjs";

const FILE_MAX_BYTES = 16 * 1024;
export const POSTGRESQL_ROLE_FILES = Object.freeze({
  runtime: "postgresql-runtime.credential",
  migrator: "postgresql-migrator.credential",
  backup: "postgresql-backup.credential",
  operator: "postgresql-operator.credential",
  coupangMock: "postgresql-mock-coupang.credential",
  logenMock: "postgresql-mock-logen.credential",
});
const TEST_URLS = Object.freeze({
  runtime: "QUICKHACK_TEST_DATABASE_URL",
  migrator: "QUICKHACK_TEST_MIGRATOR_DATABASE_URL",
  backup: "QUICKHACK_TEST_BACKUP_DATABASE_URL",
  operator: "QUICKHACK_TEST_ADMIN_DATABASE_URL",
  coupangMock: "QUICKHACK_TEST_COUPANG_MOCK_DATABASE_URL",
  logenMock: "QUICKHACK_TEST_LOGEN_MOCK_DATABASE_URL",
});

export class PostgresqlCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PostgresqlCredentialError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PostgresqlCredentialError(code, message);
}

function roleConfig(role, runtime) {
  let manifest;
  try {
    manifest = createPostgresqlPackageManifest(runtime.serverConfig);
  } catch {
    fail(
      "POSTGRESQL_PACKAGE_MANIFEST_INVALID",
      "The PostgreSQL package credential manifest is invalid."
    );
  }
  const entry = manifest.roles.find((candidate) => candidate.kind === role);
  if (!entry) {
    fail(
      "POSTGRESQL_ROLE_FLAVOR_MISMATCH",
      "The requested PostgreSQL role is not available in this package flavor."
    );
  }
  return { user: entry.user, database: entry.database };
}

function strictProtectedPayload(source, prefix) {
  if (!source.startsWith(prefix) || !source.endsWith("\n")) {
    fail(
      "POSTGRESQL_CREDENTIAL_INVALID",
      "PostgreSQL 서버 자격증명 파일 형식이 올바르지 않습니다."
    );
  }
  const encoded = source.slice(prefix.length, -1);
  if (
    !encoded ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded
    )
  ) {
    fail(
      "POSTGRESQL_CREDENTIAL_INVALID",
      "PostgreSQL 서버 자격증명 payload가 올바르지 않습니다."
    );
  }
  const payload = Buffer.from(encoded, "base64");
  if (payload.toString("base64") !== encoded) {
    payload.fill(0);
    fail(
      "POSTGRESQL_CREDENTIAL_INVALID",
      "PostgreSQL 서버 자격증명 payload가 canonical base64가 아닙니다."
    );
  }
  return payload;
}

function unprotectSync(payload, secretProtector) {
  if (secretProtector.descriptor.state !== "READY") {
    fail(
      "POSTGRESQL_CREDENTIAL_PLATFORM_UNSUPPORTED",
      "PostgreSQL 서버 자격증명 보호 기능을 이 플랫폼에서 사용할 수 없습니다."
    );
  }
  let password;
  try {
    password = secretProtector.unprotectSync(
      "POSTGRESQL_CREDENTIAL",
      payload
    );
  } catch {
    fail(
      "POSTGRESQL_CREDENTIAL_UNAVAILABLE",
      "PostgreSQL 서버 자격증명을 현재 Windows 계정으로 열 수 없습니다."
    );
  }
  if (!Buffer.isBuffer(password) || password.length === 0) {
    if (Buffer.isBuffer(password)) password.fill(0);
    fail(
      "POSTGRESQL_CREDENTIAL_INVALID",
      "복호화된 PostgreSQL 서버 자격증명이 올바르지 않습니다."
    );
  }
  return password;
}

export function postgresqlCredentialPath(role, dataDir) {
  const fileName = POSTGRESQL_ROLE_FILES[role];
  if (!fileName) {
    fail("POSTGRESQL_ROLE_INVALID", "지원하지 않는 PostgreSQL 연결 역할입니다.");
  }
  return path.join(path.resolve(dataDir), "security", fileName);
}

function testConnectionString(role, env) {
  if (String(env.NODE_ENV ?? "") !== "test") return "";
  const configured = String(env[TEST_URLS[role]] ?? "").trim();
  if (configured) return configured;
  if (role === "backup") {
    return String(env.QUICKHACK_TEST_DATABASE_URL ?? "").trim();
  }
  return "";
}

function connectionString(config, password, applicationName) {
  const user = encodeURIComponent(config.user);
  const passwordText = encodeURIComponent(password.toString("utf8"));
  const database = encodeURIComponent(config.database);
  const app = encodeURIComponent(applicationName);
  return `postgresql://${user}:${passwordText}@${config.host}:${config.port}/${database}?application_name=${app}`;
}

export function resolvePostgresqlConnectionStringSync({
  role = "runtime",
  applicationName = "quickhack",
  env = process.env,
  allowSchemaOnlyFallback = false,
  runtimeConfigPath = "",
  secretProtector = getServerSecretProtector(),
} = {}) {
  const configuredTestUrl = testConnectionString(role, env);
  if (
    configuredTestUrl &&
    role !== "coupangMock" &&
    role !== "logenMock"
  ) {
    return configuredTestUrl;
  }
  const runtime = runtimeConfigPath
    ? createServerRuntimeConfigService(() =>
        readServerRuntimeConfigSync({
          configPath: runtimeConfigPath,
          kind: "operational",
        })
      ).read(env)
    : serverRuntimeConfigService.read(env);
  if (!runtime.database.accessible || !("postgresql" in runtime.database)) {
    fail(
      "POSTGRESQL_CLIENT_ACCESS_FORBIDDEN",
      "클라이언트 런타임에서는 PostgreSQL 자격증명에 접근할 수 없습니다."
    );
  }
  const roleValues = roleConfig(role, runtime);
  const identity = serverSecretIdentity({
    kind: "POSTGRESQL_CREDENTIAL",
    runtimeConfig: runtime.serverConfig,
    postgresqlRole: role,
  });
  const values = {
    ...roleValues,
    host: runtime.database.postgresql.host,
    port: runtime.database.postgresql.port,
  };
  if (configuredTestUrl) return configuredTestUrl;

  if (secretProtector.metadata.lifecycle === "ACTIVATION_CREDENTIAL") {
    let password;
    try {
      password = secretProtector.readProvisionedSync(identity);
      return connectionString(values, password, applicationName);
    } catch (error) {
      if (error instanceof PostgresqlCredentialError) throw error;
      fail(
        error?.code === "SERVER_SECRET_PROVISIONING_REQUIRED"
          ? "POSTGRESQL_CREDENTIAL_PROVISIONING_REQUIRED"
          : "POSTGRESQL_CREDENTIAL_UNAVAILABLE",
        "The PostgreSQL activation credential is unavailable."
      );
    } finally {
      password?.fill(0);
    }
  }
  const credentialPath = postgresqlCredentialPath(role, runtime.paths.dataDir);

  let source;
  try {
    const stat = fs.lstatSync(credentialPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_MAX_BYTES) {
      fail(
        "POSTGRESQL_CREDENTIAL_INVALID",
        "PostgreSQL 서버 자격증명 경로가 안전한 일반 파일이 아닙니다."
      );
    }
    source = fs.readFileSync(credentialPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && allowSchemaOnlyFallback) {
      return connectionString(
        values,
        Buffer.from("schema-only-invalid"),
        applicationName
      );
    }
    if (error instanceof PostgresqlCredentialError) throw error;
    fail(
      "POSTGRESQL_CREDENTIAL_MISSING",
      "PostgreSQL 서버 자격증명이 준비되지 않아 서버를 시작할 수 없습니다."
    );
  }

  let protectedPayload;
  let password;
  try {
    protectedPayload = strictProtectedPayload(
      source,
      serverSecretFilePrefix("POSTGRESQL_CREDENTIAL", secretProtector.metadata)
    );
    password = unprotectSync(protectedPayload, secretProtector);
    return connectionString(values, password, applicationName);
  } finally {
    protectedPayload?.fill(0);
    password?.fill(0);
  }
}

export function protectedPostgresqlCredentialFile(
  password,
  secretProtector = getServerSecretProtector()
) {
  if (!Buffer.isBuffer(password) || password.length === 0) {
    fail(
      "POSTGRESQL_CREDENTIAL_INVALID",
      "보호할 PostgreSQL password가 올바르지 않습니다."
    );
  }
  if (!secretProtector || typeof secretProtector.protect !== "function") {
    fail(
      "POSTGRESQL_CREDENTIAL_INVALID",
      "PostgreSQL password 보호 함수가 필요합니다."
    );
  }
  if (secretProtector.metadata.lifecycle !== "OPAQUE_PAYLOAD") {
    fail(
      "POSTGRESQL_CREDENTIAL_PRIVILEGED_PROVISIONING_REQUIRED",
      "PostgreSQL activation credentials must be provisioned by the privileged operator."
    );
  }
  return Promise.resolve(
    secretProtector.protect("POSTGRESQL_CREDENTIAL", password)
  ).then((payload) => {
    try {
      if (!Buffer.isBuffer(payload) || payload.length === 0) {
        fail(
          "POSTGRESQL_CREDENTIAL_INVALID",
          "PostgreSQL password 보호 결과가 올바르지 않습니다."
        );
      }
      return Buffer.from(
        `${serverSecretFilePrefix("POSTGRESQL_CREDENTIAL", secretProtector.metadata)}${payload.toString("base64")}\n`,
        "utf8"
      );
    } finally {
      if (Buffer.isBuffer(payload)) payload.fill(0);
    }
  });
}
