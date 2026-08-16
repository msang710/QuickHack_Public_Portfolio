import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { packageArtifactContract } from "../package-artifact-contract.mjs";

function packageError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  return error;
}

function slash(value) {
  return value.split(path.sep).join("/");
}

export function createPackageInventory(rootDirectory, options = {}) {
  const root = path.resolve(rootDirectory);
  const excluded = new Set((options.exclude ?? ["quickhack-package.json"]).map(String));
  const entries = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const relativePath = slash(path.relative(root, filename));
      if (excluded.has(relativePath)) continue;
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) {
        throw packageError("PACKAGE_ARTIFACT_INVALID", "Package inventory does not follow symbolic links.", { path: relativePath });
      }
      if (stat.isDirectory()) pending.push(filename);
      else if (stat.isFile()) {
        entries.push(Object.freeze({
          path: relativePath,
          size: stat.size,
          sha256: createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
        }));
      }
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const canonical = entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join("");
  return Object.freeze({
    entries: Object.freeze(entries),
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
}

const CLIENT_FORBIDDEN = Object.freeze([
  /(^|\/)quickhack_server\//u,
  /(^|\/)mock_server\//u,
  /(^|\/)prisma\//u,
  /(^|\/)tools\/(?:server-console|postgresql-|quickhack-operator|qhkey-)/u,
]);
const OPERATIONAL_FORBIDDEN = Object.freeze([
  /(^|\/)mock_server\//u,
  /mock-runtime/u,
  /server-console-demonstration/u,
  /server-console-qhkey-demonstration/u,
]);
const DEMONSTRATION_FORBIDDEN = Object.freeze([
  /server-console-operational/u,
  /server-console-qhkey-operational/u,
  /live-credential/u,
]);

export function findPackageContentViolations(artifactValue, inventoryEntries) {
  const artifact = packageArtifactContract(artifactValue);
  const patterns = artifact.role === "client"
    ? CLIENT_FORBIDDEN
    : artifact.packageFlavor === "OPERATIONAL"
      ? OPERATIONAL_FORBIDDEN
      : DEMONSTRATION_FORBIDDEN;
  const violations = [];
  for (const entry of inventoryEntries ?? []) {
    const relativePath = String(typeof entry === "string" ? entry : entry?.path ?? "").replaceAll("\\", "/");
    const pattern = patterns.find((candidate) => candidate.test(relativePath));
    if (pattern) violations.push(Object.freeze({ artifactKind: artifact.artifactKind, path: relativePath }));
  }
  return Object.freeze(violations);
}

export function assertPackageContentPolicy(artifactValue, inventoryEntries) {
  const violations = findPackageContentViolations(artifactValue, inventoryEntries);
  if (violations.length > 0) {
    throw packageError("PACKAGE_CONTENT_FORBIDDEN", "Package inventory contains role or flavor forbidden content.", { violations });
  }
  return inventoryEntries;
}
