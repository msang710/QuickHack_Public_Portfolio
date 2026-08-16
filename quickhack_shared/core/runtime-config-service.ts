import { OFFICIAL_LIVE_API_HOSTS } from "./external-api-destination-policy.ts";
import type {
  ServerRuntimeConfig,
  ServerRuntimeConfigLocation,
} from "./server-runtime-config.mjs";
import type { RuntimeDirectorySnapshot } from "../platform/runtime-directory-contract.mjs";

export const RUNTIME_ROLES = ["single", "server", "client"] as const;
export const QUICKHACK_ENVIRONMENTS = ["development", "production"] as const;
export const QUICKHACK_DATABASE_PROVIDERS = ["postgresql"] as const;

export type RuntimeRole = (typeof RUNTIME_ROLES)[number];
export type QuickHackEnvironment = (typeof QUICKHACK_ENVIRONMENTS)[number];
export type QuickHackDatabaseProvider =
  (typeof QUICKHACK_DATABASE_PROVIDERS)[number];

const DEFAULT_COUPANG_MOCK_SERVER_URL = "http://127.0.0.1:3100";
const DEFAULT_LOGEN_MOCK_SERVER_URL = "http://127.0.0.1:3200";

type RuntimeEnvironment = NodeJS.ProcessEnv;
type ServerConfigReadResult = {
  config: ServerRuntimeConfig;
  location: ServerRuntimeConfigLocation;
  persisted: boolean;
};
type RuntimeDirectoryResolutionInput = {
  role: "server" | "client";
  appRoot: string;
  runtimeDir?: string;
  dataDirectory?: string;
  environment: RuntimeEnvironment;
  deployment: "development" | "system-service";
  artifactKind?:
    | "DEMONSTRATION_SERVER"
    | "DEMONSTRATION_CLIENT"
    | "OPERATIONAL_SERVER"
    | "OPERATIONAL_CLIENT";
};

function envText(env: RuntimeEnvironment, name: string) {
  return String(env[name] || "").trim();
}

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

function clientRuntime(env: RuntimeEnvironment) {
  return envText(env, "QUICKHACK_RUNTIME_ROLE").toLowerCase() === "client";
}

function clientEnvironment(env: RuntimeEnvironment): QuickHackEnvironment {
  return envText(env, "NODE_ENV") === "production" ? "production" : "development";
}

export class RuntimeConfigService {
  private readonly readServerConfig: () => ServerConfigReadResult;
  private readonly resolveRuntimeDirectories: (
    input: RuntimeDirectoryResolutionInput
  ) => RuntimeDirectorySnapshot;

  constructor(options: {
    readServerConfig: () => ServerConfigReadResult;
    resolveRuntimeDirectories: (
      input: RuntimeDirectoryResolutionInput
    ) => RuntimeDirectorySnapshot;
  }) {
    if (typeof options?.readServerConfig !== "function") {
      throw new TypeError("RuntimeConfigService requires a server config reader.");
    }
    if (typeof options.resolveRuntimeDirectories !== "function") {
      throw new TypeError("RuntimeConfigService requires a runtime directory resolver.");
    }
    this.readServerConfig = options.readServerConfig;
    this.resolveRuntimeDirectories = options.resolveRuntimeDirectories;
  }

  read(env: RuntimeEnvironment = process.env) {
    if (clientRuntime(env)) {
      const appRoot =
        envText(env, "QUICKHACK_APP_ROOT") ||
        /* turbopackIgnore: true */ process.cwd();
      const paths = this.resolveRuntimeDirectories({
        role: "client",
        appRoot,
        runtimeDir: envText(env, "QUICKHACK_RUNTIME_DIR") || undefined,
        environment: env,
        deployment: "development",
      });
      const environment = clientEnvironment(env);
      return {
        environment,
        production: environment === "production",
        role: "client" as const,
        policies: {
          coupangWriteApiEnabled: false,
          logenWriteApiEnabled: false,
        },
        endpoints: {
          remoteServerUrl: trimTrailingSlashes(
            envText(env, "QUICKHACK_SERVER_URL")
          ),
          internalServerUrl: "",
          coupang: {
            mode: "mock" as const,
            apiHost: OFFICIAL_LIVE_API_HOSTS.COUPANG,
            mockServerUrl: DEFAULT_COUPANG_MOCK_SERVER_URL,
          },
          logen: {
            mode: "mock" as const,
            apiHost: OFFICIAL_LIVE_API_HOSTS.LOGEN,
            mockServerUrl: DEFAULT_LOGEN_MOCK_SERVER_URL,
          },
        },
        paths,
        database: {
          provider: "postgresql" as const,
          accessible: false as const,
          configured: false,
        },
        serverConfig: null,
      };
    }

    const loaded = this.readServerConfig();
    const serverConfig = loaded.config;
    const sourceRoot = loaded.location.sourceRoot;
    const appRoot = sourceRoot || /* turbopackIgnore: true */ process.cwd();
    const paths = this.resolveRuntimeDirectories({
      role: "server",
      appRoot,
      dataDirectory: serverConfig.dataDirectory,
      environment: env,
      deployment: sourceRoot ? "development" : "system-service",
      artifactKind:
        serverConfig.packageFlavor === "DEMONSTRATION"
          ? "DEMONSTRATION_SERVER"
          : "OPERATIONAL_SERVER",
    });
    const externalApiMode =
      serverConfig.packageFlavor === "OPERATIONAL" ? "live" : "mock";
    return {
      environment: serverConfig.environment,
      packageFlavor: serverConfig.packageFlavor,
      production: serverConfig.environment === "production",
      role: "server" as const,
      policies: {
        coupangWriteApiEnabled: serverConfig.coupangWriteApiEnabled,
        logenWriteApiEnabled: serverConfig.logenWriteApiEnabled,
      },
      endpoints: {
        remoteServerUrl: "",
        internalServerUrl: trimTrailingSlashes(
          envText(env, "QUICKHACK_INTERNAL_SERVER_URL")
        ),
        coupang: {
          mode: externalApiMode,
          apiHost: OFFICIAL_LIVE_API_HOSTS.COUPANG,
          mockServerUrl: DEFAULT_COUPANG_MOCK_SERVER_URL,
        },
        logen: {
          mode: externalApiMode,
          apiHost: OFFICIAL_LIVE_API_HOSTS.LOGEN,
          mockServerUrl: DEFAULT_LOGEN_MOCK_SERVER_URL,
        },
      },
      paths,
      database: {
        provider: "postgresql" as const,
        accessible: true as const,
        configured: loaded.persisted,
        postgresql: {
          implemented: true as const,
          host: serverConfig.database.host,
          port: serverConfig.database.port,
          name: serverConfig.database.name,
          runtimeUser: serverConfig.database.runtimeUser,
          migratorUser: serverConfig.database.migratorUser,
          ...(serverConfig.packageFlavor === "DEMONSTRATION"
            ? {
                coupangMockName: serverConfig.database.coupangMockName,
                coupangMockUser: serverConfig.database.coupangMockUser,
                logenMockName: serverConfig.database.logenMockName,
                logenMockUser: serverConfig.database.logenMockUser,
              }
            : {}),
        },
      },
      serverConfig: {
        ...serverConfig,
        configPath: loaded.location.configPath,
        persisted: loaded.persisted,
      },
    };
  }

  isProduction(env: RuntimeEnvironment = process.env) {
    return this.read(env).production;
  }

  getDatabaseConfig(env: RuntimeEnvironment = process.env) {
    const database = this.read(env).database;
    if (!database.accessible || !("postgresql" in database)) {
      throw new Error("Database settings are unavailable in the client runtime.");
    }
    return database.postgresql;
  }

  getBackupRetentionCount(env: RuntimeEnvironment = process.env) {
    return this.read(env).serverConfig?.backupRetentionCount ?? 30;
  }
}

export function normalizeInternalServerOrigin(configured: string) {
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("QuickHack internal server URL is not configured or invalid.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1";
  if (
    parsed.protocol !== "http:" ||
    !loopback ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "QuickHack internal server URL must be a credential-free loopback HTTP origin."
    );
  }
  return parsed.origin;
}
