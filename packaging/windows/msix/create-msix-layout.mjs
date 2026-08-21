import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageInventory } from "../../common/package-inventory.mjs";
import { msixArtifactConfig } from "./msix-artifact-config.mjs";
import { msixVersionFromSemver } from "./msix-version.mjs";
import { renderAppxManifest } from "./render-appx-manifest.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function invalid(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function assertSafeOutputPath(outputDirectory, sourceDirectory) {
  const output = path.resolve(outputDirectory);
  const source = path.resolve(sourceDirectory);
  const allowedRoot = path.join(repositoryRoot, "release");
  if (output === allowedRoot || !output.startsWith(`${allowedRoot}${path.sep}`)) {
    throw invalid("MSIX_OUTPUT_UNSAFE", "MSIX layout output must be a descendant of repository release/.");
  }
  if (output === source || output.startsWith(`${source}${path.sep}`) || source.startsWith(`${output}${path.sep}`)) {
    throw invalid("MSIX_OUTPUT_UNSAFE", "MSIX layout output and staging input must not contain one another.");
  }
  return output;
}

function assertRegularTree(rootDirectory) {
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) {
        throw invalid("MSIX_STAGING_INVALID", `MSIX staging must not contain symbolic links: ${filename}`);
      }
      if (stat.isDirectory()) pending.push(filename);
    }
  }
}

export function assertMsixStagingContent(config, paths) {
  const normalized = new Set(paths.map((value) => String(value).replaceAll("\\", "/")));
  const required = [
    config.launcherFileName,
    "runtime/node/node.exe",
    "runtime/node/LICENSE",
    "runtime/node/quickhack-node-runtime.json",
  ];
  if (config.runtime.postgresql) {
    required.push("runtime/postgresql/bin/postgres.exe");
    if (![...normalized].some((value) => value.startsWith("runtime/postgresql/lib/"))) {
      throw invalid("MSIX_RUNTIME_MISSING", "Server MSIX staging is missing PostgreSQL lib content.");
    }
    if (![...normalized].some((value) => value.startsWith("runtime/postgresql/share/"))) {
      throw invalid("MSIX_RUNTIME_MISSING", "Server MSIX staging is missing PostgreSQL share content.");
    }
  } else if ([...normalized].some((value) => value.startsWith("runtime/postgresql/"))) {
    throw invalid("MSIX_ROLE_CONTENT_FORBIDDEN", "Client MSIX staging must not contain PostgreSQL.");
  }
  for (const requiredPath of required) {
    if (!normalized.has(requiredPath)) {
      throw invalid("MSIX_RUNTIME_MISSING", `MSIX staging is missing required content: ${requiredPath}`);
    }
  }
  if (normalized.has("AppxManifest.xml") || normalized.has("quickhack-msix-build.json")) {
    throw invalid("MSIX_STAGING_STALE", "MSIX staging must not inject generated manifest or provenance files.");
  }
  return true;
}

export function createMsixLayout(input) {
  const sourceDirectory = path.resolve(String(input?.sourceDirectory ?? ""));
  const visualAssetsDirectory = path.resolve(String(input?.visualAssetsDirectory ?? ""));
  if (!existsSync(sourceDirectory)) throw invalid("MSIX_STAGING_MISSING", "MSIX staging directory was not found.");
  if (!existsSync(visualAssetsDirectory)) throw invalid("MSIX_BRANDING_MISSING", "MSIX visual asset directory was not found.");
  const outputDirectory = assertSafeOutputPath(input?.outputDirectory, sourceDirectory);
  const config = msixArtifactConfig(input?.target, {
    publisher: input?.publisher,
    preview: input?.preview === true,
  });
  const semanticVersion = String(input?.version ?? "").trim();
  const msixVersion = msixVersionFromSemver(semanticVersion, { revision: input?.revision });
  const sourceCommit = String(input?.sourceCommit ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw invalid("MSIX_PROVENANCE_INVALID", "MSIX source commit must be a 40-character Git object id.");
  }
  const sourceDirty = input?.sourceDirty === true;
  const includeServices = input?.includeServices === true;
  assertRegularTree(sourceDirectory);
  assertRegularTree(visualAssetsDirectory);
  const sourceInventory = createPackageInventory(sourceDirectory, { exclude: [] });
  assertMsixStagingContent(config, sourceInventory.entries.map((entry) => entry.path));

  const visualManifestPath = path.join(visualAssetsDirectory, "visual-assets.manifest.json");
  if (!existsSync(visualManifestPath)) {
    throw invalid("MSIX_BRANDING_MISSING", "Generated visual asset manifest was not found.");
  }
  const visualManifestBytes = readFileSync(visualManifestPath);
  const visualManifest = JSON.parse(
    visualManifestBytes.toString("utf8").replace(/^\uFEFF/u, "")
  );

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  cpSync(sourceDirectory, outputDirectory, { recursive: true, force: true, dereference: false });
  cpSync(visualAssetsDirectory, path.join(outputDirectory, "Assets"), {
    recursive: true,
    force: true,
    dereference: false,
  });
  writeFileSync(
    path.join(outputDirectory, "AppxManifest.xml"),
    renderAppxManifest({
      target: config.packageTarget,
      publisher: config.publisher,
      version: semanticVersion,
      msixVersion,
      includeServices,
      includeServerSetup: input?.includeServerSetup === true,
      allowPreviewServices: input?.allowPreviewServices === true,
      preview: config.preview,
    }),
    "utf8"
  );
  const evidence = Object.freeze({
    schemaVersion: 1,
    artifactKind: config.artifactKind,
    packageTarget: config.packageTarget,
    identityName: config.identityName,
    applicationId: config.applicationId,
    publisher: config.publisher,
    semanticVersion,
    msixVersion,
    architecture: config.architecture,
    minimumOsVersion: config.minimumOsVersion,
    sourceCommit,
    sourceDirty,
    stagingInventorySha256: sourceInventory.sha256,
    brandingRevision: visualManifest.brandingRevision,
    visualAssetManifestSha256: createHash("sha256").update(visualManifestBytes).digest("hex"),
    runtime: config.runtime,
    serviceExtensions: includeServices,
    serverSetup: input?.includeServerSetup === true,
    preview: config.preview,
  });
  writeFileSync(
    path.join(outputDirectory, "quickhack-msix-build.json"),
    canonicalJson(evidence),
    "utf8"
  );
  return Object.freeze({ outputDirectory, config, evidence });
}

function parseArguments(argv) {
  const result = {};
  for (const argument of argv) {
    if (argument === "--source-dirty") result.sourceDirty = true;
    else if (argument === "--preview") result.preview = true;
    else if (argument === "--include-services") result.includeServices = true;
    else if (argument === "--include-server-setup") result.includeServerSetup = true;
    else if (argument === "--allow-preview-services") result.allowPreviewServices = true;
    else if (argument.startsWith("--") && argument.includes("=")) {
      const [name, ...valueParts] = argument.slice(2).split("=");
      result[name.replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = valueParts.join("=");
    } else throw new Error(`Unsupported MSIX layout argument: ${argument}`);
  }
  return {
    target: result.target,
    version: result.version,
    revision: result.revision === undefined ? undefined : Number(result.revision),
    publisher: result.publisher,
    sourceDirectory: result.sourceDir,
    outputDirectory: result.outputDir,
    visualAssetsDirectory: result.visualAssetsDir,
    sourceCommit: result.sourceCommit,
    sourceDirty: result.sourceDirty === true,
    includeServices: result.includeServices === true,
    includeServerSetup: result.includeServerSetup === true,
    allowPreviewServices: result.allowPreviewServices === true,
    preview: result.preview === true,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = createMsixLayout(parseArguments(process.argv.slice(2)));
  console.log(`QuickHack MSIX layout created: ${result.outputDirectory}`);
}
