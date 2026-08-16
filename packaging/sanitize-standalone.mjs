import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packagingDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(packagingDir, "..");
const sensitiveRootDirectories = [
  "backups",
  "config",
  "data",
  "database",
  "platform-tools",
  "prisma",
  "quickhack-keys",
  "release",
  "templates",
  "tools",
];
const sensitiveFileSuffixes = [
  ".db",
  ".db-shm",
  ".db-wal",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
  ".qhb",
  ".qhkey",
];

function isSensitiveFileName(fileName) {
  const normalized = fileName.toLowerCase();
  return (
    normalized.startsWith(".env") ||
    sensitiveFileSuffixes.some((suffix) => normalized.endsWith(suffix))
  );
}

function visitApplicationFiles(directory, visitor, relativeDirectory = "") {
  if (!existsSync(directory)) return;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" && entry.isDirectory()) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      visitApplicationFiles(absolutePath, visitor, relativePath);
      continue;
    }

    if (entry.isFile()) {
      visitor({ absolutePath, relativePath, fileName: entry.name });
    }
  }
}

export function findSensitiveStandaloneFiles(standaloneDir) {
  const sensitiveFiles = [];

  visitApplicationFiles(standaloneDir, ({ relativePath, fileName }) => {
    if (isSensitiveFileName(fileName)) {
      sensitiveFiles.push(relativePath.replace(/\\/g, "/"));
    }
  });

  return sensitiveFiles.sort();
}

function removeSensitiveApplicationFiles(standaloneDir) {
  visitApplicationFiles(standaloneDir, ({ absolutePath, fileName }) => {
    if (isSensitiveFileName(fileName)) {
      rmSync(absolutePath, { force: true });
    }
  });
}

export function verifyStandaloneRuntime(standaloneDir) {
  const runtimeProbe = path.join(
    standaloneDir,
    "node_modules",
    "next",
    "dist",
    "server",
    "lib",
    "router-utils",
    "filesystem.js"
  );

  if (!existsSync(runtimeProbe)) {
    throw new Error(`Next standalone runtime probe was not found: ${runtimeProbe}`);
  }

  const result = spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(runtimeProbe)})`],
    {
      cwd: standaloneDir,
      encoding: "utf8",
      windowsHide: true,
    }
  );

  if (result.error || result.status !== 0) {
    const details = [
      result.error ? String(result.error.message ?? result.error) : "",
      String(result.stderr ?? "").trim(),
      String(result.stdout ?? "").trim(),
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `Next standalone runtime dependency probe failed: ${runtimeProbe}` +
        (details ? `\n${details}` : "")
    );
  }

  return runtimeProbe;
}

export function sanitizeStandaloneOutput({
  rootDir = defaultRootDir,
  distDir = path.resolve(
    rootDir,
    String(process.env.QUICKHACK_NEXT_DIST_DIR || ".next").trim() || ".next"
  ),
} = {}) {
  const resolvedRootDir = path.resolve(rootDir);
  const resolvedDistDir = path.resolve(distDir);
  const relativeDistDir = path.relative(resolvedRootDir, resolvedDistDir);

  if (
    !relativeDistDir ||
    relativeDistDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDistDir)
  ) {
    throw new Error(
      `Next distDir must stay inside the QuickHack project root: ${resolvedDistDir}`
    );
  }

  const standaloneDir = path.join(resolvedDistDir, "standalone");
  const staticSourceDir = path.join(resolvedDistDir, "static");
  const staticTargetDir = path.join(
    standaloneDir,
    relativeDistDir,
    "static"
  );

  if (!existsSync(path.join(standaloneDir, "server.js"))) {
    throw new Error(`Next standalone output was not found: ${standaloneDir}`);
  }

  if (!existsSync(staticSourceDir)) {
    throw new Error(`Next static output was not found: ${staticSourceDir}`);
  }

  for (const tracedDirectory of sensitiveRootDirectories) {
    rmSync(path.join(standaloneDir, tracedDirectory), {
      recursive: true,
      force: true,
    });
  }
  removeSensitiveApplicationFiles(standaloneDir);

  rmSync(staticTargetDir, { recursive: true, force: true });
  cpSync(staticSourceDir, staticTargetDir, { recursive: true, force: true });

  const publicSourceDir = path.join(rootDir, "public");
  const publicTargetDir = path.join(standaloneDir, "public");
  rmSync(publicTargetDir, { recursive: true, force: true });
  if (existsSync(publicSourceDir)) {
    cpSync(publicSourceDir, publicTargetDir, { recursive: true, force: true });
  }

  const sensitiveFiles = findSensitiveStandaloneFiles(standaloneDir);
  if (sensitiveFiles.length > 0) {
    throw new Error(
      `Sensitive runtime files remain in the standalone output:\n${sensitiveFiles.join("\n")}`
    );
  }

  verifyStandaloneRuntime(standaloneDir);

  return { standaloneDir, sensitiveFiles };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  sanitizeStandaloneOutput();
  console.log(
    "Standalone output prepared and verified: runtime dependencies are loadable, and runtime data, credentials, and local tools are absent."
  );
}
