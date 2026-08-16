import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
  projectRoot,
} from "../../support/postgresql-test-scope.mjs";

const pageSource = readFileSync(path.join(projectRoot, "app", "page.tsx"), "utf8");
const runtimeRouteSource = readFileSync(
  path.join(projectRoot, "app", "api", "runtime", "route.ts"),
  "utf8"
);
const instrumentationSource = readFileSync(
  path.join(projectRoot, "instrumentation.ts"),
  "utf8"
);
const workerManagerSource = readFileSync(
  path.join(projectRoot, "quickhack_server", "workers", "manager.ts"),
  "utf8"
);

assert.doesNotMatch(
  pageSource,
  /startWorkerManager/,
  "The page render path still starts the worker manager."
);
assert.doesNotMatch(
  runtimeRouteSource,
  /startWorkerManager|scheduleServerWorkerManager/,
  "The runtime status endpoint still starts the worker manager."
);
assert.match(
  instrumentationSource,
  /startWorkerManagerForRuntime/,
  "Next instrumentation is not wired to the worker bootstrap."
);
assert.match(
  workerManagerSource,
  /recoverStaleInventoryVerificationClaims\(\{ now \}\)/,
  "The worker manager is not wired to recover stale inventory verification claims."
);
assert.match(
  workerManagerSource,
  /recoverInterruptedSalesChannelWrites\(\{ now \}\)/,
  "The worker manager is not wired to recover interrupted sales-channel writes."
);

const { shouldStartWorkerManagerForRuntime } = await import(
  "@/quickhack_server/workers/bootstrap"
);

assert.equal(
  shouldStartWorkerManagerForRuntime({
    nextRuntime: "nodejs",
    runtimeRole: "server",
  }),
  true
);
assert.equal(
  shouldStartWorkerManagerForRuntime({
    nextRuntime: "nodejs",
    runtimeRole: "single",
  }),
  true
);
assert.equal(
  shouldStartWorkerManagerForRuntime({
    nextRuntime: "nodejs",
    runtimeRole: "client",
  }),
  false,
  "A client runtime may not start server workers."
);
assert.equal(
  shouldStartWorkerManagerForRuntime({
    nextRuntime: "edge",
    runtimeRole: "server",
  }),
  false,
  "An Edge runtime may not load server workers."
);

const temporaryDatabase = createTemporaryDatabase("quickhack-worker-bootstrap-");
let manager;
let prisma;

try {
  configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);
  process.env.QUICKHACK_RUNTIME_ROLE = "server";
  process.env.NEXT_RUNTIME = "nodejs";

  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  manager = await import("@/quickhack_server/workers/manager");
  const { registeredWorkers } = await import(
    "@/quickhack_server/workers/registry"
  );
  const { register } = await import(
    pathToFileURL(path.join(projectRoot, "instrumentation.ts")).href
  );

  assert.equal(
    manager.getWorkerManagerState().started,
    false,
    "The worker manager started before Next instrumentation ran."
  );

  await register();
  const firstState = manager.getWorkerManagerState();
  assert.equal(firstState.started, true, firstState.disabledReason);
  assert.equal(firstState.starting, false);
  assert.equal(firstState.pollSeconds, 30);

  const registeredCount = await prisma.server_worker_jobs.count();
  assert.equal(
    registeredCount,
    registeredWorkers.length,
    "Server startup did not register every worker before becoming ready."
  );
  const privacyWorker = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: "privacy-redact-expired-personal-data" },
  });
  assert.equal(privacyWorker.schedule_enabled, 1);
  assert.ok(privacyWorker.next_run_at);
  const { updateWorkerSchedule } = await import(
    "@/quickhack_server/workers/worker-jobs"
  );
  await assert.rejects(
    updateWorkerSchedule({
      workerKey: "privacy-redact-expired-personal-data",
      scheduleEnabled: false,
      triggeredBy: null,
    }),
    (error) => error?.code === "WORKER_SCHEDULE_REQUIRED"
  );

  await register();
  const duplicateCount = await prisma.server_worker_jobs.count();
  assert.equal(
    duplicateCount,
    registeredCount,
    "Repeated instrumentation startup duplicated worker registrations."
  );
  assert.equal(manager.getWorkerManagerState().started, true);

  console.log(
    "Worker manager startup, runtime guards, and duplicate-start protection verified."
  );
} finally {
  if (manager) {
    manager.beginWorkerManagerShutdown("worker-bootstrap-test-complete");
    await manager.waitForWorkerManagerToDrain();
  }
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
