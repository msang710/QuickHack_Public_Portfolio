import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-postgresql-transaction-kernel-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
let secondClient;

function rendezvous(participantCount) {
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === participantCount) release();
    await ready;
  };
}

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { createPostgresqlPrismaClient } = await import(
    "@/quickhack_server/core/database/postgresql-client"
  );
  const {
    DomainOperationKeyConflictError,
    completeDomainOperationKey,
    digestDomainOperation,
    reserveDomainOperationKey,
    runRetriableMeasuredTransaction,
  } = await import("@/quickhack_server/core/database/aggregate-command");
  const {
    isExpectedPostgresqlUniqueViolation,
    isPostgresqlForeignKeyViolation,
    isRetryablePostgresqlTransactionError,
    postgresqlSqlState,
    prismaErrorCode,
  } = await import("@/quickhack_server/core/database/postgres-errors");
  const { resolveOrCreateInventorySku } = await import(
    "@/quickhack_server/catalog/inventory-sku-service"
  );
  const { resolveOrCreateSalesOffer } = await import(
    "@/quickhack_server/catalog/sales-offer-service"
  );

  ({ client: secondClient } = createPostgresqlPrismaClient({
    connectionString: temporaryDatabase.databaseUrl,
    applicationName: "quickhack-transaction-kernel-test-second-connection",
  }));

  assert.equal(
    isExpectedPostgresqlUniqueViolation(
      { code: "P2002", meta: { target: "uq_expected" } },
      ["uq_expected"]
    ),
    true
  );
  assert.equal(
    isExpectedPostgresqlUniqueViolation(
      {
        code: "P2002",
        meta: {
          target: ["carrier_code"],
          driverAdapterError: {
            cause: {
              originalCode: "23505",
              constraint: "uq_carrier_integration_settings_carrier",
            },
          },
        },
      },
      ["uq_carrier_integration_settings_carrier"]
    ),
    true,
    "The database constraint name must take precedence over Prisma's field target."
  );
  assert.equal(
    isExpectedPostgresqlUniqueViolation(
      { code: "P2002", meta: { target: ["carrier_code"] } },
      ["carrier_code"]
    ),
    true,
    "Prisma field targets must remain available when the adapter omits a constraint name."
  );
  assert.equal(
    isPostgresqlForeignKeyViolation({
      cause: { originalCode: "23503", constraint: "fk_expected" },
    }),
    true
  );
  assert.equal(
    isRetryablePostgresqlTransactionError({
      meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
    }),
    true
  );
  assert.equal(
    isRetryablePostgresqlTransactionError({ code: "P2002" }),
    false,
    "Unique violations must not enter the transaction retry loop."
  );
  assert.equal(
    postgresqlSqlState({
      code: "P2039",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "P0001", severity: "ERROR" },
        },
      },
    }),
    "P0001",
    "Wrapped PL/pgSQL exceptions must preserve their PostgreSQL SQLSTATE."
  );
  assert.equal(
    postgresqlSqlState({ code: "P2002" }),
    null,
    "Prisma client codes must not be classified as PostgreSQL SQLSTATEs."
  );
  assert.equal(
    prismaErrorCode({ code: "P0001", severity: "ERROR" }),
    null,
    "Native PostgreSQL SQLSTATEs must not be classified as Prisma client codes."
  );

  await prisma.product_criteria_options.createMany({
    data: [
      {
        category: "PRODUCT_MODEL",
        option_key: "TX_MODEL",
        label: "Transaction Model",
      },
      { category: "STORAGE", option_key: "TX_256", label: "256GB" },
      {
        category: "DEVICE_COLOR",
        option_key: "TX_BLACK",
        label: "Transaction Black",
      },
      { category: "SALE_GRADE", option_key: "A", label: "A" },
      {
        category: "WARRANTY_GROUP",
        option_key: "2Y",
        label: "Two year",
      },
    ],
  });

  const skuInput = {
    model: "Transaction Model",
    storage: "256GB",
    color: "Transaction Black",
    saleGrade: "A",
  };
  const [firstSku, secondSku] = await Promise.all([
    prisma.$transaction((tx) => resolveOrCreateInventorySku(tx, skuInput)),
    secondClient.$transaction((tx) =>
      resolveOrCreateInventorySku(tx, skuInput)
    ),
  ]);
  assert.equal(firstSku.inventory_sku_id, secondSku.inventory_sku_id);
  assert.equal(await prisma.inventory_skus.count(), 1);

  const offerInput = {
    model: "Transaction Model",
    storage: "256GB",
    color: "Transaction Black",
    warrantyGroup: "2Y",
  };
  const [firstOffer, secondOffer] = await Promise.all([
    prisma.$transaction((tx) => resolveOrCreateSalesOffer(tx, offerInput)),
    secondClient.$transaction((tx) =>
      resolveOrCreateSalesOffer(tx, offerInput)
    ),
  ]);
  assert.equal(firstOffer.row.sales_offer_id, secondOffer.row.sales_offer_id);
  assert.deepEqual(
    new Set([firstOffer.outcome, secondOffer.outcome]),
    new Set(["CREATED", "UNCHANGED"])
  );
  assert.equal(await prisma.sales_offers.count(), 1);

  const requestDigest = digestDomainOperation({ quantity: 1 });
  const operationResults = await Promise.all(
    [prisma, secondClient].map((owner) =>
      owner.$transaction(async (tx) => {
        const reservation = await reserveDomainOperationKey(tx, {
          scope: "TRANSACTION_KERNEL_TEST",
          operationKey: "same-operation",
          aggregateType: "TEST_AGGREGATE",
          aggregateId: "aggregate-1",
          requestDigest,
        });
        await completeDomainOperationKey(
          tx,
          reservation.row.operation_id,
          digestDomainOperation({ result: "same" })
        );
        return reservation;
      })
    )
  );
  assert.equal(operationResults.filter((result) => result.owned).length, 1);
  assert.equal(
    operationResults[0].row.operation_id,
    operationResults[1].row.operation_id
  );
  assert.equal(await prisma.domain_operation_keys.count(), 1);

  await assert.rejects(
    prisma.$transaction((tx) =>
      reserveDomainOperationKey(tx, {
        scope: "TRANSACTION_KERNEL_TEST",
        operationKey: "same-operation",
        aggregateType: "TEST_AGGREGATE",
        aggregateId: "aggregate-1",
        requestDigest: digestDomainOperation({ quantity: 2 }),
      })
    ),
    DomainOperationKeyConflictError
  );

  await prisma.server_worker_jobs.create({
    data: {
      worker_key: "transaction-kernel-serializable-counter",
      worker_name: "Transaction kernel serializable counter",
      worker_type: "TEST",
      attempt_count: 0,
    },
  });
  const firstAttemptBarrier = rendezvous(2);
  const observedAttempts = [];
  const incrementCounter = (owner, participant) =>
    runRetriableMeasuredTransaction(
      owner,
      `transaction_kernel.serializable.${participant}`,
      async (tx, attempt) => {
        observedAttempts.push({ participant, attempt });
        const row = await tx.server_worker_jobs.findUniqueOrThrow({
          where: { worker_key: "transaction-kernel-serializable-counter" },
        });
        if (attempt === 1) await firstAttemptBarrier();
        await tx.server_worker_jobs.update({
          where: { worker_job_id: row.worker_job_id },
          data: { attempt_count: row.attempt_count + 1 },
        });
        return attempt;
      },
      { isolationLevel: "Serializable", maxAttempts: 3 }
    );

  await Promise.all([
    incrementCounter(prisma, "first"),
    incrementCounter(secondClient, "second"),
  ]);
  const counter = await prisma.server_worker_jobs.findUniqueOrThrow({
    where: { worker_key: "transaction-kernel-serializable-counter" },
  });
  assert.equal(counter.attempt_count, 2);
  assert.equal(
    observedAttempts.some(({ attempt }) => attempt > 1),
    true,
    "A real PostgreSQL serialization failure did not use the bounded retry path."
  );

  console.log(
    "PostgreSQL transaction kernel atomic-create, operation-key, and retry invariants verified."
  );
} finally {
  await secondClient?.$disconnect();
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
