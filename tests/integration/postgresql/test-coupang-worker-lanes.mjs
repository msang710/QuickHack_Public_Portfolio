import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const scope = createTemporaryDatabase("quickhack-coupang-worker-lanes-");
configureIntegrationTestEnvironment(scope.databaseUrl);

const { prisma } = await import("@/quickhack_server/core/prisma");
const { registeredWorkers } = await import("@/quickhack_server/workers/registry");
const { ensureRegisteredWorkerJobs } = await import(
  "@/quickhack_server/workers/worker-jobs"
);
const manager = await import("@/quickhack_server/workers/manager");

const originalRuns = new Map(registeredWorkers.map((worker) => [worker.key, worker.run]));
let releaseReconciliation;
const reconciliationGate = new Promise((resolve) => {
  releaseReconciliation = resolve;
});
let markReconciliationStarted;
const reconciliationStarted = new Promise((resolve) => {
  markReconciliationStarted = resolve;
});
let markRecentStarted;
const recentStarted = new Promise((resolve) => {
  markRecentStarted = resolve;
});

try {
  await ensureRegisteredWorkerJobs();
  await prisma.server_worker_jobs.updateMany({
    data: { schedule_enabled: 0, next_run_at: null },
  });
  for (const key of [
    "coupang-accept-order-sync",
    "coupang-order-reconciliation",
  ]) {
    await prisma.server_worker_jobs.update({
      where: { worker_key: key },
      data: { schedule_enabled: 1, next_run_at: new Date() },
    });
  }

  for (const worker of registeredWorkers) {
    worker.run = async () => ({ summary: { test: true } });
    if (worker.key === "coupang-accept-order-sync") {
      worker.run = async () => {
        markRecentStarted();
        return { summary: { recent: true } };
      };
    }
    if (worker.key === "coupang-order-reconciliation") {
      worker.run = async () => {
        markReconciliationStarted();
        await reconciliationGate;
        return { summary: { reconciliation: true } };
      };
    }
  }

  await manager.startWorkerManagerAndWaitForReady();
  let timeout;
  try {
    await Promise.race([
      Promise.all([recentStarted, reconciliationStarted]),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Both order worker lanes did not start.")),
          5_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(manager.getWorkerManagerState().reconciliationTickRunning, true);
  let recentJob;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    recentJob = await prisma.server_worker_jobs.findUniqueOrThrow({
      where: { worker_key: "coupang-accept-order-sync" },
    });
    if (recentJob.status === "SUCCESS") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(recentJob.status, "SUCCESS");
  console.log("Recent order worker completed while reconciliation was still running.");
} finally {
  releaseReconciliation();
  manager.beginWorkerManagerShutdown("test-complete");
  await manager.waitForWorkerManagerToDrain();
  for (const worker of registeredWorkers) {
    worker.run = originalRuns.get(worker.key);
  }
  await prisma.$disconnect();
  scope.cleanup();
}
