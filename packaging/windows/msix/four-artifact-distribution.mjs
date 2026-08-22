import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QUICKHACK_MSIX_TARGETS, msixArtifactConfig } from "./msix-artifact-config.mjs";

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8").replace(/^\uFEFF/u, ""));
}

function expectedFiles(version) {
  const result = new Map();
  for (const target of QUICKHACK_MSIX_TARGETS) {
    const prefix = msixArtifactConfig(target).installerFilePrefix;
    result.set(target, Object.freeze({
      package: `${target}/${prefix}-${version}.msix`,
      manifest: `${target}/${prefix}-msix-manifest-${version}.json`,
      checksum: `${target}/${prefix}-SHA256SUMS.txt`,
    }));
  }
  return result;
}

function regularInventory(rootDirectory) {
  const pending = [rootDirectory];
  const entries = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) {
        throw failure("MSIX_FOUR_ARTIFACT_INVENTORY_INVALID", "Four-artifact output must not contain symbolic links.");
      }
      if (stat.isDirectory()) pending.push(filename);
      else if (stat.isFile()) entries.push(path.relative(rootDirectory, filename).split(path.sep).join("/"));
      else throw failure("MSIX_FOUR_ARTIFACT_INVENTORY_INVALID", "Four-artifact output contains a non-regular entry.");
    }
  }
  return entries.sort();
}

function parseChecksums(filename) {
  const result = new Map();
  const lines = readFileSync(filename, "utf8").replace(/^\uFEFF/u, "").trim().split(/\r?\n/u);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line);
    if (!match || result.has(match[2])) {
      throw failure("MSIX_FOUR_ARTIFACT_CHECKSUM_INVALID", "MSIX checksum sidecar is not canonical.");
    }
    result.set(match[2], match[1]);
  }
  return result;
}

export function verifyFourMsixDistribution(input) {
  const rootDirectory = path.resolve(String(input?.directory ?? ""));
  const version = String(input?.version ?? "").trim();
  if (!version || !existsSync(rootDirectory) || !lstatSync(rootDirectory).isDirectory()) {
    throw failure("MSIX_FOUR_ARTIFACT_INVENTORY_INVALID", "Four-artifact directory and version are required.");
  }
  const expected = expectedFiles(version);
  const expectedInventory = [...expected.values()].flatMap((entry) => Object.values(entry)).sort();
  const observedInventory = regularInventory(rootDirectory);
  if (
    observedInventory.length !== expectedInventory.length ||
    observedInventory.some((entry, index) => entry !== expectedInventory[index])
  ) {
    throw failure(
      "MSIX_FOUR_ARTIFACT_INVENTORY_INVALID",
      `Expected exact four MSIX outputs and eight sidecars; observed: ${observedInventory.join(", ")}`
    );
  }

  const sourceCommits = new Set();
  const publishers = new Set();
  const signingModes = new Set();
  for (const [target, files] of expected) {
    const packagePath = path.join(rootDirectory, ...files.package.split("/"));
    const manifestPath = path.join(rootDirectory, ...files.manifest.split("/"));
    const checksumPath = path.join(rootDirectory, ...files.checksum.split("/"));
    const manifest = readJson(manifestPath);
    if (
      manifest.schemaVersion !== 1 ||
      manifest.packageTarget !== target ||
      manifest.semanticVersion !== version ||
      manifest.packageFile !== path.basename(packagePath) ||
      manifest.packageSha256 !== sha256(packagePath)
    ) {
      throw failure("MSIX_FOUR_ARTIFACT_MANIFEST_INVALID", `MSIX sidecar does not match ${target}.`);
    }
    if (!/^[a-f0-9]{40}$/u.test(manifest.sourceCommit)) {
      throw failure("MSIX_FOUR_ARTIFACT_MANIFEST_INVALID", `MSIX source revision is invalid for ${target}.`);
    }
    if (manifest.sourceDirty === true && input?.allowDirtySource !== true) {
      throw failure("MSIX_FOUR_ARTIFACT_SOURCE_DIRTY", `MSIX source is dirty for ${target}.`);
    }
    const checksums = parseChecksums(checksumPath);
    if (
      checksums.size !== 2 ||
      checksums.get(path.basename(packagePath)) !== sha256(packagePath) ||
      checksums.get(path.basename(manifestPath)) !== sha256(manifestPath)
    ) {
      throw failure("MSIX_FOUR_ARTIFACT_CHECKSUM_INVALID", `MSIX checksums do not match ${target}.`);
    }
    sourceCommits.add(manifest.sourceCommit);
    publishers.add(manifest.publisher);
    signingModes.add(manifest.signingMode);
  }
  if (sourceCommits.size !== 1 || publishers.size !== 1 || signingModes.size !== 1) {
    throw failure("MSIX_FOUR_ARTIFACT_PROVENANCE_MISMATCH", "Four MSIX outputs do not share one provenance contract.");
  }
  return Object.freeze({
    schemaVersion: 1,
    packageCount: QUICKHACK_MSIX_TARGETS.length,
    sidecarCount: expectedInventory.length - QUICKHACK_MSIX_TARGETS.length,
    sourceCommit: [...sourceCommits][0],
    publisher: [...publishers][0],
    signingMode: [...signingModes][0],
  });
}

function parseArguments(argv) {
  const result = {};
  for (const argument of argv) {
    if (argument === "--allow-dirty-source") result.allowDirtySource = true;
    else if (argument.startsWith("--") && argument.includes("=")) {
      const [name, ...parts] = argument.slice(2).split("=");
      result[name.replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = parts.join("=");
    } else throw new TypeError(`Unsupported four-artifact verifier argument: ${argument}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyFourMsixDistribution(parseArguments(process.argv.slice(2)));
  console.log(`QuickHack exact-four MSIX distribution verified: ${JSON.stringify(result)}`);
}
