import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUICKHACK_MSIX_TARGETS,
  assertProductionMsixPublisher,
} from "./msix-artifact-config.mjs";

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function validateWindowsReleaseRequest(value, options = {}) {
  const expectedKeys = [
    "schemaVersion",
    "attempt",
    "version",
    "tag",
    "sourceCommit",
    "targets",
    "publisher",
    "signingProvider",
    "prerelease",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, expectedKeys)) {
    throw failure("WINDOWS_RELEASE_REQUEST_INVALID", "Release request fields are not exact.");
  }
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.attempt) || value.attempt < 1) {
    throw failure("WINDOWS_RELEASE_REQUEST_INVALID", "Release request schema or attempt is invalid.");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(value.version) || value.tag !== `windows-v${value.version}`) {
    throw failure("WINDOWS_RELEASE_REQUEST_INVALID", "Release version and immutable tag do not match.");
  }
  if (!/^[a-f0-9]{40}$/u.test(value.sourceCommit)) {
    throw failure("WINDOWS_RELEASE_REQUEST_INVALID", "Release source commit must be exact.");
  }
  if (JSON.stringify(value.targets) !== JSON.stringify(QUICKHACK_MSIX_TARGETS)) {
    throw failure("WINDOWS_RELEASE_REQUEST_INVALID", "A Windows release requires the exact four MSIX targets.");
  }
  assertProductionMsixPublisher(value.publisher);
  if (!["AZURE_ARTIFACT_SIGNING", "CA_CERTIFICATE"].includes(value.signingProvider)) {
    throw failure("WINDOWS_RELEASE_REQUEST_INVALID", "Release signing provider is unsupported.");
  }
  if (value.prerelease !== false) {
    throw failure("WINDOWS_RELEASE_REQUEST_INVALID", "Production Windows release must not be a prerelease.");
  }

  const historic = Array.isArray(options.historicRequests) ? [...options.historicRequests] : [];
  let ignoredCurrent = false;
  for (const entry of historic) {
    const request = entry?.request;
    if (!request || typeof request !== "object") continue;
    const sameCurrent =
      !ignoredCurrent &&
      entry.path === options.currentPath &&
      JSON.stringify(request) === JSON.stringify(value);
    if (sameCurrent) {
      ignoredCurrent = true;
      continue;
    }
    if (request.version === value.version || request.tag === value.tag) {
      throw failure(
        "WINDOWS_RELEASE_IDENTITY_REUSED",
        `Release version or tag was already requested in Git history: ${value.tag}`
      );
    }
  }
  return Object.freeze({ ...value, targets: Object.freeze([...value.targets]) });
}

function runGit(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw failure("WINDOWS_RELEASE_HISTORY_UNAVAILABLE", "Git release-request history could not be read.");
  }
  return result.stdout;
}

export function collectHistoricWindowsReleaseRequests(repositoryRoot) {
  const output = runGit(repositoryRoot, [
    "log",
    "--all",
    "--format=__COMMIT__%H",
    "--diff-filter=A",
    "--name-only",
    "--",
    "release-requests/windows-msix",
  ]);
  const entries = [];
  let commit = "";
  for (const line of output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    if (line.startsWith("__COMMIT__")) {
      commit = line.slice("__COMMIT__".length);
      continue;
    }
    if (!commit || !/^release-requests\/windows-msix\/[^/]+\.json$/u.test(line)) continue;
    try {
      const request = JSON.parse(runGit(repositoryRoot, ["show", `${commit}:${line}`]));
      entries.push(Object.freeze({ commit, path: line, request }));
    } catch {
      throw failure("WINDOWS_RELEASE_HISTORY_INVALID", `Historic release request is invalid: ${commit}:${line}`);
    }
  }
  return Object.freeze(entries);
}

function parseArguments(argv) {
  const result = { repositoryRoot: process.cwd(), skipHistory: false };
  for (const argument of argv) {
    if (argument === "--skip-history") result.skipHistory = true;
    else if (argument.startsWith("--") && argument.includes("=")) {
      const [name, ...parts] = argument.slice(2).split("=");
      result[name.replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = parts.join("=");
    } else throw failure("WINDOWS_RELEASE_REQUEST_INVALID", `Unsupported argument: ${argument}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const requestPath = path.resolve(repositoryRoot, String(options.requestPath ?? ""));
  const currentPath = path.relative(repositoryRoot, requestPath).split(path.sep).join("/");
  if (!/^release-requests\/windows-msix\/[^/]+\.json$/u.test(currentPath)) {
    throw failure("WINDOWS_RELEASE_REQUEST_INVALID", "Request must be below release-requests/windows-msix/.");
  }
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  const validated = validateWindowsReleaseRequest(request, {
    currentPath,
    historicRequests: options.skipHistory ? [] : collectHistoricWindowsReleaseRequests(repositoryRoot),
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `version=${validated.version}`,
        `tag=${validated.tag}`,
        `source_commit=${validated.sourceCommit}`,
        `publisher=${validated.publisher}`,
        `signing_provider=${validated.signingProvider}`,
      ].join("\n") + "\n",
      "utf8"
    );
  }
  console.log(`QuickHack Windows release request verified: ${validated.tag}`);
}
