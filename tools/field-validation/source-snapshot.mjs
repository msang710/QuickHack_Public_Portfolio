import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { createChildProcessEnvironment } from "../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../quickhack_shared/platform/linux/child-process-policy.mjs";

function git(root, args) {
  const env = createChildProcessEnvironment({ policy: createLinuxChildProcessPolicy(), source: process.env });
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env });
}

export function sourceRevision(root = process.cwd()) {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (!git(root, ["status", "--porcelain", "-z", "--untracked-files=all"])) return head;

  const paths = [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean))].sort();
  const snapshot = createHash("sha256");
  for (const relativePath of paths) {
    const filename = path.join(root, relativePath);
    let stat;
    try { stat = lstatSync(filename); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      snapshot.update(`${relativePath}\0deleted\0`);
      continue;
    }
    snapshot.update(`${relativePath}\0${(stat.mode & 0o777).toString(8)}\0`);
    if (stat.isSymbolicLink()) snapshot.update(`link\0${readlinkSync(filename)}\0`);
    else if (stat.isFile()) snapshot.update("file\0").update(createHash("sha256").update(readFileSync(filename)).digest("hex")).update("\0");
    else snapshot.update("other\0");
  }
  return `${head}+worktree-sha256:${snapshot.digest("hex")}`;
}
