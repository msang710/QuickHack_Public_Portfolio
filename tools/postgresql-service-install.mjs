import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeServerPlatform } from "../quickhack_server/platform/compose-server-platform.ts";

export const QUICKHACK_POSTGRESQL_SERVICE_NAME = "QuickHackPostgreSQL";

export function installPostgresqlService(input) {
  return composeServerPlatform().postgresqlService.install(input);
}

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
    else throw new TypeError(`Unsupported PostgreSQL installer argument: ${argument}`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!value) throw new TypeError(`PostgreSQL service installation requires ${key}.`);
  }
  return {
    installDir: path.resolve(values.installDir),
    dataDir: path.resolve(values.dataDir),
    runtimeConfig: path.resolve(values.runtimeConfig),
    serviceName: values.serviceName,
    serviceOwnership: values.serviceOwnership,
  };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  installPostgresqlService(parseArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`QuickHack PostgreSQL service ready: ${result.serviceName}\n`))
    .catch((error) => {
      process.stderr.write(`QuickHack PostgreSQL service setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
