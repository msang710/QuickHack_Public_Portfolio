import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageInventory, assertPackageContentPolicy } from "../common/package-inventory.mjs";
import { collectServerRuntimeClosure } from "../common/server-runtime-closure.mjs";
import {
  QUICKHACK_PACKAGE_MANIFEST_FILENAME,
  canonicalPackageManifestJson,
  createPackageManifest,
} from "../common/package-manifest.mjs";
import { assertNoRuntimePackageSources, assertRuntimePackageRole } from "../runtime-package-source-boundary.mjs";
import { createServerServiceCredentialManifest, renderSystemdCredentialDirectives } from "../../tools/platform/linux/server-service-credential-manifest.mjs";
import { linuxArtifactConfig, LINUX_PACKAGE_TARGETS } from "./linux-artifact-config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..", "..");
const targetArgument = process.argv.slice(2).find((argument) => argument.startsWith("--target="));
const target = targetArgument?.slice("--target=".length) || "demo-server";
if (!LINUX_PACKAGE_TARGETS.includes(target)) throw new TypeError(`Unsupported Linux package target: ${target}.`);
const config = linuxArtifactConfig(target);
const outputRoot = path.join(root, ...config.packageRoot.split("/"));
const applicationRoot = path.join(outputRoot, ...config.applicationRoot.split("/").filter(Boolean));

function copyFile(relativePath, destinationRoot = applicationRoot) {
  const source = path.join(root, ...relativePath.split("/"));
  if (!existsSync(source)) throw new Error(`Required package file was not found: ${relativePath}`);
  const destination = path.join(destinationRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { force: true, dereference: true });
}

function copyDirectory(source, destination) {
  if (!existsSync(source)) throw new Error(`Required package directory was not found: ${source}`);
  cpSync(source, destination, { recursive: true, force: true, dereference: true });
}

function renderTemplate(relativeTemplate, destination, replacements) {
  let source = readFileSync(path.join(root, ...relativeTemplate.split("/")), "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    source = source.replaceAll(`@${key}@`, String(value));
  }
  if (/@QUICKHACK_[A-Z0-9_]+@/u.test(source)) {
    throw new Error(`Linux package template has unresolved placeholders: ${relativeTemplate}`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, source, "utf8");
}

rmSync(path.dirname(outputRoot), { recursive: true, force: true });
mkdirSync(applicationRoot, { recursive: true });

const standalone = path.join(root, ".next", "standalone");
const staticRoot = path.join(root, ".next", "static");
if (!existsSync(path.join(standalone, "server.js"))) {
  throw new Error("Next standalone output was not found. Run npm run build first.");
}
const webRoot = path.join(applicationRoot, config.role === "server" ? "server" : "client");
copyDirectory(standalone, webRoot);
for (const directory of ["database", "platform-tools", "prisma", "release", "templates", "tools"]) {
  rmSync(path.join(webRoot, directory), { recursive: true, force: true });
}
for (const envFile of [".env", ".env.local", ".env.production"]) {
  rmSync(path.join(webRoot, envFile), { force: true });
}
if (config.role === "client") {
  for (const relativePath of ["quickhack_server", "mock_server", "prisma"]) {
    rmSync(path.join(webRoot, relativePath), { recursive: true, force: true });
  }
  const apiRoot = path.join(webRoot, ".next", "server", "app", "api");
  if (existsSync(apiRoot)) {
    const allowedLocalRoutes = new Set(["adb", "client", "runtime"]);
    for (const entry of readdirSync(apiRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !allowedLocalRoutes.has(entry.name)) rmSync(path.join(apiRoot, entry.name), { recursive: true, force: true });
    }
  }
} else if (!config.includesMockRuntime) {
  for (const relativePath of [".next/server/app/api/coupang/mock", ".next/server/app/api/developer/api-sandbox", "quickhack_server/sales-channel/coupang/mock-client.ts"]) {
    rmSync(path.join(webRoot, ...relativePath.split("/")), { recursive: true, force: true });
  }
}
copyDirectory(staticRoot, path.join(webRoot, ".next", "static"));
if (existsSync(path.join(root, "public"))) copyDirectory(path.join(root, "public"), path.join(webRoot, "public"));

const runtimeSeeds = config.role === "server"
  ? [
      "tools/quickhack-operator.mjs",
      "tools/quickhack-operator-core.mjs",
      "tools/operator-direct-one-shot.mjs",
      "tools/deploy-postgresql-migrations.mjs",
      "tools/audit-postgresql-schema.mjs",
      "tools/provision-initial-leader.mjs",
      "tools/postgresql-backup.mjs",
      "tools/postgresql-restore.mjs",
    ]
  : [];
const runtimeClosure = collectServerRuntimeClosure({
  rootDirectory: root,
  entrypoints: [config.entrypoint],
  seeds: runtimeSeeds,
});
for (const relativePath of runtimeClosure) copyFile(relativePath);

if (config.role === "server") {
  copyDirectory(path.join(root, "prisma"), path.join(applicationRoot, "prisma"));
  if (existsSync(path.join(root, "templates"))) copyDirectory(path.join(root, "templates"), path.join(applicationRoot, "templates"));
  if (config.includesMockRuntime) {
    copyDirectory(path.join(root, "mock_server"), path.join(applicationRoot, "mock_server"));
  }
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
writeFileSync(path.join(applicationRoot, "package.json"), `${JSON.stringify({ name: packageJson.name, version: packageJson.version, type: packageJson.type }, null, 2)}\n`, "utf8");

if (config.role === "server") {
  const runtimeConfig = {
    schemaVersion: 3,
    packageFlavor: config.packageFlavor,
    environment: "production",
    coupangWriteApiEnabled: false,
    logenWriteApiEnabled: false,
    dataDirectory: config.dataRoot,
    backupRetentionCount: 30,
    database: {
      host: "127.0.0.1",
      port: 5432,
      name: "quickhack",
      runtimeUser: "quickhack_runtime",
      migratorUser: "quickhack_migrator",
      ...(config.includesMockRuntime ? {
        coupangMockName: "quickhack_mock_coupang",
        coupangMockUser: "quickhack_mock_coupang",
        logenMockName: "quickhack_mock_logen",
        logenMockUser: "quickhack_mock_logen",
      } : {}),
    },
  };
  const credentialConfig = runtimeConfig;
  const applicationCredentials = renderSystemdCredentialDirectives(createServerServiceCredentialManifest(credentialConfig, "APPLICATION"));
  const migratorCredentials = renderSystemdCredentialDirectives(createServerServiceCredentialManifest(credentialConfig, "MIGRATE"));
  const operatorCredentials = renderSystemdCredentialDirectives(createServerServiceCredentialManifest(credentialConfig, "INSTALL"));
  const units = config.services;
  const replacements = {
    QUICKHACK_PACKAGE_FLAVOR: config.packageFlavor,
    QUICKHACK_APPLICATION_USER: config.users.application,
    QUICKHACK_APPLICATION_GROUP: config.users.application,
    QUICKHACK_POSTGRESQL_USER: config.users.postgresql,
    QUICKHACK_POSTGRESQL_GROUP: config.users.postgresql,
    QUICKHACK_INSTALL_ROOT: config.applicationRoot,
    QUICKHACK_NODE_EXECUTABLE: "/usr/bin/node",
    QUICKHACK_CONSOLE_ENTRY: `${config.applicationRoot}/${config.entrypoint}`,
    QUICKHACK_OPERATOR_ENTRY: `${config.applicationRoot}/tools/quickhack-operator.mjs`,
    QUICKHACK_MIGRATION_ENTRY: `${config.applicationRoot}/tools/deploy-postgresql-migrations.mjs`,
    QUICKHACK_RUNTIME_CONFIG: config.runtimeConfig,
    QUICKHACK_PACKAGE_MANIFEST: `${config.applicationRoot}/${QUICKHACK_PACKAGE_MANIFEST_FILENAME}`,
    QUICKHACK_POSTGRESQL_UNIT: units.postgresql,
    QUICKHACK_MIGRATION_UNIT: units.migrate,
    QUICKHACK_APPLICATION_UNIT: units.console,
    QUICKHACK_POSTGRES_EXECUTABLE: "/usr/bin/postgres",
    QUICKHACK_PGDATA: `${config.dataRoot}/postgresql/18/data`,
    QUICKHACK_POSTGRESQL_CONFIG: `${config.dataRoot}/postgresql/18/data/postgresql.conf`,
    QUICKHACK_POSTGRESQL_LOG_DIR: `${config.dataRoot}/postgresql/18/logs`,
    QUICKHACK_CONFIG_DIR: config.configRoot,
    QUICKHACK_DATA_DIR: config.dataRoot,
    QUICKHACK_STATE_DIR: `${config.dataRoot}/state`,
    QUICKHACK_LOG_DIR: `/var/log/quickhack/${config.flavorSlug}-server`,
    QUICKHACK_CACHE_DIR: config.cacheRoot,
    QUICKHACK_APPLICATION_CREDENTIAL_DIRECTIVES: applicationCredentials,
    QUICKHACK_MIGRATOR_CREDENTIAL_DIRECTIVES: migratorCredentials,
    QUICKHACK_OPERATOR_CREDENTIAL_DIRECTIVES: operatorCredentials,
  };
  for (const [key, template] of Object.entries({ postgresql: "quickhack-postgresql.service.in", console: "quickhack-console.service.in", migrate: "quickhack-migrate.service.in", operator: "quickhack-operator@.service.in" })) {
    renderTemplate(`packaging/linux/systemd/${template}`, path.join(outputRoot, "usr/lib/systemd/system", units[key]), replacements);
  }
  renderTemplate("packaging/linux/sysusers/quickhack-server.conf.in", path.join(outputRoot, "usr/lib/sysusers.d", `${config.installedIdentity}.conf`), replacements);
  renderTemplate("packaging/linux/tmpfiles/quickhack-server.conf.in", path.join(outputRoot, "usr/lib/tmpfiles.d", `${config.installedIdentity}.conf`), replacements);
  for (const action of ["setup", "purge"]) {
    renderTemplate(
      `packaging/linux/launchers/quickhack-server-${action}.in`,
      path.join(outputRoot, "usr/bin", `${config.launcherName}-${action}`),
      {
        QUICKHACK_NODE_EXECUTABLE: "/usr/bin/node",
        QUICKHACK_PACKAGE_LIFECYCLE_ENTRY: `${config.applicationRoot}/tools/platform/linux/package-lifecycle.mjs`,
        QUICKHACK_ARTIFACT_KIND: config.artifactKind,
      }
    );
  }
  mkdirSync(path.join(applicationRoot, "packaging"), { recursive: true });
  writeFileSync(path.join(applicationRoot, "packaging", "server-runtime.template.json"), `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
}

const launcherTemplate = config.role === "server" ? "quickhack-console.in" : "quickhack-client.in";
renderTemplate(`packaging/linux/launchers/${launcherTemplate}`, path.join(outputRoot, "usr/bin", config.launcherName), {
  QUICKHACK_NODE_EXECUTABLE: "/usr/bin/node",
  QUICKHACK_OPERATOR_ENTRY: `${config.applicationRoot}/tools/quickhack-operator.mjs`,
  QUICKHACK_CLIENT_ENTRY: `${config.applicationRoot}/tools/client-runtime-launcher.mjs`,
  QUICKHACK_RUNTIME_CONFIG: config.runtimeConfig,
  QUICKHACK_PACKAGE_MANIFEST: `${config.applicationRoot}/${QUICKHACK_PACKAGE_MANIFEST_FILENAME}`,
});

assertNoRuntimePackageSources(applicationRoot);
assertRuntimePackageRole(target, applicationRoot);
const inventory = createPackageInventory(applicationRoot);
assertPackageContentPolicy(config.artifactKind, inventory.entries);
const manifest = createPackageManifest({
  artifactKind: config.artifactKind,
  platform: "linux",
  architecture: "x86_64",
  version: packageJson.version,
  contentInventorySha256: inventory.sha256,
});
writeFileSync(path.join(applicationRoot, QUICKHACK_PACKAGE_MANIFEST_FILENAME), canonicalPackageManifestJson(manifest), "utf8");
console.log(`Linux ${target} staging root created: ${outputRoot}`);
