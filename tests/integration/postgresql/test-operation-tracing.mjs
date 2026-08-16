import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDirectory, "..", "..", "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-operation-tracing-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const {
  recordOperationQuery,
  recordOperationTransaction,
  runOperationTrace,
  setOperationTraceField,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
  traceOperationSpanSync,
} = await import("@/quickhack_server/observability/operation-trace");
const { runMeasuredTransaction } = await import(
  "@/quickhack_server/observability/transaction-trace"
);

let completedSnapshot = null;
let nestedCompleted = false;

const response = await runOperationTrace(
  {
    operationName: "test.operation",
    source: "HTTP",
    route: "/api/test",
    method: "POST",
    persist: false,
    onComplete(snapshot) {
      completedSnapshot = snapshot;
    },
  },
  async () => {
    setOperationTraceUserId(7);
    setOperationTraceTargetCount(3);
    setOperationTraceField("request.kind", "TEST");
    setOperationTraceField("sensitive", "password=should-not-be-stored");

    await traceOperationSpan("AUTH", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    traceOperationSpanSync("QHKEY_CONTEXT", () => 1);
    recordOperationQuery("findMany", 4);
    recordOperationQuery("update", 3);
    recordOperationTransaction({ waitMs: 2, runMs: 8, totalMs: 11 });

    await runOperationTrace(
      {
        operationName: "nested.operation",
        persist: false,
        onComplete() {
          nestedCompleted = true;
        },
      },
      () => traceOperationSpan("NESTED_WORK", () => Promise.resolve())
    );

    return new Response(null, { status: 409 });
  }
);

assert(response.status === 409, "The traced operation must preserve its result.");
assert(
  response.headers.get("x-quickhack-trace-id") === completedSnapshot?.traceId,
  "The response must expose the same Trace ID that is recorded by the operation."
);
assert(
  response.headers.get("x-quickhack-trace-recorded") === "0",
  "A non-persisted trace must tell the client not to report an observation."
);
assert(
  response.headers.get("server-timing")?.includes("qh;dur=") &&
    response.headers.get("server-timing")?.includes("qh-db-sum;dur=7") &&
    response.headers.get("server-timing")?.includes("qh-tx-enter;dur=2"),
  "The response must expose bounded server timing metrics."
);
assert(completedSnapshot, "The root operation must produce a snapshot.");
assert(!nestedCompleted, "Nested operations must remain spans of the root trace.");
assert(completedSnapshot.status === "FAILED", "HTTP failures must mark the trace failed.");
assert(completedSnapshot.errorCode === "HTTP_409", "HTTP status must be recorded.");
assert(completedSnapshot.userId === 7, "The authenticated user must be recorded.");
assert(completedSnapshot.targetCount === 3, "The target count must be recorded.");
assert(completedSnapshot.query.count === 2, "Queries must be counted.");
assert(completedSnapshot.query.readCount === 1, "Read queries must be classified.");
assert(completedSnapshot.query.writeCount === 1, "Write queries must be classified.");
assert(completedSnapshot.transaction.count === 1, "Transactions must be counted.");
assert(completedSnapshot.transaction.waitMs === 2, "Transaction wait time must be recorded.");
assert(completedSnapshot.spans.AUTH?.count === 1, "Named spans must be recorded.");
assert(
  completedSnapshot.spans["operation.nested.operation"]?.count === 1,
  "Nested operations must be represented as spans."
);
assert(
  completedSnapshot.fields.sensitive.includes("[REDACTED]") &&
    !completedSnapshot.fields.sensitive.includes("should-not-be-stored"),
  "Sensitive values must be redacted."
);

let measuredTransactionSnapshot = null;
const measuredResult = await runOperationTrace(
  {
    operationName: "test.measured-transaction",
    persist: false,
    onComplete(snapshot) {
      measuredTransactionSnapshot = snapshot;
    },
  },
  () =>
    runMeasuredTransaction(
      {
        async $transaction(callback) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return callback({});
        },
      },
      "test.write",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return "measured";
      }
    )
);

assert(measuredResult === "measured", "Measured transactions must preserve results.");
assert(
  measuredTransactionSnapshot?.transaction.count === 1,
  "Measured transactions must increment the transaction count."
);
assert(
  measuredTransactionSnapshot?.spans["transaction.test.write.total"]?.count === 1,
  "Measured transactions must expose a total span."
);
assert(
  measuredTransactionSnapshot?.spans["transaction.test.write.run"]?.count === 1,
  "Measured transactions must expose a callback run span."
);

const requiredHttpTraceCoverage = new Map([
  ["quickhack_server/api/inventory/device-list.ts", "inventory.device-list.read"],
  ["quickhack_server/api/inventory/audit-candidates.ts", "inventory.audit-candidates.read"],
  ["quickhack_server/api/inbound/purchase-pending.ts", "inbound.purchase-pending.read"],
  ["quickhack_server/api/inventory/quantity-ledger.ts", "inventory.quantity-ledger.read"],
  ["quickhack_server/api/inventory/quantity-ledger-movements.ts", "inventory.quantity-ledger.movements.read"],
  ["quickhack_server/api/inventory/inbound-reconciliation.ts", "inventory.inbound-reconciliation.read"],
  ["quickhack_server/api/inbound/batches.ts", "inbound.batch.read"],
  ["quickhack_server/api/sales-channel/coupang/orders.ts", "shipment.orders.read"],
  ["quickhack_server/api/sales-channel/coupang/delivering.ts", "shipment.delivering.read"],
  ["quickhack_server/api/sales-channel/coupang/shipment-list-print.ts", "shipment.print-history.read"],
  ["quickhack_server/api/sales-channel/coupang/inventory-candidates.ts", "shipment.inventory-candidates.read"],
  ["quickhack_server/api/sales-channel/coupang/shipment-address-changes.ts", "shipment.address-change.read"],
  ["quickhack_server/api/sales-channel/coupang/returns.ts", "return.list.read"],
  ["quickhack_server/api/statistics/dashboard.ts", "statistics.dashboard.read"],
  ["quickhack_server/api/statistics/sales.ts", "statistics.sales.read"],
  ["quickhack_server/api/statistics/inventory.ts", "statistics.inventory.read"],
  ["quickhack_server/api/statistics/returns.ts", "statistics.returns.read"],
]);

for (const [relativePath, operationName] of requiredHttpTraceCoverage) {
  const source = readFileSync(path.join(projectRoot, relativePath), "utf8");
  assert(
    source.includes(`operationName: "${operationName}"`),
    `${relativePath} must keep the ${operationName} trace.`
  );
  assert(
    source.includes('traceOperationSpan("SERVICE_READ"'),
    `${relativePath} must keep an explicit SERVICE_READ span.`
  );
}

const returnStatisticsTraceSource = readFileSync(
  path.join(
    projectRoot,
    "quickhack_server/api/statistics/returns.ts"
  ),
  "utf8"
);

for (const field of [
  "statistics.source_sales_rows",
  "statistics.source_return_events",
  "statistics.linked_return_pgs",
  "statistics.unmatched_withdrawals",
  "statistics.event_recording_started_at",
]) {
  assert(
    returnStatisticsTraceSource.includes(`"${field}"`),
    `Return statistics must keep the ${field} trace field.`
  );
}

assert(
  !returnStatisticsTraceSource.includes('"statistics.search_present"'),
  "Statistics traces must not retain the removed search contract."
);

const inventoryStatisticsTraceSource = readFileSync(
  path.join(
    projectRoot,
    "quickhack_server/api/statistics/inventory.ts"
  ),
  "utf8"
);

for (const field of [
  "statistics.inventory_availability",
  "statistics.inventory_rows",
  "statistics.balance_quantity",
  "statistics.sku_status_mismatch_count",
  "statistics.unknown_status_count",
  "statistics.unclassified_inventory_count",
]) {
  assert(
    inventoryStatisticsTraceSource.includes(`"${field}"`),
    `Inventory statistics must keep the ${field} trace field.`
  );
}

const requiredMeasuredTransactionCoverage = [
  "quickhack_server/inspection/inspection-save-service.ts",
  "quickhack_server/inbound/inbound-batch-service.ts",
  "quickhack_server/inbound/purchase-confirm-service.ts",
  "quickhack_server/inbound/purchase-price-service.ts",
  "quickhack_server/sales-channel/coupang/order-matching-service.ts",
  "quickhack_server/sales-channel/write/sales-channel-write-review-service.ts",
  "quickhack_server/shipment/shipment-address-change-tracking-service.ts",
  "quickhack_server/sales-channel/coupang/read-sync-recovery-service.ts",
];

for (const relativePath of requiredMeasuredTransactionCoverage) {
  const source = readFileSync(path.join(projectRoot, relativePath), "utf8");
  assert(
    source.includes("runMeasuredTransaction("),
    `${relativePath} must keep measured transaction coverage.`
  );
}

const consistentReadSnapshotSource = readFileSync(
  path.join(
    projectRoot,
    "quickhack_server/core/database/consistent-read-snapshot.ts"
  ),
  "utf8"
);
assert(
  consistentReadSnapshotSource.includes("runMeasuredTransaction("),
  "The consistent read snapshot boundary must keep measured transaction coverage."
);

for (const relativePath of [
  "quickhack_server/inventory/inventory-quantity-ledger-audit-service.ts",
]) {
  const source = readFileSync(path.join(projectRoot, relativePath), "utf8");
  assert(
    source.includes("runConsistentReadSnapshot("),
    `${relativePath} must keep measured consistent read snapshot coverage.`
  );
}

console.log("Operation tracing invariants passed.");

const { prisma } = await import("@/quickhack_server/core/prisma");
const { flushOperationTraceQueue } = await import(
  "@/quickhack_server/observability/trace-log-queue"
);

try {
  await runOperationTrace(
    {
      operationName: "test.persisted-operation",
      source: "SERVICE",
      targetCount: 1,
    },
    async () => {
      await prisma.server_job_logs.count();
      return "persisted";
    }
  );
  await flushOperationTraceQueue();

  const persisted = await prisma.server_job_logs.findFirst({
    where: {
      job_type: "USER_OPERATION_TRACE",
      job_name: "test.persisted-operation",
    },
    include: { fields: true },
  });

  assert(persisted, "A completed trace must be persisted through the log queue.");
  assert(persisted.status === "SUCCESS", "The persisted trace status must be preserved.");
  assert(
    persisted.fields.some(
      (field) => field.field_name === "query.count" && field.field_value === "1"
    ),
    "Prisma query extensions must add query counts to the persisted trace."
  );

  const reporter = await prisma.users.create({
    data: {
      username: "client-trace-reporter",
      password_hash: "test-only",
      role: "STAFF",
    },
  });
  const { normalizeClientTraceBatch, saveClientTraceObservations } = await import(
    "@/quickhack_server/observability/client-trace-service"
  );
  const traceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const completedItems = normalizeClientTraceBatch({
    items: [
      {
        traceId,
        responseStatus: 200,
        headerReceivedMs: 12,
        responseCompleteMs: 18,
        bodyProcessingMs: 6,
        gatewayMs: 3,
        observedAt: "2026-07-22 09:00:00+09:00",
      },
    ],
  });
  await saveClientTraceObservations({
    userId: reporter.user_id,
    items: completedItems,
  });
  await saveClientTraceObservations({
    userId: reporter.user_id,
    items: normalizeClientTraceBatch({
      items: [
        {
          ...completedItems[0],
          responseCompleteMs: null,
          bodyProcessingMs: null,
        },
      ],
    }),
  });
  const clientObservation =
    await prisma.client_http_trace_observations.findUnique({
      where: { trace_id: traceId },
    });

  assert(
    clientObservation?.response_complete_ms === 18 &&
      clientObservation.body_processing_ms === 6,
    "A later header-only report must not erase the completed client observation."
  );
  assert(
    clientObservation?.observed_at instanceof Date &&
      clientObservation.observed_at.toISOString() === "2026-07-22T00:00:00.000Z",
    "Client observation time must be persisted in canonical ISO format."
  );

  console.log("Operation trace and client observation persistence passed.");
} finally {
  await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
