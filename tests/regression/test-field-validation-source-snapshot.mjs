import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runScenarioConfig } from "../../tools/field-validation/cli.mjs";
import { sourceRevision } from "../../tools/field-validation/source-snapshot.mjs";

test("source revision distinguishes dirty content and untracked source", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-source-snapshot-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init", "-q");
    writeFileSync(path.join(root, "source.txt"), "initial\n");
    git("add", "source.txt");
    git("-c", "user.name=QuickHack Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
    const clean = sourceRevision(root);
    assert.match(clean, /^[a-f0-9]{40}$/u);
    writeFileSync(path.join(root, "source.txt"), "first edit\n");
    const first = sourceRevision(root);
    assert.match(first, /^\w{40}\+worktree-sha256:[a-f0-9]{64}$/u);
    assert.notEqual(first, clean);
    writeFileSync(path.join(root, "source.txt"), "second edit\n");
    const second = sourceRevision(root);
    assert.notEqual(second, first);
    writeFileSync(path.join(root, "new-source.txt"), "new code\n");
    assert.notEqual(sourceRevision(root), second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a source change during a field run is reported as inconclusive", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-source-run-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init", "-q");
    writeFileSync(path.join(root, "source.txt"), "before\n");
    git("add", "source.txt");
    git("-c", "user.name=QuickHack Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
    const result = await runScenarioConfig({
      runId: "run", seed: "seed", scenarioId: "source-change", environment: "isolated",
      baseUrl: "http://127.0.0.1:3000", snapshotPath: "/state",
      actions: [{ id: "scan", method: "POST", path: "/pack" }], expectedState: {},
    }, {
      sourceRoot: root,
      fetchImpl: async () => {
        writeFileSync(path.join(root, "source.txt"), "after\n");
        return new Response("{}", { status: 200 });
      },
    });
    assert.equal(result.sourceSnapshotStatus, "CHANGED_DURING_RUN");
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.notEqual(result.manifest.sourceRevision, result.sourceRevisionAfter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
