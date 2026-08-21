import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServerProvisioningCore } from "../../tools/server-provisioning-core.mjs";
import {
  SERVER_PROVISIONING_STEPS,
  validateServerProvisioningJournalRecord,
} from "../../tools/server-provisioning-contract.mjs";
import {
  createFileServerProvisioningJournal,
  windowsServerProvisioningRoot,
} from "../../tools/platform/windows/server-provisioning-journal.mjs";

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "quickhack-server-provisioning-"));
const artifactKind = "DEMONSTRATION_SERVER";
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 7, 22, 0, 0, tick++));

function journal(name, options = {}) {
  return createFileServerProvisioningJournal({
    artifactKind,
    rootDirectory: path.join(temporaryRoot, name),
    clock,
    staleLockMs: options.staleLockMs ?? 1,
  });
}

function fixtureAdapter(options = {}) {
  const ready = new Set(options.ready ?? []);
  const mutations = [];
  let failed = false;
  return {
    ready,
    mutations,
    async probe(step) {
      if (step.id === "INITIAL_LEADER") {
        return { ready: ready.has(step.id) };
      }
      return { ready: ready.has(step.id) };
    },
    async mutate(step) {
      mutations.push(step.id);
      if (step.id === options.failOnceAt && !failed) {
        failed = true;
        const error = new Error("fixture interruption");
        error.code = "PROVISIONING_INTERRUPTED";
        throw error;
      }
      if (step.id === "INITIAL_LEADER" && !options.acknowledged) {
        return {
          pendingAcknowledgement: true,
          userId: 1,
          generation: options.generation ?? 1,
          handoff: Object.freeze({ username: "admin", temporaryPassword: "memory-only" }),
        };
      }
      ready.add(step.id);
      return { changed: true };
    },
    async postcondition(step) {
      return { ready: ready.has(step.id) };
    },
  };
}

try {
  assert.equal(
    windowsServerProvisioningRoot({ programData: "C:\\ProgramData", artifactKind }),
    "C:\\ProgramData\\QuickHack\\demonstration-server\\provisioning"
  );
  assert.throws(
    () => windowsServerProvisioningRoot({ programData: "relative", artifactKind }),
    (error) => error.code === "PROVISIONING_PATH_INVALID"
  );

  const interruptedJournal = journal("interrupted");
  const interruptedAdapter = fixtureAdapter({ failOnceAt: "SCHEMA", acknowledged: true });
  const interruptedCore = createServerProvisioningCore({
    artifactKind,
    journal: interruptedJournal,
    adapter: interruptedAdapter,
  });
  await assert.rejects(
    () => interruptedCore.run({ transactionId: randomUUID() }),
    (error) =>
      error.code === "PROVISIONING_INTERRUPTED" &&
      error.provisioningResult?.state === "REPAIR_REQUIRED" &&
      error.provisioningResult?.retryable === true
  );
  const resumed = await interruptedCore.run();
  assert.equal(resumed.state, "READY");
  assert.deepEqual(resumed.completedSteps, SERVER_PROVISIONING_STEPS.map((step) => step.id));
  assert.equal(interruptedAdapter.mutations.filter((step) => step === "PREFLIGHT").length, 1);
  assert.equal(interruptedAdapter.mutations.filter((step) => step === "SCHEMA").length, 2);

  const handoffJournal = journal("handoff");
  const handoffAdapter = fixtureAdapter({ acknowledged: false, generation: 1 });
  const handoffCore = createServerProvisioningCore({
    artifactKind,
    journal: handoffJournal,
    adapter: handoffAdapter,
  });
  const pending = await handoffCore.run({ transactionId: randomUUID() });
  assert.equal(pending.state, "INITIAL_LEADER_PENDING_ACK");
  assert.equal(pending.handoff.temporaryPassword, "memory-only");
  const durablePending = await handoffJournal.read();
  assert.equal(durablePending.initialLeader.userId, 1);
  assert.equal(durablePending.initialLeader.generation, 1);
  assert.equal("handoff" in durablePending, false);
  assert.doesNotMatch(readFileSync(handoffJournal.journalPath, "utf8"), /memory-only/u);
  await handoffJournal.acknowledgeInitialLeader({
    transactionId: durablePending.transactionId,
    generation: 1,
  });
  handoffAdapter.acknowledged = true;
  handoffAdapter.ready.add("INITIAL_LEADER");
  const readyAfterAck = await handoffCore.run();
  assert.equal(readyAfterAck.state, "READY");

  const forgedJournal = journal("forged");
  const forgedTransactionId = randomUUID();
  await forgedJournal.initialize(forgedTransactionId);
  for (const step of SERVER_PROVISIONING_STEPS) {
    await forgedJournal.commitStep({ transactionId: forgedTransactionId, stepId: step.id });
  }
  const forgedAdapter = fixtureAdapter({ acknowledged: true });
  const reconciled = await createServerProvisioningCore({
    artifactKind,
    journal: forgedJournal,
    adapter: forgedAdapter,
  }).run();
  assert.equal(reconciled.state, "READY");
  assert.deepEqual(forgedAdapter.mutations, SERVER_PROVISIONING_STEPS.map((step) => step.id));

  const secretJournal = journal("secret");
  const secretTransactionId = randomUUID();
  const secretRecord = await secretJournal.initialize(secretTransactionId);
  assert.throws(
    () => validateServerProvisioningJournalRecord({
      ...secretRecord,
      temporaryPassword: "forbidden",
    }),
    (error) => error.code === "PROVISIONING_SECRET_FORBIDDEN"
  );
  assert.throws(
    () => validateServerProvisioningJournalRecord({
      ...secretRecord,
      error: {
        code: "PROVISIONING_STEP_FAILED",
        retryable: true,
        at: new Date().toISOString(),
        detail: "postgresql://operator:secret@127.0.0.1/quickhack",
      },
    }),
    (error) => error.code === "PROVISIONING_SECRET_FORBIDDEN"
  );

  const flavorRoot = path.join(temporaryRoot, "flavor-conflict");
  const demoJournal = createFileServerProvisioningJournal({
    artifactKind,
    rootDirectory: flavorRoot,
    clock,
  });
  await demoJournal.initialize(randomUUID());
  const operationalJournal = createFileServerProvisioningJournal({
    artifactKind: "OPERATIONAL_SERVER",
    rootDirectory: flavorRoot,
    clock,
  });
  await assert.rejects(
    () => operationalJournal.read(),
    (error) => error.code === "PACKAGE_FLAVOR_MISMATCH"
  );

  const lockJournal = journal("lock");
  let releaseLock;
  const held = lockJournal.withLock(() => new Promise((resolve) => { releaseLock = resolve; }));
  while (!releaseLock) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => lockJournal.withLock(async () => undefined),
    (error) => error.code === "PROVISIONING_LOCKED"
  );
  releaseLock();
  await held;
  await lockJournal.withLock(async () => undefined);

  const staleRoot = path.join(temporaryRoot, "stale-lock");
  const staleJournal = createFileServerProvisioningJournal({
    artifactKind,
    rootDirectory: staleRoot,
    clock,
    staleLockMs: 0,
  });
  const staleLockPath = path.join(staleRoot, ".server-provisioning.lock");
  await fs.mkdir(staleLockPath, { recursive: true });
  await fs.writeFile(path.join(staleLockPath, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    createdAt: "2000-01-01T00:00:00.000Z",
  }));
  await staleJournal.withLock(async () => undefined);

  console.log("QuickHack observed-state server provisioning core and non-secret journal verified.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
