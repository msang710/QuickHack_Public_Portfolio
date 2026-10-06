import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = mkdtempSync(path.join(os.tmpdir(), "quickhack-alpm-hook-"));
const root = path.join(workspace, "root");
const hookDirectory = path.join(root, "usr", "share", "libalpm", "hooks");
const packageDirectory = path.join(workspace, "package");
mkdirSync(root);
mkdirSync(hookDirectory, { recursive: true });
mkdirSync(packageDirectory);
mkdirSync(path.join(workspace, "db"));
mkdirSync(path.join(workspace, "cache"));

function packageArchive(name) {
  writeFileSync(path.join(packageDirectory, ".PKGINFO"), [
    `pkgname = ${name}`, "pkgver = 1-1", "pkgdesc = QuickHack isolated ALPM hook parser fixture",
    "arch = any", "builddate = 1", "packager = QuickHack test", "size = 0", "",
  ].join("\n"));
  const archive = path.join(workspace, `${name}-1-1-any.pkg.tar`);
  const result = spawnSync("bsdtar", ["-cf", archive, "-C", packageDirectory, ".PKGINFO"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const query = spawnSync("pacman", ["-Qp", archive], { encoding: "utf8" });
  assert.equal(query.status, 0, query.stderr || query.error?.message);
  return archive;
}

function install(archive) {
  return spawnSync("pacman", [
    "--root", root, "--dbpath", path.join(workspace, "db"),
    "--cachedir", path.join(workspace, "cache"), "--logfile", path.join(workspace, "pacman.log"),
    "--noconfirm", "--nodeps", "-U", archive,
  ], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
}

try {
  const source = readFileSync(new URL("../../../packaging/linux/arch/quickhack-upgrade-reconcile.hook.in", import.meta.url), "utf8");
  const rendered = source
    .replaceAll("@QUICKHACK_INSTALLED_IDENTITY@", "quickhack-hook-never-matches")
    .replaceAll("@QUICKHACK_PACKAGE_FLAVOR@", "test")
    .replaceAll("@QUICKHACK_LIFECYCLE_LOCK@", "/run/quickhack-test.lock")
    .replaceAll("@QUICKHACK_NODE_EXECUTABLE@", "/usr/bin/node")
    .replaceAll("@QUICKHACK_UPGRADE_ENTRY@", "/usr/lib/quickhack/upgrade-reconcile.mjs")
    .replaceAll("@QUICKHACK_ARTIFACT_KIND@", "DEMONSTRATION_SERVER");
  const hook = path.join(hookDirectory, "quickhack-upgrade-reconcile.hook");
  writeFileSync(hook, rendered);
  const valid = install(packageArchive("quickhack-hook-valid-fixture"));
  assert.equal(valid.status, 0, valid.stderr || valid.error?.message);

  writeFileSync(hook, rendered
    .replace("Operation = Upgrade", "Operation = Install")
    .replace("Target = quickhack-hook-never-matches", "Target = quickhack-hook-invalid-fixture")
    .replace("When = PostTransaction", "When = PostTransaction\nNetworkAccess = allowed"));
  const invalid = install(packageArchive("quickhack-hook-invalid-fixture"));
  assert.notEqual(invalid.status, 0, "ALPM accepted an unsupported action option.");
  assert.match(`${invalid.stderr}\n${invalid.stdout}`, /invalid option|hook.*failed|failed.*hook/iu);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log("ALPM parses the QuickHack hook and rejects unsupported action options in an isolated root.");
