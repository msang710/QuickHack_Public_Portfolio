import { readdirSync } from "node:fs";
import path from "node:path";

export const RUNTIME_PACKAGE_FORBIDDEN_SOURCE_DIRECTORIES = Object.freeze([
  ".agents",
  ".tmp",
  "generated",
  "portfolio",
  "reports",
  "screenshots",
  "specs",
  "test-results",
  "tests",
]);

export const RUNTIME_PACKAGE_ROLE_FORBIDDEN_ADAPTER_PREFIXES = Object.freeze({
  "demo-server": Object.freeze([
    Object.freeze({ prefix: "quickhack_desktop/", ownerRole: "client" }),
    Object.freeze({
      prefix: "quickhack_client/platform/windows/",
      ownerRole: "client",
    }),
    Object.freeze({
      prefix: "quickhack_client/platform/linux/",
      ownerRole: "client",
    }),
  ]),
  "demo-client": Object.freeze([
    Object.freeze({
      prefix: "quickhack_server/platform/windows/",
      ownerRole: "server",
    }),
    Object.freeze({
      prefix: "quickhack_server/platform/linux/",
      ownerRole: "server",
    }),
    Object.freeze({
      prefix: "tools/platform/linux/systemd-credential",
      ownerRole: "operator",
    }),
  ]),
  "demonstration-server": Object.freeze([
    Object.freeze({ prefix: "quickhack_desktop/", ownerRole: "client" }),
    Object.freeze({ prefix: "quickhack_client/platform/windows/", ownerRole: "client" }),
    Object.freeze({ prefix: "quickhack_client/platform/linux/", ownerRole: "client" }),
  ]),
  "operational-server": Object.freeze([
    Object.freeze({ prefix: "quickhack_desktop/", ownerRole: "client" }),
    Object.freeze({ prefix: "quickhack_client/platform/windows/", ownerRole: "client" }),
    Object.freeze({ prefix: "quickhack_client/platform/linux/", ownerRole: "client" }),
  ]),
  "demonstration-client": Object.freeze([
    Object.freeze({ prefix: "quickhack_server/platform/windows/", ownerRole: "server" }),
    Object.freeze({ prefix: "quickhack_server/platform/linux/", ownerRole: "server" }),
    Object.freeze({ prefix: "tools/platform/linux/systemd-credential", ownerRole: "operator" }),
  ]),
  "operational-client": Object.freeze([
    Object.freeze({ prefix: "quickhack_server/platform/windows/", ownerRole: "server" }),
    Object.freeze({ prefix: "quickhack_server/platform/linux/", ownerRole: "server" }),
    Object.freeze({ prefix: "tools/platform/linux/systemd-credential", ownerRole: "operator" }),
  ]),
});

const forbiddenDirectories = new Set(
  RUNTIME_PACKAGE_FORBIDDEN_SOURCE_DIRECTORIES.map((entry) => entry.toLowerCase())
);
const testSourcePattern = /^test-.*\.(?:mjs|js|ts|tsx|mts|cts|ps1)$/i;

export function findRuntimePackageSourceViolations(targetDirectory) {
  const root = path.resolve(targetDirectory);
  const pending = [root];
  const violations = [];

  while (pending.length > 0) {
    const current = pending.pop();

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(root, absolutePath).replaceAll("\\", "/");
      const segments = relativePath.split("/");

      if (segments.some((segment) => segment.toLowerCase() === "node_modules")) {
        continue;
      }
      if (
        entry.isDirectory() &&
        segments.some((segment) => forbiddenDirectories.has(segment.toLowerCase()))
      ) {
        violations.push(`${relativePath}/`);
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (testSourcePattern.test(entry.name)) violations.push(relativePath);
    }
  }

  return violations.sort();
}

export function assertNoRuntimePackageSources(targetDirectory) {
  const violations = findRuntimePackageSourceViolations(targetDirectory);
  if (violations.length > 0) {
    throw new Error(
      `Development source entered the runtime package: ${violations.join(", ")}`
    );
  }
}

export function findRuntimePackageRoleViolations(packageTarget, targetDirectory) {
  const forbiddenPrefixes =
    RUNTIME_PACKAGE_ROLE_FORBIDDEN_ADAPTER_PREFIXES[packageTarget];
  if (!forbiddenPrefixes) {
    throw new TypeError(`Unknown runtime package role: ${packageTarget}.`);
  }

  const root = path.resolve(targetDirectory);
  const pending = [root];
  const violations = [];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === "node_modules") continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }

      const relativePath = path.relative(root, absolutePath).replaceAll("\\", "/");
      const normalizedPath = `/${relativePath.toLowerCase()}`;
      for (const forbidden of forbiddenPrefixes) {
        if (!normalizedPath.includes(`/${forbidden.prefix.toLowerCase()}`)) {
          continue;
        }
        violations.push(
          Object.freeze({
            target: packageTarget,
            path: relativePath,
            ownerRole: forbidden.ownerRole,
          })
        );
      }
    }
  }

  return violations.sort((left, right) => left.path.localeCompare(right.path));
}

export function assertRuntimePackageRole(packageTarget, targetDirectory) {
  const violations = findRuntimePackageRoleViolations(
    packageTarget,
    targetDirectory
  );
  if (violations.length > 0) {
    throw new Error(
      `Native adapter entered the wrong runtime package: ${violations
        .map(
          (violation) =>
            `${violation.target}:${violation.path} (owner=${violation.ownerRole})`
        )
        .join(", ")}`
    );
  }
}
