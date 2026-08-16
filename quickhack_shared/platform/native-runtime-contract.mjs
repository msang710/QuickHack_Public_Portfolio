import { PlatformCapabilityError } from "./platform-capability-error.mjs";

export const POSTGRESQL_MAJOR_VERSION = 18;

export const POSTGRESQL_TOOL_CAPABILITIES = Object.freeze({
  service: Object.freeze(["initdb", "pg_ctl", "postgres", "psql"]),
  backup: Object.freeze(["psql", "pg_dump", "pg_restore"]),
  package: Object.freeze([
    "initdb",
    "pg_ctl",
    "postgres",
    "psql",
    "pg_dump",
    "pg_restore",
  ]),
});

export const NATIVE_RUNTIME_CONTRACT = Object.freeze({
  node: Object.freeze({
    minimumMajor: 24,
    maximumExclusiveMajor: 25,
    engines: ">=24 <25",
  }),
  npm: Object.freeze({
    major: 11,
    packageManager: "npm@11.13.0",
  }),
  postgresql: Object.freeze({
    major: POSTGRESQL_MAJOR_VERSION,
    tools: POSTGRESQL_TOOL_CAPABILITIES,
  }),
  android: Object.freeze({
    jdkMajor: 17,
    gradleVersion: "8.10.2",
    agpVersion: "8.7.3",
    compileSdk: 35,
    targetSdk: 35,
  }),
});

export class NativeRuntimeContractError extends PlatformCapabilityError {
  constructor(code, message, details = undefined) {
    super(code, message, details);
    this.name = "NativeRuntimeContractError";
  }
}

function fail(code, message, details) {
  throw new NativeRuntimeContractError(code, message, details);
}

function parseSemanticMajor(value, label) {
  const normalized = String(value ?? "").trim();
  const match = normalized.match(/^v?(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/);
  if (!match) {
    fail(
      "DEPENDENCY_VERSION_MISMATCH",
      `${label} version output is invalid.`,
      { dependency: label, detectedVersion: normalized || null }
    );
  }
  return Number(match[1]);
}

export function parsePostgresqlMajorVersion(output, tool = "postgresql") {
  const normalized = String(output ?? "").trim();
  const match =
    normalized.match(/\(PostgreSQL\)\s+(\d+)(?:\.\d+)*/i) ??
    normalized.match(/\bPostgreSQL\s+(\d+)(?:\.\d+)*/i);
  if (!match) {
    fail(
      "DEPENDENCY_VERSION_MISMATCH",
      `${tool} did not report a supported PostgreSQL version.`,
      { dependency: "postgresql", tool, detectedVersion: normalized || null }
    );
  }
  return Number(match[1]);
}

export function assertPostgresqlToolVersions(
  observedVersions,
  { capability = "package" } = {}
) {
  const requiredTools = POSTGRESQL_TOOL_CAPABILITIES[capability];
  if (!requiredTools) {
    throw new TypeError(`Unknown PostgreSQL capability: ${capability}`);
  }
  if (!observedVersions || typeof observedVersions !== "object") {
    fail("DEPENDENCY_MISSING", "PostgreSQL tool observations are missing.", {
      dependency: "postgresql",
      capability,
    });
  }
  const versions = {};
  for (const tool of requiredTools) {
    if (!Object.hasOwn(observedVersions, tool)) {
      fail("DEPENDENCY_MISSING", `Required PostgreSQL tool is missing: ${tool}.`, {
        dependency: "postgresql",
        capability,
        tool,
      });
    }
    const major = parsePostgresqlMajorVersion(observedVersions[tool], tool);
    if (major !== POSTGRESQL_MAJOR_VERSION) {
      fail(
        "DEPENDENCY_VERSION_MISMATCH",
        `QuickHack requires PostgreSQL ${POSTGRESQL_MAJOR_VERSION}: ${tool} reported major ${major}.`,
        {
          dependency: "postgresql",
          capability,
          tool,
          requiredMajor: POSTGRESQL_MAJOR_VERSION,
          detectedMajor: major,
        }
      );
    }
    versions[tool] = major;
  }
  return Object.freeze({
    capability,
    major: POSTGRESQL_MAJOR_VERSION,
    tools: Object.freeze(versions),
  });
}

export function assertNativeRuntimeCapabilities(observed) {
  if (!observed || typeof observed !== "object") {
    fail("DEPENDENCY_MISSING", "Native runtime observations are missing.");
  }
  const verified = {};
  if (Object.hasOwn(observed, "node")) {
    const major = parseSemanticMajor(observed.node, "node");
    if (
      major < NATIVE_RUNTIME_CONTRACT.node.minimumMajor ||
      major >= NATIVE_RUNTIME_CONTRACT.node.maximumExclusiveMajor
    ) {
      fail("DEPENDENCY_VERSION_MISMATCH", "QuickHack requires Node.js 24.", {
        dependency: "node",
        requiredRange: NATIVE_RUNTIME_CONTRACT.node.engines,
        detectedMajor: major,
      });
    }
    verified.node = major;
  }
  if (Object.hasOwn(observed, "npm")) {
    const major = parseSemanticMajor(observed.npm, "npm");
    if (major !== NATIVE_RUNTIME_CONTRACT.npm.major) {
      fail("DEPENDENCY_VERSION_MISMATCH", "QuickHack requires npm 11.", {
        dependency: "npm",
        requiredMajor: NATIVE_RUNTIME_CONTRACT.npm.major,
        detectedMajor: major,
      });
    }
    verified.npm = major;
  }
  if (observed.postgresql) {
    verified.postgresql = assertPostgresqlToolVersions(
      observed.postgresql.versions,
      { capability: observed.postgresql.capability }
    );
  }
  return Object.freeze(verified);
}
