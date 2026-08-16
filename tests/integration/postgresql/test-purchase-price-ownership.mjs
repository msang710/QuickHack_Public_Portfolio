import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-purchase-price-ownership-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const priceService = await import(
    "@/quickhack_server/inbound/purchase-price-service"
  );
  const timestamp = new Date("2026-08-14T00:00:00.000Z");
  const userRow = await prisma.users.create({
    data: {
      username: "purchase-price-owner",
      password_hash: "integration-test-only",
      role: "MANAGER",
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "purchase price owner",
    role: "MANAGER",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  async function option(category, optionKey, label, sortOrder) {
    return prisma.product_criteria_options.create({
      data: {
        category,
        option_key: optionKey,
        label,
        parent_key: "",
        sort_order: sortOrder,
        is_active: 1,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  }

  const model = await option("PRODUCT_MODEL", "PRICE-MODEL", "가격 모델", 10);
  const storage = await option("STORAGE", "256GB", "256GB", 10);
  const gradeA = await option("APPEARANCE_GRADE", "A", "A", 10);
  const gradeMixed = await option(
    "APPEARANCE_GRADE",
    "A-~B+",
    "A-~B+",
    20
  );
  await prisma.product_criteria_option_links.create({
    data: {
      relation_type: "MODEL_STORAGE",
      parent_option_id: model.option_id,
      child_option_id: storage.option_id,
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  const priceDate = "2026-08-14";
  const note = "현장 A 조건";
  const initial = await priceService.savePurchasePriceRates(
    prisma,
    {
      priceDate,
      note,
      rates: [
        {
          modelOptionId: model.option_id,
          storageOptionId: storage.option_id,
          appearanceGradeOptionId: gradeA.option_id,
          expectedRevision: null,
          purchasePrice: 100_000,
        },
        {
          modelOptionId: model.option_id,
          storageOptionId: storage.option_id,
          appearanceGradeOptionId: gradeMixed.option_id,
          expectedRevision: null,
          purchasePrice: 80_000,
        },
      ],
    },
    user
  );
  assert.equal(initial.savedRates.length, 2);
  assert.deepEqual(
    new Set(initial.savedRates.map((rate) => rate.appearanceGrade)),
    new Set(["A", "A-~B+"])
  );

  const rateA = initial.savedRates.find(
    (rate) => rate.appearanceGradeOptionId === gradeA.option_id
  );
  const rateMixed = initial.savedRates.find(
    (rate) => rate.appearanceGradeOptionId === gradeMixed.option_id
  );
  assert.ok(rateA && rateMixed);

  const noOp = await priceService.savePurchasePriceRates(
    prisma,
    {
      priceDate,
      note,
      rates: [
        {
          modelOptionId: model.option_id,
          storageOptionId: storage.option_id,
          appearanceGradeOptionId: gradeA.option_id,
          expectedRevision: rateA.revision,
          purchasePrice: rateA.purchasePrice,
        },
      ],
    },
    user
  );
  assert.equal(noOp.savedRates[0].revision, rateA.revision);

  const winner = await priceService.savePurchasePriceRates(
    prisma,
    {
      priceDate,
      note,
      rates: [
        {
          modelOptionId: model.option_id,
          storageOptionId: storage.option_id,
          appearanceGradeOptionId: gradeA.option_id,
          expectedRevision: rateA.revision,
          purchasePrice: 110_000,
        },
      ],
    },
    user
  );
  assert.equal(winner.savedRates[0].revision, rateA.revision + 1);

  await assert.rejects(
    () =>
      priceService.savePurchasePriceRates(
        prisma,
        {
          priceDate,
          note,
          rates: [
            {
              modelOptionId: model.option_id,
              storageOptionId: storage.option_id,
              appearanceGradeOptionId: gradeA.option_id,
              expectedRevision: rateA.revision,
              purchasePrice: 120_000,
            },
          ],
        },
        user
      ),
    (error) => error?.code === "PURCHASE_PRICE_RATE_CONFLICT"
  );

  const auditCountBeforeBatch = await prisma.employee_activity_logs.count();
  await assert.rejects(
    () =>
      priceService.savePurchasePriceRates(
        prisma,
        {
          priceDate,
          note,
          rates: [
            {
              modelOptionId: model.option_id,
              storageOptionId: storage.option_id,
              appearanceGradeOptionId: gradeA.option_id,
              expectedRevision: rateA.revision,
              purchasePrice: 130_000,
            },
            {
              modelOptionId: model.option_id,
              storageOptionId: storage.option_id,
              appearanceGradeOptionId: gradeMixed.option_id,
              expectedRevision: rateMixed.revision,
              purchasePrice: 90_000,
            },
          ],
        },
        user
      ),
    (error) => error?.code === "PURCHASE_PRICE_RATE_CONFLICT"
  );
  const afterFailedBatch = await priceService.listPurchasePriceRates(
    prisma,
    priceDate,
    note
  );
  assert.equal(
    afterFailedBatch.find(
      (rate) => rate.appearanceGradeOptionId === gradeMixed.option_id
    )?.purchasePrice,
    80_000
  );
  assert.equal(await prisma.employee_activity_logs.count(), auditCountBeforeBatch);

  const concurrentNote = "동시 신규";
  const concurrentResults = await Promise.allSettled([
    priceService.savePurchasePriceRates(
      prisma,
      {
        priceDate,
        note: concurrentNote,
        rates: [
          {
            modelOptionId: model.option_id,
            storageOptionId: storage.option_id,
            appearanceGradeOptionId: gradeA.option_id,
            expectedRevision: null,
            purchasePrice: 140_000,
          },
        ],
      },
      user
    ),
    priceService.savePurchasePriceRates(
      prisma,
      {
        priceDate,
        note: concurrentNote,
        rates: [
          {
            modelOptionId: model.option_id,
            storageOptionId: storage.option_id,
            appearanceGradeOptionId: gradeA.option_id,
            expectedRevision: null,
            purchasePrice: 150_000,
          },
        ],
      },
      user
    ),
  ]);
  assert.equal(
    concurrentResults.filter((result) => result.status === "fulfilled").length,
    1
  );
  assert.equal(
    concurrentResults.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason?.code === "PURCHASE_PRICE_RATE_CONFLICT"
    ).length,
    1
  );
  assert.equal(
    await prisma.purchase_price_rates.count({
      where: { note: concurrentNote },
    }),
    1
  );

  console.log("Purchase price ownership tests passed.");
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
