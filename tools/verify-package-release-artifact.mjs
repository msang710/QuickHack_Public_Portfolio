#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packageReleaseVariant } from "../packaging/package-release-matrix.mjs";
import { assertPackageManifest } from "../packaging/common/package-manifest.mjs";

function invalid(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid("INVALID_RELEASE_ARGUMENT", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizedReleaseVersion(value) {
  const version = requiredString(value, "releaseVersion").replace(/^v(?=\d)/u, "");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw invalid("INVALID_RELEASE_VERSION", `unsupported release version: ${value}`);
  }
  return version;
}

function sha256(filename) {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function exactRegularFiles(directory, expectedNames) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const unsupported = entries.filter((entry) => !entry.isFile());
  if (unsupported.length > 0) {
    throw invalid(
      "UNSUPPORTED_RELEASE_ENTRY",
      `release directory contains a nested, linked, or non-regular entry: ${unsupported.map((entry) => entry.name).join(", ")}`
    );
  }
  const actualNames = entries.map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expected)) {
    throw invalid(
      "RELEASE_FILE_SET_MISMATCH",
      `expected [${expected.join(", ")}], received [${actualNames.join(", ")}]`
    );
  }
}

function checksumEntries(filename) {
  const lines = fs.readFileSync(filename, "ascii").split(/\r?\n/u).filter(Boolean);
  const entries = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line);
    if (!match) {
      throw invalid("INVALID_CHECKSUM_FILE", `invalid SHA-256 line: ${line}`);
    }
    if (entries.has(match[2])) {
      throw invalid("INVALID_CHECKSUM_FILE", `duplicate checksum entry: ${match[2]}`);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function verifyPackageReleaseArtifact({
  artifactDirectory,
  platform,
  target,
  releaseVersion,
}) {
  const normalizedPlatform = requiredString(platform, "platform").toLowerCase();
  const normalizedTarget = requiredString(target, "target").toLowerCase();
  const version = normalizedReleaseVersion(releaseVersion);
  const release = packageReleaseVariant(normalizedPlatform, normalizedTarget, version);
  const directory = path.resolve(requiredString(artifactDirectory, "artifactDirectory"));
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw invalid("MISSING_RELEASE_DIRECTORY", `release directory was not found: ${directory}`);
  }

  const expectedNames = [
    release.artifactFileName,
    release.manifestFileName,
    release.checksumFileName,
  ];
  exactRegularFiles(directory, expectedNames);

  const manifestPath = path.join(directory, release.manifestFileName);
  let manifestValue;
  try {
    manifestValue = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw invalid("INVALID_PACKAGE_MANIFEST", `package manifest is not valid JSON: ${error.message}`);
  }
  const manifest = assertPackageManifest(manifestValue);
  const expectedManifestPlatform = normalizedPlatform === "windows" ? "win32" : "linux";
  if (
    manifest.version !== version ||
    manifest.platform !== expectedManifestPlatform ||
    manifest.packageTarget !== normalizedTarget ||
    manifest.artifactKind !== release.artifactKind
  ) {
    throw invalid(
      "PACKAGE_MANIFEST_IDENTITY_MISMATCH",
      `manifest does not match ${normalizedPlatform}/${normalizedTarget}/${version}`
    );
  }

  const checksumPath = path.join(directory, release.checksumFileName);
  const checksums = checksumEntries(checksumPath);
  const expectedChecksumNames = [release.artifactFileName, release.manifestFileName].sort();
  if (JSON.stringify([...checksums.keys()].sort()) !== JSON.stringify(expectedChecksumNames)) {
    throw invalid(
      "CHECKSUM_FILE_SET_MISMATCH",
      `checksum file must cover exactly [${expectedChecksumNames.join(", ")}]`
    );
  }
  for (const [fileName, expectedDigest] of checksums) {
    const actualDigest = sha256(path.join(directory, fileName));
    if (actualDigest !== expectedDigest) {
      throw invalid("PACKAGE_ARTIFACT_DIGEST_MISMATCH", `${fileName} does not match its SHA-256 checksum`);
    }
  }

  return Object.freeze({
    platform: normalizedPlatform,
    target: normalizedTarget,
    releaseVersion: version,
    artifactKind: release.artifactKind,
    files: Object.freeze(expectedNames),
  });
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    if (separator < 0) throw invalid("INVALID_RELEASE_ARGUMENT", `expected --name=value: ${argument}`);
    const key = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (key === "--artifact-dir") options.artifactDirectory = value;
    else if (key === "--platform") options.platform = value;
    else if (key === "--target") options.target = value;
    else if (key === "--release-version") options.releaseVersion = value;
    else throw invalid("INVALID_RELEASE_ARGUMENT", `unknown argument: ${key}`);
  }
  return options;
}

const directInvocation = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (directInvocation) {
  const result = verifyPackageReleaseArtifact(parseArguments(process.argv.slice(2)));
  console.log(
    `Verified ${result.platform}/${result.target} release ${result.releaseVersion} (${result.files.length} files).`
  );
}
