import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWindowsLegacyMsixMigration, WINDOWS_LEGACY_MSIX_MIGRATION_STEPS } from "../../tools/windows-legacy-msix-migration.mjs";
import { createFileLegacyMigrationJournal } from "../../tools/platform/windows/legacy-msix-migration-journal.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "quickhack-legacy-migration-"));
const calls = [];
const observed = new Map();
let failOnce = true;
const snapshot = {
  schemaVersion: 1,
  stateExists: true,
  stateRoot: "C:\\ProgramData\\QuickHack\\demonstration-server",
  inventorySha256: "a".repeat(64),
  legacyInstallRoot: "C:\\Program Files\\QuickHack Demo Server",
  legacyUninstaller: "C:\\Program Files\\QuickHack Demo Server\\unins000.exe",
  legacyServices: ["QuickHackDemoPostgreSQL", "QuickHackDemoServerConsole"],
};
const adapter = {
  async probe(step) {
    calls.push(`probe:${step.id}`);
    if (step.id === "DISCOVER") {
      return {
        ready: true,
        discovery: {
          classification: "COMPATIBLE",
          reasonCode: "LEGACY_INNO_INSTALL_COMPATIBLE",
          mode: "INSTALLED_INNO",
        },
      };
    }
    return { ready: observed.get(step.id) === true };
  },
  async mutate(step) {
    calls.push(`mutate:${step.id}`);
    if (step.id === "SNAPSHOT") {
      observed.set(step.id, true);
      return { snapshot };
    }
    if (step.id === "ATTACH_STATE" && failOnce) {
      failOnce = false;
      const error = new Error("fixture interruption");
      error.code = "STATE_ATTACH_INTERRUPTED";
      throw error;
    }
    observed.set(step.id, true);
    return {};
  },
  async postcondition(step) {
    calls.push(`post:${step.id}`);
    return { ready: observed.get(step.id) === true };
  },
};
const journal = createFileLegacyMigrationJournal({
  artifactKind: "DEMONSTRATION_SERVER",
  rootDirectory: path.join(temporary, "journal"),
  clock: () => new Date("2026-08-22T00:00:00.000Z"),
});
const migration = createWindowsLegacyMsixMigration({
  artifactKind: "DEMONSTRATION_SERVER",
  adapter,
  journal,
});

await assert.rejects(() => migration.run(), (error) => error.code === "STATE_ATTACH_INTERRUPTED");
const interrupted = await journal.read();
assert.equal(interrupted.error.code, "STATE_ATTACH_INTERRUPTED");
assert.equal(interrupted.snapshot.inventorySha256, "a".repeat(64));
assert.equal(interrupted.completedSteps.includes("ATTACH_STATE"), false);

const result = await migration.run();
assert.equal(result.state, "READY");
assert.deepEqual(result.completedSteps, WINDOWS_LEGACY_MSIX_MIGRATION_STEPS.map((step) => step.id));
assert.ok(calls.filter((call) => call === "probe:ATTACH_STATE").length >= 2);
assert.equal(calls.filter((call) => call === "mutate:STOP_LEGACY_SERVICES").length, 1);

const journalSource = await fs.readFile(journal.journalPath, "utf8");
assert.doesNotMatch(
  journalSource,
  /"(?:password|credential|connectionString|privateKey|secret)"\s*:|postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@|BEGIN [A-Z ]*PRIVATE KEY|temporaryPassword=/iu
);

const rejectingJournal = createFileLegacyMigrationJournal({
  artifactKind: "DEMONSTRATION_SERVER",
  rootDirectory: path.join(temporary, "reject"),
});
const rejecting = createWindowsLegacyMsixMigration({
  artifactKind: "DEMONSTRATION_SERVER",
  journal: rejectingJournal,
  adapter: {
    async probe() {
      return { ready: true, discovery: { classification: "AMBIGUOUS", reasonCode: "LEGACY_INSTALL_AMBIGUOUS" } };
    },
    async mutate() { throw new Error("mutation must not run"); },
    async postcondition() { throw new Error("postcondition must not run"); },
  },
});
await assert.rejects(() => rejecting.run(), (error) => error.code === "LEGACY_INSTALL_AMBIGUOUS");

await fs.rm(temporary, { recursive: true, force: true });
console.log("Windows legacy migration journal, interruption retry, and fail-closed core verified.");
