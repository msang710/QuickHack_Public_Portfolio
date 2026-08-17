import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageReleaseVariant } from "../package-release-matrix.mjs";
import { LINUX_PACKAGE_TARGETS, linuxArtifactConfig } from "./linux-artifact-config.mjs";

if (process.platform !== "linux") throw new Error("Arch package builds require a CachyOS/Arch Linux host.");
const target = process.argv.slice(2).find((value) => value.startsWith("--target="))?.slice(9) || "demo-server";
const version = process.argv.slice(2).find((value) => value.startsWith("--version="))?.slice(10) || "";
if (!version) throw new TypeError("--version is required.");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..", "..");
linuxArtifactConfig(target);
const archDirectory = path.join(scriptDirectory, "arch");
for (const stagingTarget of LINUX_PACKAGE_TARGETS) {
  const staging = spawnSync(process.execPath, [
    path.join(scriptDirectory, "create-staging-package.mjs"),
    `--target=${stagingTarget}`,
    `--version=${version}`,
  ], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (staging.status !== 0) throw new Error(`Linux staging failed: ${stagingTarget}.`);
}
const result = spawnSync("/usr/bin/makepkg", ["--cleanbuild", "--clean", "--force", "--noconfirm"], {
  cwd: archDirectory,
  env: { ...process.env, QUICKHACK_PKGVER: version },
  stdio: "inherit",
  shell: false,
});
if (result.status !== 0) throw new Error("makepkg failed to create the QuickHack split packages.");
const builtFiles = readdirSync(archDirectory);
for (const outputTarget of LINUX_PACKAGE_TARGETS) {
  const outputConfig = linuxArtifactConfig(outputTarget);
  const release = packageReleaseVariant("linux", outputTarget, version);
  const packagePrefix = `${outputConfig.installedIdentity}-${version}-`;
  const built = builtFiles.find(
    (name) => name.startsWith(packagePrefix) && name.endsWith("-x86_64.pkg.tar.zst")
  );
  if (!built) {
    throw new Error(`Built package was not found for ${outputConfig.installedIdentity}.`);
  }
  const output = path.join(root, ...release.distributionRoot.split("/"));
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const artifactPath = path.join(output, release.artifactFileName);
  const manifestPath = path.join(output, release.manifestFileName);
  const checksumPath = path.join(output, release.checksumFileName);
  cpSync(path.join(archDirectory, built), artifactPath);
  cpSync(
    path.join(
      root,
      ...release.stagingRoot.split("/"),
      "pkgroot",
      ...outputConfig.applicationRoot.split("/").filter(Boolean),
      "quickhack-package.json"
    ),
    manifestPath
  );
  const lines = [artifactPath, manifestPath].map((filename) => {
    const digest = createHash("sha256").update(requireRead(filename)).digest("hex");
    return `${digest}  ${path.basename(filename)}`;
  });
  writeFileSync(checksumPath, `${lines.join("\n")}\n`, "ascii");
}

function requireRead(filename) {
  if (!existsSync(filename)) throw new Error(`Release file was not found: ${filename}`);
  return readFileSync(filename);
}
