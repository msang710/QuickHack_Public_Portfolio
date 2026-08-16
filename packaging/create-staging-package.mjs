// QuickHack note: standalone 서버, portable Node, platform-tools를 묶는 설치 패키지 staging 스크립트입니다.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectServerRuntimeClosure } from "./common/server-runtime-closure.mjs";
import { createPackageInventory, assertPackageContentPolicy } from "./common/package-inventory.mjs";
import {
  QUICKHACK_PACKAGE_MANIFEST_FILENAME,
  canonicalPackageManifestJson,
  createPackageManifest,
} from "./common/package-manifest.mjs";
import {
  QUICKHACK_PACKAGE_TARGETS,
  packageArtifactContractForTarget,
} from "./package-artifact-contract.mjs";
import {
  assertNoRuntimePackageSources,
  assertRuntimePackageRole,
} from "./runtime-package-source-boundary.mjs";
import { createChildProcessEnvironment } from "../quickhack_shared/core/child-process-environment.mjs";
import { createWindowsChildProcessPolicy } from "../quickhack_shared/platform/windows/child-process-policy.mjs";
import {
  POSTGRESQL_MAJOR_VERSION,
  POSTGRESQL_TOOL_CAPABILITIES,
  assertPostgresqlToolVersions,
} from "../quickhack_shared/platform/native-runtime-contract.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(toolsDir, "..");
const args = new Set(process.argv.slice(2));
const targetArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--target="));
const packageTarget = targetArgument?.slice("--target=".length) || "demo-server";
const postgresqlRuntimeArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--postgresql-runtime-dir="));
const packageTargets = new Set(QUICKHACK_PACKAGE_TARGETS);

if (!packageTargets.has(packageTarget)) {
  throw new Error(
    `Unsupported package target: ${packageTarget}. Expected one of: ${[...packageTargets].join(", ")}.`
  );
}

const artifact = packageArtifactContractForTarget(packageTarget);
const isClientPackage = artifact.role === "client";
const isServerPackage = artifact.role === "server";
const isDemonstrationPackage = artifact.packageFlavor === "DEMONSTRATION";
const productQualifier = isDemonstrationPackage ? "Demo" : "Operational";
const roleQualifier = isClientPackage ? "Client" : "Server";
const launcherFileName = `QuickHack-${productQualifier}-${roleQualifier}.exe`;
const outputDir = path.resolve(rootDir, "release", "windows", packageTarget);
const launcherSourceDir = path.resolve(rootDir, "release", "windows", "launchers");
const serverSourceDir = path.join(rootDir, ".next", "standalone");
const staticSourceDir = path.join(rootDir, ".next", "static");
const configuredNodeRuntimeDir = String(
  process.env.QUICKHACK_NODE_RUNTIME_DIR || ""
).trim();
const nodeSourceDir = configuredNodeRuntimeDir
  ? path.resolve(rootDir, configuredNodeRuntimeDir)
  : path.join(rootDir, "tools", "node-portable", "node-v24.17.0-win-x64");

function copyDir(source, target) {
  if (!existsSync(source)) {
    throw new Error(`Required path was not found: ${source}`);
  }

  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

function copyFile(source, target) {
  if (!existsSync(source)) {
    throw new Error(`Required file was not found: ${source}`);
  }

  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { force: true });
}

function installedPackageDirectory(packageName, fromDirectory) {
  if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(packageName)) {
    throw new Error(`Invalid runtime package name: ${packageName}`);
  }

  const packageSegments = packageName.split("/");
  let current = path.resolve(fromDirectory);
  const repositoryPrefix = `${rootDir}${path.sep}`;

  while (current === rootDir || current.startsWith(repositoryPrefix)) {
    const candidate = path.join(current, "node_modules", ...packageSegments);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (current === rootDir) break;
    current = path.dirname(current);
  }

  return null;
}

function copyInstalledPackageClosure(
  packageName,
  fromDirectory = rootDir,
  copiedDirectories = new Set(),
  optional = false
) {
  const source = installedPackageDirectory(packageName, fromDirectory);
  if (!source) {
    if (optional) return;
    throw new Error(`Required runtime package was not installed: ${packageName}`);
  }

  const resolvedSource = path.resolve(source);
  const identity =
    process.platform === "win32" ? resolvedSource.toLowerCase() : resolvedSource;
  if (copiedDirectories.has(identity)) return;
  copiedDirectories.add(identity);

  const relativeSource = path.relative(rootDir, source);
  if (
    relativeSource === "node_modules" ||
    !relativeSource.startsWith(`node_modules${path.sep}`)
  ) {
    throw new Error(`Runtime package escaped the repository node_modules: ${source}`);
  }
  copyDir(source, path.join(serverTargetDir, relativeSource));

  const packageJson = JSON.parse(
    readFileSync(path.join(source, "package.json"), "utf8")
  );
  for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
    copyInstalledPackageClosure(
      dependencyName,
      source,
      copiedDirectories,
      false
    );
  }
  for (const dependencyName of Object.keys(
    packageJson.optionalDependencies ?? {}
  )) {
    copyInstalledPackageClosure(
      dependencyName,
      source,
      copiedDirectories,
      true
    );
  }
}

function copyRuntimePackageJson(source, target) {
  if (!existsSync(source)) {
    throw new Error(`Required file was not found: ${source}`);
  }

  const packageJson = JSON.parse(readFileSync(source, "utf8"));
  const runtimePackageJson = {
    ...packageJson,
    scripts: {
      start: packageJson.scripts?.start,
      "start:standalone": packageJson.scripts?.["start:standalone"],
      "prisma:migrate:deploy": packageJson.scripts?.["prisma:migrate:deploy"],
      "qhkey:create": packageJson.scripts?.["qhkey:create"],
    },
  };

  delete runtimePackageJson.devDependencies;
  delete runtimePackageJson.scripts.capture;
  delete runtimePackageJson.scripts["capture:ui"];
  delete runtimePackageJson.scripts.dev;
  delete runtimePackageJson.scripts.build;
  delete runtimePackageJson.scripts.lint;
  delete runtimePackageJson.scripts.typecheck;

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(runtimePackageJson, null, 2)}\n`, "utf8");
}

function optionalCopyDir(source, target) {
  if (existsSync(source)) {
    copyDir(source, target);
    return true;
  }

  return false;
}

function assertNoSensitiveRuntimeFiles(targetDir) {
  const stack = [targetDir];
  const forbiddenExtensions = new Set([
    ".db",
    ".db-shm",
    ".db-wal",
    ".key",
    ".pem",
    ".pfx",
    ".p12",
    ".qhb",
    ".qhkey",
  ]);

  while (stack.length > 0) {
    const current = stack.pop();

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      const isPrivateEnv = lowerName.startsWith(".env");
      const isSecretExtension = forbiddenExtensions.has(path.extname(lowerName));

      if (isPrivateEnv || isSecretExtension) {
        throw new Error(`Sensitive runtime file entered the package: ${fullPath}`);
      }
    }
  }
}

function findPlatformToolsDir() {
  const envPath = String(process.env.QUICKHACK_PLATFORM_TOOLS_DIR || "").trim();
  const candidates = [
    envPath,
    path.join(rootDir, "platform-tools"),
    path.join(rootDir, "tools", "platform-tools"),
    path.join(rootDir, "runtime", "platform-tools"),
  ].filter(Boolean);

  return candidates.find((candidate) =>
    existsSync(path.join(candidate, "adb.exe"))
  );
}

function findPostgresqlRuntimeDir() {
  const configured = postgresqlRuntimeArgument
    ?.slice("--postgresql-runtime-dir=".length)
    .trim();
  const candidates = [
    configured ? path.resolve(configured) : "",
    path.join(rootDir, "tools", "postgresql-portable", String(POSTGRESQL_MAJOR_VERSION)),
    path.join(rootDir, "runtime", "postgresql"),
    process.platform === "win32"
      ? path.join(
          String(process.env.ProgramFiles || "C:\\Program Files"),
          "PostgreSQL",
          String(POSTGRESQL_MAJOR_VERSION)
        )
      : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const binDirectory = path.join(candidate, "bin");
    const observedVersions = {};
    for (const tool of POSTGRESQL_TOOL_CAPABILITIES.package) {
      const executablePath = path.join(binDirectory, `${tool}.exe`);
      let stat;
      try {
        stat = lstatSync(executablePath);
      } catch {
        throw new Error(`Required PostgreSQL runtime tool was not found: ${executablePath}`);
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`PostgreSQL runtime tool is not a regular file: ${executablePath}`);
      }
      const result = spawnSync(executablePath, ["--version"], {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        env: createChildProcessEnvironment({
          policy: createWindowsChildProcessPolicy(process.env),
          source: process.env,
          executableDirectories: [binDirectory],
        }),
      });
      if (result.error || result.status !== 0) {
        throw new Error(`PostgreSQL runtime tool version check failed: ${tool}`);
      }
      observedVersions[tool] = `${result.stdout}\n${result.stderr}`.trim();
    }
    assertPostgresqlToolVersions(observedVersions, { capability: "package" });
    for (const directory of ["lib", "share"]) {
      if (!existsSync(path.join(candidate, directory))) {
        throw new Error(`PostgreSQL runtime directory was not found: ${directory}`);
      }
    }
    return candidate;
  }
  return null;
}

function pruneClientStandalone(targetRoot) {
  for (const relativePath of ["quickhack_server", "mock_server", "prisma"]) {
    rmSync(path.join(targetRoot, relativePath), { recursive: true, force: true });
  }
  const apiRoot = path.join(targetRoot, ".next", "server", "app", "api");
  if (existsSync(apiRoot)) {
    const allowedLocalRoutes = new Set(["adb", "client", "runtime"]);
    for (const entry of readdirSync(apiRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !allowedLocalRoutes.has(entry.name)) {
        rmSync(path.join(apiRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
}

function pruneOperationalServerStandalone(targetRoot) {
  for (const relativePath of [
    ".next/server/app/api/coupang/mock",
    ".next/server/app/api/developer/api-sandbox",
    "quickhack_server/sales-channel/coupang/mock-client.ts",
  ]) {
    rmSync(path.join(targetRoot, ...relativePath.split("/")), { recursive: true, force: true });
  }
}

function writeLauncher(filename, lines) {
  writeFileSync(
    path.join(outputDir, filename),
    `${lines.join("\r\n")}\r\n`,
    "utf8"
  );
}

function finalizePackage() {
  const inventory = createPackageInventory(outputDir);
  assertPackageContentPolicy(artifact.artifactKind, inventory.entries);
  const version = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
  const manifest = createPackageManifest({
    artifactKind: artifact.artifactKind,
    platform: "win32",
    architecture: "x64",
    version,
    contentInventorySha256: inventory.sha256,
  });
  writeFileSync(
    path.join(outputDir, QUICKHACK_PACKAGE_MANIFEST_FILENAME),
    canonicalPackageManifestJson(manifest),
    "utf8"
  );
  return manifest;
}

const postgresqlRuntimeDir = isServerPackage
  ? findPostgresqlRuntimeDir()
  : null;
if (isServerPackage && !postgresqlRuntimeDir) {
  throw new Error(
    `PostgreSQL ${POSTGRESQL_MAJOR_VERSION} runtime was not found. ` +
    `Pass --postgresql-runtime-dir=<PostgreSQL ${POSTGRESQL_MAJOR_VERSION} root>.`
  );
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

if (isClientPackage) {
  if (!existsSync(path.join(serverSourceDir, "server.js"))) {
    throw new Error("Next standalone output was not found. Run npm run build first.");
  }

  if (!existsSync(path.join(nodeSourceDir, "node.exe"))) {
    throw new Error(`Portable Node was not found: ${nodeSourceDir}`);
  }

  const clientTargetDir = path.join(outputDir, "client");
  const runtimeTargetDir = path.join(outputDir, "runtime");

  copyDir(serverSourceDir, clientTargetDir);
  for (const tracedDirectory of [
    "database",
    "platform-tools",
    "prisma",
    "release",
    "templates",
    "tools",
  ]) {
    rmSync(path.join(clientTargetDir, tracedDirectory), {
      recursive: true,
      force: true,
    });
  }
  for (const envFile of [".env", ".env.local", ".env.production"]) {
    rmSync(path.join(clientTargetDir, envFile), { force: true });
  }

  copyDir(staticSourceDir, path.join(clientTargetDir, ".next", "static"));
  optionalCopyDir(path.join(rootDir, "public"), path.join(clientTargetDir, "public"));
  copyFile(
    path.join(nodeSourceDir, "node.exe"),
    path.join(runtimeTargetDir, "node", "node.exe")
  );
  copyFile(
    path.join(rootDir, "tools", "quickhack-raw-print.ps1"),
    path.join(runtimeTargetDir, "printer", "quickhack-raw-print.ps1")
  );
  if (existsSync(path.join(nodeSourceDir, "LICENSE"))) {
    copyFile(
      path.join(nodeSourceDir, "LICENSE"),
      path.join(runtimeTargetDir, "node", "LICENSE")
    );
  }

  const platformToolsDir = findPlatformToolsDir();

  if (platformToolsDir) {
    copyDir(platformToolsDir, path.join(runtimeTargetDir, "platform-tools"));
  } else if (args.has("--require-platform-tools")) {
    throw new Error("platform-tools is required but was not found.");
  } else {
    writeFileSync(
      path.join(runtimeTargetDir, "platform-tools.README.txt"),
      "ADB platform-tools was not found while creating this client package.\r\n",
      "utf8"
    );
  }

  copyFile(
    path.join(launcherSourceDir, launcherFileName),
    path.join(outputDir, launcherFileName)
  );
  copyFile(
    path.join(rootDir, "tools", "client-runtime-launcher.mjs"),
    path.join(outputDir, "tools", "client-runtime-launcher.mjs")
  );
  copyFile(
    path.join(rootDir, "tools", "client-runtime-config.mjs"),
    path.join(outputDir, "tools", "client-runtime-config.mjs")
  );
  copyFile(
    path.join(rootDir, "tools", "client-print-spool-core.mjs"),
    path.join(outputDir, "tools", "client-print-spool-core.mjs")
  );
  copyFile(
    path.join(rootDir, "packaging", "windows", "purge-installation.ps1"),
    path.join(outputDir, "packaging", "purge-installation.ps1")
  );
  for (const fileName of [
    "child-process-environment.mjs",
    "child-process-environment.d.mts",
    "package-runtime-identity.mjs",
    "package-runtime-identity.d.mts",
  ]) {
    copyFile(
      path.join(rootDir, "quickhack_shared", "core", fileName),
      path.join(outputDir, "quickhack_shared", "core", fileName)
    );
  }
  pruneClientStandalone(clientTargetDir);
  for (const relativePath of collectServerRuntimeClosure({
    rootDirectory: rootDir,
    entrypoints: ["tools/client-runtime-launcher.mjs"],
    seeds: [],
  })) {
    copyFile(
      path.join(rootDir, ...relativePath.split("/")),
      path.join(outputDir, ...relativePath.split("/"))
    );
  }
  optionalCopyDir(path.join(rootDir, "assets"), path.join(outputDir, "assets"));
  mkdirSync(path.join(outputDir, "config"), { recursive: true });
  writeFileSync(
    path.join(outputDir, `README-${productQualifier.toUpperCase()}-CLIENT.txt`),
    [
      `QuickHack ${productQualifier.toLowerCase()} client`,
      "",
      `Run ${launcherFileName} to start the local client runtime and open QuickHack.`,
      "Before first launch, copy every file from the server-generated client-config folder into config as one unit.",
      "Do not mix files from different trust-bundle generations; incomplete bundles are rejected.",
      `The local client listens only on http://127.0.0.1:${isDemonstrationPackage ? 3001 : 3002}.`,
      "ADB commands run on this client PC through the bundled Android platform-tools.",
      "Logen labels are sent to an installed Windows printer through the bundled RAW printer bridge.",
      "Install the TSC DA200 Windows driver and select the exact queue in QuickHack before printing.",
      "This package does not contain a database, central server, mock server, worker, or API keys.",
      "",
    ].join("\r\n"),
    "utf8"
  );
  assertNoSensitiveRuntimeFiles(outputDir);
  assertNoRuntimePackageSources(outputDir);
  assertRuntimePackageRole(packageTarget, outputDir);
  finalizePackage();
  console.log(`${productQualifier} client package created: ${outputDir}`);
  if (!platformToolsDir) {
    console.warn("Warning: platform-tools was not bundled because adb.exe was not found.");
  }
  process.exit(0);
}

if (!existsSync(path.join(serverSourceDir, "server.js"))) {
  throw new Error("Next standalone output was not found. Run npm run build first.");
}

if (!existsSync(path.join(nodeSourceDir, "node.exe"))) {
  throw new Error(`Portable Node was not found: ${nodeSourceDir}`);
}

const serverTargetDir = path.join(outputDir, "server");
const runtimeTargetDir = path.join(outputDir, "runtime");

function copyServerRuntimeFile(relativePath) {
  copyFile(
    path.join(rootDir, ...relativePath.split("/")),
    path.join(serverTargetDir, ...relativePath.split("/"))
  );
}

copyDir(serverSourceDir, serverTargetDir);
for (const tracedDirectory of [
  "database",
  "platform-tools",
  "prisma",
  "release",
  "templates",
  "tools",
]) {
  rmSync(path.join(serverTargetDir, tracedDirectory), {
    recursive: true,
    force: true,
  });
}
for (const envFile of [".env", ".env.local", ".env.production"]) {
  rmSync(path.join(serverTargetDir, envFile), { force: true });
}

copyDir(staticSourceDir, path.join(serverTargetDir, ".next", "static"));
optionalCopyDir(path.join(rootDir, "public"), path.join(serverTargetDir, "public"));
optionalCopyDir(path.join(rootDir, "templates"), path.join(outputDir, "templates"));
copyFile(
  path.join(nodeSourceDir, "node.exe"),
  path.join(runtimeTargetDir, "node", "node.exe")
);
if (existsSync(path.join(nodeSourceDir, "LICENSE"))) {
  copyFile(
    path.join(nodeSourceDir, "LICENSE"),
    path.join(runtimeTargetDir, "node", "LICENSE")
  );
}
copyDir(path.join(rootDir, "prisma"), path.join(serverTargetDir, "prisma"));
const serverRuntimeFiles = collectServerRuntimeClosure({
  rootDirectory: rootDir,
  entrypoints: [artifact.entrypoint],
  seeds: [
    "tools/quickhack-operator.mjs",
    "tools/quickhack-operator-core.mjs",
    "tools/operator-direct-one-shot.mjs",
    "tools/deploy-postgresql-migrations.mjs",
    "tools/audit-postgresql-schema.mjs",
    "tools/provision-initial-leader.mjs",
    "tools/postgresql-backup.mjs",
    "tools/postgresql-restore.mjs",
  ],
});
for (const relativePath of serverRuntimeFiles) {
  copyServerRuntimeFile(relativePath);
  copyFile(
    path.join(rootDir, ...relativePath.split("/")),
    path.join(outputDir, ...relativePath.split("/"))
  );
}
if (!isDemonstrationPackage) pruneOperationalServerStandalone(serverTargetDir);
copyDir(
  path.join(rootDir, "tools", "platform"),
  path.join(serverTargetDir, "tools", "platform")
);
copyInstalledPackageClosure("prisma");
copyFile(
  path.join(rootDir, "tools", "password.mjs"),
  path.join(serverTargetDir, "tools", "password.mjs")
);
copyFile(
  path.join(rootDir, "tools", "provision-initial-leader.mjs"),
  path.join(serverTargetDir, "tools", "provision-initial-leader.mjs")
);
copyFile(path.join(rootDir, "tools", "create-qhkey.mjs"), path.join(serverTargetDir, "tools", "create-qhkey.mjs"));
if (isDemonstrationPackage) {
  copyFile(
    path.join(rootDir, "tools", "mock-coupang-credential-client.mjs"),
    path.join(serverTargetDir, "tools", "mock-coupang-credential-client.mjs")
  );
}
copyFile(
  path.join(rootDir, "quickhack_server", "security", "qhkey-format.mjs"),
  path.join(serverTargetDir, "quickhack_server", "security", "qhkey-format.mjs")
);
copyFile(
  path.join(rootDir, "quickhack_server", "security", "backup-encryption-core.mjs"),
  path.join(
    serverTargetDir,
    "quickhack_server",
    "security",
    "backup-encryption-core.mjs"
  )
);
for (const fileName of [
  "server-runtime-config.mjs",
  "server-runtime-config.d.mts",
  "child-process-environment.mjs",
  "child-process-environment.d.mts",
]) {
  if (fileName !== "server-runtime-config.mjs") {
    copyServerRuntimeFile(`quickhack_shared/core/${fileName}`);
  }
  copyFile(
    path.join(rootDir, "quickhack_shared", "core", fileName),
    path.join(outputDir, "quickhack_shared", "core", fileName)
  );
}
for (const fileName of [
  "backup-key-provider-core.mjs",
  "backup-key-provider-core.d.mts",
  "windows-user-protected-secret.mjs",
  "windows-user-protected-secret.d.mts",
  "async-powershell.mjs",
  "async-powershell.d.mts",
  "qhkey-drive-locator.mjs",
  "qhkey-drive-locator.d.mts",
  "qhkey-master-key-provider.mjs",
  "qhkey-master-key-provider.d.mts",
  "qhkey-cache-invalidation.mjs",
  "qhkey-cache-invalidation.d.mts",
  "qhkey-replacement-transaction.mjs",
  "qhkey-replacement-transaction.d.mts",
]) {
  copyFile(
    path.join(rootDir, "quickhack_server", "security", fileName),
    path.join(serverTargetDir, "quickhack_server", "security", fileName)
  );
}
copyFile(
  path.join(
    rootDir,
    "quickhack_server",
    "observability",
    "trace-retention-policy.mjs"
  ),
  path.join(
    serverTargetDir,
    "quickhack_server",
    "observability",
    "trace-retention-policy.mjs"
  )
);
copyRuntimePackageJson(
  path.join(rootDir, "package.json"),
  path.join(serverTargetDir, "package.json")
);
copyFile(
  path.join(launcherSourceDir, launcherFileName),
  path.join(outputDir, launcherFileName)
);
copyFile(
  path.join(rootDir, ...artifact.entrypoint.split("/")),
  path.join(outputDir, ...artifact.entrypoint.split("/"))
);
if (isDemonstrationPackage) {
  copyFile(
    path.join(rootDir, "tools", "mock-runtime-launcher.mjs"),
    path.join(outputDir, "tools", "mock-runtime-launcher.mjs")
  );
}
copyFile(
  path.join(rootDir, "tools", "server-console-tls.mjs"),
  path.join(outputDir, "tools", "server-console-tls.mjs")
);
copyFile(
  path.join(rootDir, "tools", "quickhack-https-gateway.mjs"),
  path.join(outputDir, "tools", "quickhack-https-gateway.mjs")
);
copyFile(
  path.join(rootDir, "tools", "quickhack-shutdown-coordinator.mjs"),
  path.join(outputDir, "tools", "quickhack-shutdown-coordinator.mjs")
);
copyFile(
  path.join(rootDir, "tools", "quickhack-shutdown-coordinator.d.mts"),
  path.join(outputDir, "tools", "quickhack-shutdown-coordinator.d.mts")
);
copyFile(
  path.join(rootDir, "tools", "quickhack-https-forwarding.mjs"),
  path.join(outputDir, "tools", "quickhack-https-forwarding.mjs")
);
for (const runtimeDirectory of ["bin", "lib", "share"]) {
  copyDir(
    path.join(postgresqlRuntimeDir, runtimeDirectory),
    path.join(runtimeTargetDir, "postgresql", runtimeDirectory)
  );
}
for (const licenseName of ["COPYRIGHT", "LICENSE", "README.txt"]) {
  const source = path.join(postgresqlRuntimeDir, licenseName);
  if (existsSync(source)) {
    copyFile(source, path.join(runtimeTargetDir, "postgresql", licenseName));
  }
}
copyFile(
  path.join(rootDir, "quickhack_shared", "http", "request-body-policy.mjs"),
  path.join(outputDir, "quickhack_shared", "http", "request-body-policy.mjs")
);
copyFile(
  path.join(rootDir, "tools", "trust-bundle.mjs"),
  path.join(outputDir, "tools", "trust-bundle.mjs")
);
copyFile(
  path.join(rootDir, "tools", "trust-bundle.d.mts"),
  path.join(outputDir, "tools", "trust-bundle.d.mts")
);
copyFile(
  path.join(rootDir, "quickhack_shared", "security", "transport-security-policy.mjs"),
  path.join(outputDir, "quickhack_shared", "security", "transport-security-policy.mjs")
);
copyFile(
  path.join(rootDir, "quickhack_shared", "security", "transport-security-policy.d.mts"),
  path.join(outputDir, "quickhack_shared", "security", "transport-security-policy.d.mts")
);
copyFile(
  path.join(rootDir, "tools", "initialize-https.ps1"),
  path.join(outputDir, "tools", "initialize-https.ps1")
);
copyFile(
  path.join(rootDir, "tools", "server-console-qhkey.mjs"),
  path.join(outputDir, "tools", "server-console-qhkey.mjs")
);
if (isDemonstrationPackage) {
  copyFile(
    path.join(rootDir, "tools", "mock-coupang-credential-client.mjs"),
    path.join(outputDir, "tools", "mock-coupang-credential-client.mjs")
  );
}
copyFile(
  path.join(rootDir, "quickhack_server", "security", "qhkey-format.mjs"),
  path.join(outputDir, "quickhack_server", "security", "qhkey-format.mjs")
);
copyFile(
  path.join(rootDir, "quickhack_server", "security", "backup-encryption-core.mjs"),
  path.join(
    outputDir,
    "quickhack_server",
    "security",
    "backup-encryption-core.mjs"
  )
);
for (const fileName of [
  "backup-key-provider-core.mjs",
  "backup-key-provider-core.d.mts",
  "windows-user-protected-secret.mjs",
  "windows-user-protected-secret.d.mts",
  "async-powershell.mjs",
  "async-powershell.d.mts",
  "qhkey-drive-locator.mjs",
  "qhkey-drive-locator.d.mts",
  "qhkey-master-key-provider.mjs",
  "qhkey-master-key-provider.d.mts",
  "qhkey-cache-invalidation.mjs",
  "qhkey-cache-invalidation.d.mts",
  "qhkey-replacement-transaction.mjs",
  "qhkey-replacement-transaction.d.mts",
]) {
  copyFile(
    path.join(rootDir, "quickhack_server", "security", fileName),
    path.join(outputDir, "quickhack_server", "security", fileName)
  );
}
copyDir(
  path.join(rootDir, "quickhack_server", "platform"),
  path.join(outputDir, "quickhack_server", "platform")
);
copyDir(
  path.join(rootDir, "quickhack_shared", "platform"),
  path.join(outputDir, "quickhack_shared", "platform")
);
for (const fileName of [
  "trace-retention-policy.mjs",
  "trace-retention-policy.d.mts",
]) {
  copyFile(
    path.join(
      rootDir,
      "quickhack_server",
      "observability",
      fileName
    ),
    path.join(
      outputDir,
      "quickhack_server",
      "observability",
      fileName
    )
  );
}
copyFile(
  path.join(rootDir, "packaging", "initialize-install.ps1"),
  path.join(outputDir, "packaging", "initialize-install.ps1")
);
copyFile(
  path.join(rootDir, "packaging", "finalize-install.ps1"),
  path.join(outputDir, "packaging", "finalize-install.ps1")
);
copyFile(
  path.join(rootDir, "packaging", "windows", "purge-installation.ps1"),
  path.join(outputDir, "packaging", "purge-installation.ps1")
);
copyFile(
  path.join(rootDir, "packaging", "windows", "register-console-service.ps1"),
  path.join(outputDir, "packaging", "register-console-service.ps1")
);
optionalCopyDir(path.join(rootDir, "assets"), path.join(outputDir, "assets"));
if (isDemonstrationPackage) {
  copyFile(
    path.join(rootDir, "mock_server", "coupang-mock-server.mjs"),
    path.join(outputDir, "mock_server", "coupang-mock-server.mjs")
  );
  for (const fileName of [
    "coupang-synthetic-catalog.mjs",
    "coupang-synthetic-catalog.d.mts",
  ]) {
    copyFile(
      path.join(rootDir, "mock_server", fileName),
      path.join(outputDir, "mock_server", fileName)
    );
  }
  copyDir(
    path.join(rootDir, "mock_server", "logen"),
    path.join(outputDir, "mock_server", "logen")
  );
  copyFile(path.join(rootDir, "mock.cmd"), path.join(outputDir, "mock.cmd"));
  copyFile(
    path.join(rootDir, "logen-mock.cmd"),
    path.join(outputDir, "logen-mock.cmd")
  );
}
for (const dependencyName of [
  "pg",
  "pg-cloudflare",
  "pg-connection-string",
  "pg-int8",
  "pg-pool",
  "pg-protocol",
  "pg-types",
  "pgpass",
  "postgres-bytea",
  "postgres-date",
  "postgres-interval",
  "split2",
  "xtend",
]) {
  copyDir(
    path.join(serverTargetDir, "node_modules", dependencyName),
    path.join(outputDir, "node_modules", dependencyName)
  );
}

const platformToolsDir = findPlatformToolsDir();

if (platformToolsDir) {
  copyDir(platformToolsDir, path.join(runtimeTargetDir, "platform-tools"));
} else {
  writeFileSync(
    path.join(runtimeTargetDir, "platform-tools.README.txt"),
    [
      "platform-tools was not found while creating this staging package.",
      "",
      "Set QUICKHACK_PLATFORM_TOOLS_DIR to a folder containing adb.exe,",
      "or place platform-tools at the project root before running npm run stage:package.",
      "",
    ].join("\r\n"),
    "utf8"
  );

  if (args.has("--require-platform-tools")) {
    throw new Error("platform-tools is required but was not found.");
  }
}

writeLauncher("Migrate-Database.cmd", [
  "@echo off",
  "setlocal",
  "set \"ROOT=%~dp0\"",
  "cd /d \"%ROOT%server\"",
  "\"%ROOT%runtime\\node\\node.exe\" tools\\deploy-postgresql-migrations.mjs %*",
  "exit /b %ERRORLEVEL%",
]);

writeLauncher(`Migrate-${productQualifier}-Database.cmd`, [
  "@echo off",
  "call \"%~dp0Migrate-Database.cmd\" %*",
  "exit /b %ERRORLEVEL%",
]);

if (isDemonstrationPackage) writeLauncher("Create-Demo-Coupang-QHKEY.cmd", [
  "@echo off",
  "setlocal",
  "set \"ROOT=%~dp0\"",
  "cd /d \"%ROOT%server\"",
  "\"%ROOT%runtime\\node\\node.exe\" tools\\create-qhkey.mjs %*",
]);

writeFileSync(
  path.join(outputDir, "README-STAGING.txt"),
  [
    `QuickHack ${productQualifier.toLowerCase()} server package`,
    "",
    `1. Run Migrate-${productQualifier}-Database.cmd on the server PC before first launch.`,
    `2. Run ${launcherFileName} on the server PC.`,
    "3. In the console, generate the HTTPS certificate before starting QuickHack App.",
    "4. Copy the generated client-config files into each QuickHack client package's config folder.",
    "5. Use the console page to start QuickHack App.",
    ...(isDemonstrationPackage ? [
      "6. Start Coupang Mock from the same console page.",
      "7. Start Coupang Mock, then use the console API key page to issue and store a demo credential.",
      "8. Create-Demo-Coupang-QHKEY.cmd provides the same mock-issued QHKEY flow for console-only setup.",
    ] : [
      "6. Register live integration credentials through an operational QHKEY.",
    ]),
    `9. Install the separate QuickHack ${productQualifier} Client package on staff PCs.`,
    "",
    "This folder is generated and can be deleted/recreated with npm run stage:package.",
    "",
  ].join("\r\n"),
  "utf8"
);

assertNoSensitiveRuntimeFiles(outputDir);
assertNoRuntimePackageSources(outputDir);
assertRuntimePackageRole(packageTarget, outputDir);
finalizePackage();

console.log(`${productQualifier} server package created: ${outputDir}`);
if (!platformToolsDir) {
  console.warn("Warning: platform-tools was not bundled because adb.exe was not found.");
}
