import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-sales-offer-audit-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    bootstrapSalesOffersFromCriteria,
    saveSalesOffer,
  } = await import("@/quickhack_server/catalog/sales-offer-service");
  const { WARRANTY_GROUPS } = await import(
    "@/quickhack_shared/sales-channel/sales-matching"
  );
  const timestamp = new Date("2026-07-31T00:00:00.000Z");
  const databaseUser = await prisma.users.create({
    data: {
      username: "sales-offer-auditor",
      password_hash: "integration-test-only",
      role: "MANAGER",
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const user = {
    userId: databaseUser.user_id,
    username: databaseUser.username,
    displayName: "판매 구성 검사자",
    role: "MANAGER",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  await prisma.product_criteria_options.create({
    data: {
      category: "PRODUCT_MODEL",
      option_key: "MODEL-A",
      label: "MODEL-A",
      parent_key: "",
    },
  });
  for (const [index, warrantyGroup] of WARRANTY_GROUPS.entries()) {
    await prisma.product_criteria_options.upsert({
      where: {
        category_option_key_parent_key: {
          category: "WARRANTY_GROUP",
          option_key: warrantyGroup,
          parent_key: "",
        },
      },
      create: {
        category: "WARRANTY_GROUP",
        option_key: warrantyGroup,
        label: `${warrantyGroup} warranty`,
        parent_key: "",
        sort_order: index,
      },
      update: { is_active: 1 },
    });
  }

  const created = await saveSalesOffer(
    {
      model: "MODEL-A",
      warrantyGroup: WARRANTY_GROUPS[0],
      isActive: true,
    },
    user
  );
  assert.equal(created.isActive, true);
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: { action_type: "SALES_OFFER_CREATE" },
    }),
    1
  );

  const unchangedTimestamp = created.updatedAt;
  const unchangedAuditCount = await prisma.employee_activity_logs.count();
  const unchanged = await saveSalesOffer(
    {
      salesOfferId: created.id,
      expectedRevision: created.revision,
      isActive: true,
    },
    user
  );
  assert.equal(unchanged.updatedAt, unchangedTimestamp);
  assert.equal(
    await prisma.employee_activity_logs.count(),
    unchangedAuditCount,
    "No-op save must not update the row or append an audit event."
  );

  const deactivated = await saveSalesOffer(
    {
      salesOfferId: created.id,
      expectedRevision: unchanged.revision,
      isActive: false,
    },
    user
  );
  assert.equal(deactivated.isActive, false);
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: { action_type: "SALES_OFFER_DEACTIVATE" },
    }),
    1
  );

  const reactivated = await saveSalesOffer(
    {
      salesOfferId: created.id,
      expectedRevision: deactivated.revision,
      isActive: true,
    },
    user
  );
  assert.equal(reactivated.isActive, true);
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: { action_type: "SALES_OFFER_ACTIVATE" },
    }),
    1
  );

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION fail_sales_offer_deactivate_audit_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action_type = 'SALES_OFFER_DEACTIVATE' THEN
        RAISE EXCEPTION 'forced sales offer audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_sales_offer_deactivate_audit
    BEFORE INSERT ON employee_activity_logs
    FOR EACH ROW
    EXECUTE FUNCTION fail_sales_offer_deactivate_audit_fn()
  `);
  await assert.rejects(
    () =>
      saveSalesOffer(
        {
          salesOfferId: created.id,
          expectedRevision: reactivated.revision,
          isActive: false,
        },
        user
      )
  );
  assert.equal(
    (
      await prisma.sales_offers.findUniqueOrThrow({
        where: { sales_offer_id: created.id },
      })
    ).is_active,
    1,
    "The sales offer mutation must roll back when audit insertion fails."
  );
  await prisma.$executeRawUnsafe(
    "DROP TRIGGER fail_sales_offer_deactivate_audit ON employee_activity_logs"
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION fail_sales_offer_deactivate_audit_fn()"
  );

  const bootstrap = await bootstrapSalesOffersFromCriteria(user);
  assert.deepEqual(
    {
      offerCount: bootstrap.offerCount,
      createdCount: bootstrap.createdCount,
      reactivatedCount: bootstrap.reactivatedCount,
      unchangedCount: bootstrap.unchangedCount,
    },
    {
      offerCount: WARRANTY_GROUPS.length,
      createdCount: WARRANTY_GROUPS.length - 1,
      reactivatedCount: 0,
      unchangedCount: 1,
    }
  );
  const bootstrapAudit = await prisma.employee_activity_logs.findFirstOrThrow({
    where: { action_type: "SALES_OFFER_BOOTSTRAP" },
    orderBy: { id: "desc" },
    include: { changes: true },
  });
  assert.equal(
    bootstrapAudit.changes.filter((change) =>
      change.field_name.startsWith("affectedOfferId.")
    ).length,
    bootstrap.createdCount + bootstrap.reactivatedCount
  );

  await prisma.product_criteria_options.create({
    data: {
      category: "PRODUCT_MODEL",
      option_key: "MODEL-B",
      label: "MODEL-B",
      parent_key: "",
    },
  });
  const offerCountBeforeFailedBootstrap = await prisma.sales_offers.count();
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION fail_sales_offer_bootstrap_audit_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action_type = 'SALES_OFFER_BOOTSTRAP' THEN
        RAISE EXCEPTION 'forced sales offer bootstrap audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_sales_offer_bootstrap_audit
    BEFORE INSERT ON employee_activity_logs
    FOR EACH ROW
    EXECUTE FUNCTION fail_sales_offer_bootstrap_audit_fn()
  `);
  await assert.rejects(
    () => bootstrapSalesOffersFromCriteria(user)
  );
  assert.equal(
    await prisma.sales_offers.count(),
    offerCountBeforeFailedBootstrap,
    "The entire bootstrap must roll back when its summary audit fails."
  );

  console.log("Sales offer mutation and audit atomicity verified.");
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
