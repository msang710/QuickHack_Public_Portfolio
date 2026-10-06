import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-product-criteria-aggregate-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const criteriaService = await import(
    "@/quickhack_server/catalog/product-criteria-service"
  );
  const skuService = await import(
    "@/quickhack_server/catalog/inventory-sku-service"
  );
  const timestamp = new Date("2026-08-14T00:00:00.000Z");
  const userRow = await prisma.users.create({
    data: {
      username: "criteria-aggregate-owner",
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
    displayName: "criteria aggregate owner",
    role: "MANAGER",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  async function createOption(category, optionKey, label) {
    return criteriaService.upsertProductCriteriaOption(
      prisma,
      {
        optionId: null,
        category,
        optionKey,
        label,
        parentKey: "",
        sortOrder: 10,
        isActive: true,
      },
      user
    );
  }

  const modelOne = await createOption(
    "PRODUCT_MODEL",
    "CRITERIA-MODEL-ONE",
    "같은 표시명"
  );
  const modelTwo = await createOption(
    "PRODUCT_MODEL",
    "CRITERIA-MODEL-TWO",
    "같은 표시명"
  );
  const storage = await createOption("STORAGE", "256GB", "256GB");
  const color = await createOption("DEVICE_COLOR", "BLACK", "검정");
  const saleGrade = await createOption("SALE_GRADE", "A", "A");

  await assert.rejects(
    () =>
      prisma.$transaction((tx) =>
        skuService.resolveInventorySkuCriteria(tx, {
          model: "같은 표시명",
          storage: "256GB",
          color: "검정",
          saleGrade: "A",
        })
      ),
    (error) => error?.code === "INVENTORY_SKU_CRITERIA_AMBIGUOUS"
  );

  const firstRelations = await criteriaService.saveProductCriteriaRelations(
    prisma,
    {
      modelOptionId: modelTwo.optionId,
      expectedRelationRevision: 0,
      storageOptionIds: [storage.optionId],
      colorOptionIds: [color.optionId],
      cameraRules: [],
    },
    user
  );
  assert.equal(firstRelations.relationRevision, 1);

  await assert.rejects(
    () =>
      criteriaService.saveProductCriteriaRelations(
        prisma,
        {
          modelOptionId: modelTwo.optionId,
          expectedRelationRevision: 0,
          storageOptionIds: [],
          colorOptionIds: [],
          cameraRules: [],
        },
        user
      ),
    (error) => error?.code === "PRODUCT_CRITERIA_RELATION_CONFLICT"
  );
  const activeLinks = await prisma.product_criteria_option_links.findMany({
    where: {
      parent_option_id: modelTwo.optionId,
      is_active: 1,
    },
  });
  assert.deepEqual(
    new Set(activeLinks.map((link) => link.child_option_id)),
    new Set([storage.optionId, color.optionId])
  );

  const sku = await prisma.$transaction((tx) =>
    skuService.resolveOrCreateInventorySku(tx, {
      modelOptionId: modelTwo.optionId,
      storageOptionId: storage.optionId,
      colorOptionId: color.optionId,
      saleGradeOptionId: saleGrade.optionId,
    })
  );
  await prisma.devices.create({
    data: {
      pg_no: "CRITERIAAGGREGATE001",
      model: modelTwo.label,
      model_code: modelTwo.optionKey,
      storage: storage.label,
      color: color.label,
      sale_grade: saleGrade.optionKey,
      inventory_sku_id: sku.inventory_sku_id,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  const renamed = await criteriaService.upsertProductCriteriaOption(
    prisma,
    {
      optionId: modelTwo.optionId,
      expectedRevision: modelTwo.revision,
      category: modelTwo.category,
      optionKey: modelTwo.optionKey,
      label: "변경된 표시명",
      parentKey: modelTwo.parentKey,
      sortOrder: modelTwo.sortOrder,
      isActive: true,
    },
    user
  );
  assert.equal(renamed.optionId, modelTwo.optionId);
  assert.equal(renamed.revision, modelTwo.revision + 1);

  await assert.rejects(
    () =>
      criteriaService.upsertProductCriteriaOption(
        prisma,
        {
          optionId: modelTwo.optionId,
          expectedRevision: modelTwo.revision,
          category: modelTwo.category,
          optionKey: modelTwo.optionKey,
          label: "오래된 수정",
          parentKey: modelTwo.parentKey,
          sortOrder: modelTwo.sortOrder,
          isActive: true,
        },
        user
      ),
    (error) => error?.code === "PRODUCT_CRITERIA_OPTION_CONFLICT"
  );
  await assert.rejects(
    () =>
      criteriaService.upsertProductCriteriaOption(
        prisma,
        {
          optionId: modelTwo.optionId,
          expectedRevision: renamed.revision,
          category: modelTwo.category,
          optionKey: "DIFFERENT-IDENTITY",
          label: renamed.label,
          parentKey: modelTwo.parentKey,
          sortOrder: modelTwo.sortOrder,
          isActive: true,
        },
        user
      ),
    (error) => error?.code === "PRODUCT_CRITERIA_IDENTITY_IMMUTABLE"
  );

  const assigned = await prisma.$transaction((tx) =>
    skuService.assignCurrentInventorySkuToDevice(
      tx,
      "CRITERIAAGGREGATE001",
      {
        required: true,
        changedCriteria: { modelLabel: true },
      }
    )
  );
  assert.equal(assigned.inventory_sku_id, sku.inventory_sku_id);
  const historicalDevice = await prisma.devices.findUniqueOrThrow({
    where: { pg_no: "CRITERIAAGGREGATE001" },
  });
  assert.equal(historicalDevice.model, "같은 표시명");

  const noOpRelations = await criteriaService.saveProductCriteriaRelations(
    prisma,
    {
      modelOptionId: modelTwo.optionId,
      expectedRelationRevision: firstRelations.relationRevision,
      storageOptionIds: [storage.optionId],
      colorOptionIds: [color.optionId],
      cameraRules: [],
    },
    user
  );
  assert.equal(noOpRelations.relationRevision, firstRelations.relationRevision);

  const independentRelations =
    await criteriaService.saveProductCriteriaRelations(
      prisma,
      {
        modelOptionId: modelOne.optionId,
        expectedRelationRevision: 0,
        storageOptionIds: [storage.optionId],
        colorOptionIds: [],
        cameraRules: [],
      },
      user
    );
  assert.equal(independentRelations.relationRevision, 1);

  const seeded = await criteriaService.getProductCriteriaPayload(prisma, true);
  const seededColors = seeded.rawOptions.filter(
    (option) => option.category === "DEVICE_COLOR"
  );
  assert.equal(seededColors.length, 83, "The 82 exported colors must join the existing custom color.");
  assert.equal(seededColors.find((option) => option.optionKey === "핑크 골드")?.isActive, false);
  assert.equal(
    seeded.rawOptions.find((option) => option.optionKey === "Galaxy S26")?.isActive,
    false,
    "Exported inactive models must remain inactive."
  );
  const s23 = seeded.rawOptions.find((option) => option.optionKey === "SM-S911N");
  const graphite = seededColors.find((option) => option.optionKey === "그라파이트");
  assert(s23 && graphite);
  const s23Graphite = seeded.rawLinks.find(
    (link) =>
      link.relationType === "MODEL_COLOR" &&
      link.parentOptionId === s23.optionId &&
      link.childOptionId === graphite.optionId
  );
  assert(s23Graphite, "The exported model-color relation must use new database IDs.");
  assert.equal(
    seeded.rawLinks.filter((link) => link.relationType === "MODEL_COLOR").length,
    226,
    "The 225 exported relations must join the existing custom relation."
  );

  await prisma.product_criteria_options.update({
    where: { option_id: graphite.optionId },
    data: { label: "관리자 수정 그라파이트", is_active: 0 },
  });
  await prisma.product_criteria_option_links.update({
    where: { link_id: s23Graphite.linkId },
    data: { is_active: 0 },
  });
  const reseeded = await criteriaService.getProductCriteriaPayload(prisma, true);
  assert.equal(
    reseeded.rawOptions.find((option) => option.optionId === graphite.optionId)?.label,
    "관리자 수정 그라파이트",
    "Default seeding must preserve operator edits."
  );
  assert.equal(
    reseeded.rawLinks.find((link) => link.linkId === s23Graphite.linkId)?.isActive,
    false,
    "Default seeding must not reactivate an operator-disabled link."
  );
  assert.equal(
    reseeded.rawLinks.filter((link) => link.relationType === "MODEL_COLOR").length,
    226,
    "Repeated default seeding must not duplicate relations."
  );

  console.log("Product criteria aggregate tests passed.");
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
