import assert from "node:assert/strict";
import { createInventoryCatalogFixture } from "../../support/inventory-business-fixtures.mjs";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-order-matching-policy-atomicity-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const {
    resetSalesOfferOrderMatchingPolicy,
    saveSalesOfferOrderMatchingPolicy,
  } = await import(
    "@/quickhack_server/sales-channel/order-matching-policy-service"
  );

  const timestamp = new Date("2026-08-04T00:00:00.000Z");
  const databaseUser = await prisma.users.create({
    data: {
      username: "order-matching-policy-atomicity-test",
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
    displayName: "Order matching policy atomicity test",
    role: "MANAGER",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };
  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "order-matching-policy-atomicity",
    timestamp,
  });
  await prisma.product_criteria_options.upsert({
    where: {
      category_option_key_parent_key: {
        category: "SALE_GRADE",
        option_key: "B",
        parent_key: "",
      },
    },
    create: {
      category: "SALE_GRADE",
      option_key: "B",
      label: "B",
      parent_key: "",
      created_at: timestamp,
      updated_at: timestamp,
    },
    update: { is_active: 1 },
  });
  const salesOfferId = catalog.salesOffer.sales_offer_id;
  const policyInclude = {
    tiers: {
      orderBy: { priority_order: "asc" },
      include: {
        sale_grades: {
          orderBy: { sort_order: "asc" },
          include: {
            sale_grade_option: {
              select: { option_key: true },
            },
          },
        },
      },
    },
  };

  function policyInput(policyName, saleGradeValues, overrides = {}) {
    return {
      salesOfferId,
      expectedPolicyId: null,
      expectedVersion: 1,
      policyName,
      autoMatchEnabled: true,
      candidateSortMode: "SALE_GRADE_THEN_STOCKED_OLD",
      gradeFallbackEnabled: true,
      tiers: [
        {
          saleGradeValues,
          isEnabled: true,
        },
      ],
      ...overrides,
    };
  }

  async function expectStalePolicyMutation(work, expected) {
    await assert.rejects(work, (error) => {
      assert.equal(error?.status, 409);
      assert.equal(error?.code, "ORDER_MATCHING_POLICY_STALE_STATE");
      assert.deepEqual(error?.details, {
        salesOfferId,
        expectedPolicyId: expected.policyId,
        expectedVersion: expected.version,
      });
      return true;
    });
  }

  async function expectInvalidExpectedState(work) {
    await assert.rejects(work, (error) => {
      assert.equal(error?.status, 400);
      assert.equal(
        error?.code,
        "INVALID_ORDER_MATCHING_POLICY_EXPECTED_STATE"
      );
      return true;
    });
  }

  async function persistedPolicy() {
    return prisma.order_matching_policies.findUnique({
      where: { sales_offer_id: salesOfferId },
      include: policyInclude,
    });
  }

  function policyState(policy) {
    return policy
      ? {
          policyId: policy.policy_id,
          policyName: policy.policy_name,
          autoMatchEnabled: policy.auto_match_enabled,
          candidateSortMode: policy.candidate_sort_mode,
          gradeFallbackEnabled: policy.grade_fallback_enabled,
          isActive: policy.is_active,
          version: policy.version,
          tiers: policy.tiers.map((tier) => ({
            tierId: tier.tier_id,
            priorityOrder: tier.priority_order,
            isEnabled: tier.is_enabled,
            saleGradeValues: tier.sale_grades.map(
              (saleGrade) => saleGrade.sale_grade_option.option_key
            ),
          })),
        }
      : null;
  }

  async function successfulLogCount(actionType) {
    return prisma.employee_activity_logs.count({
      where: {
        action_type: actionType,
        target_type: "ORDER_MATCHING_POLICY",
        target_id: String(salesOfferId),
        result: "SUCCESS",
      },
    });
  }

  await expectInvalidExpectedState(() =>
    saveSalesOfferOrderMatchingPolicy(
      policyInput("invalid default version", ["A"], {
        expectedVersion: 2,
      }),
      user
    )
  );
  await expectInvalidExpectedState(() =>
    resetSalesOfferOrderMatchingPolicy(
      {
        salesOfferId,
        expectedPolicyId: null,
        expectedVersion: 1,
      },
      user
    )
  );

  const initial = await saveSalesOfferOrderMatchingPolicy(
    policyInput("baseline policy", ["A"]),
    user
  );
  const baselineState = policyState(await persistedPolicy());
  assert.equal(initial.policyName, "baseline policy");
  assert.deepEqual(initial.tiers[0].saleGradeValues, ["A"]);
  assert.equal(
    await successfulLogCount("ORDER_MATCHING_POLICY_SAVE"),
    1
  );

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION quickhack_test_fail_order_matching_policy_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.action_type = TG_ARGV[0] THEN
        RAISE EXCEPTION 'forced order matching policy audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_order_matching_policy_save_audit
    BEFORE INSERT ON employee_activity_logs
    FOR EACH ROW EXECUTE FUNCTION quickhack_test_fail_order_matching_policy_audit(
      'ORDER_MATCHING_POLICY_SAVE'
    )
  `);
  await assert.rejects(() =>
    saveSalesOfferOrderMatchingPolicy(
      policyInput("failed replacement", ["B"], {
        expectedPolicyId: initial.policyId,
        expectedVersion: initial.version,
        autoMatchEnabled: false,
        gradeFallbackEnabled: false,
      }),
      user
    )
  );
  assert.deepEqual(
    policyState(await persistedPolicy()),
    baselineState,
    "The policy and its tiers must roll back when the save audit cannot be written."
  );
  assert.equal(
    await successfulLogCount("ORDER_MATCHING_POLICY_SAVE"),
    1
  );
  await prisma.$executeRawUnsafe(
    "DROP TRIGGER fail_order_matching_policy_save_audit ON employee_activity_logs"
  );

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_order_matching_policy_reset_audit
    BEFORE INSERT ON employee_activity_logs
    FOR EACH ROW EXECUTE FUNCTION quickhack_test_fail_order_matching_policy_audit(
      'ORDER_MATCHING_POLICY_RESET'
    )
  `);
  await assert.rejects(() =>
    resetSalesOfferOrderMatchingPolicy(
      {
        salesOfferId,
        expectedPolicyId: initial.policyId,
        expectedVersion: initial.version,
      },
      user
    )
  );
  assert.deepEqual(
    policyState(await persistedPolicy()),
    baselineState,
    "The policy and its tiers must remain when the reset audit cannot be written."
  );
  assert.equal(
    await successfulLogCount("ORDER_MATCHING_POLICY_RESET"),
    0
  );
  await prisma.$executeRawUnsafe(
    "DROP TRIGGER fail_order_matching_policy_reset_audit ON employee_activity_logs"
  );

  const saved = await saveSalesOfferOrderMatchingPolicy(
    policyInput("replacement policy", ["B"], {
      expectedPolicyId: initial.policyId,
      expectedVersion: initial.version,
      autoMatchEnabled: false,
      gradeFallbackEnabled: false,
    }),
    user
  );
  assert.equal(saved.policyName, "replacement policy");
  assert.equal(saved.autoMatchEnabled, false);
  assert.equal(saved.gradeFallbackEnabled, false);
  assert.equal(saved.policyId, initial.policyId);
  assert.equal(saved.version, initial.version + 1);
  assert.deepEqual(saved.tiers[0].saleGradeValues, ["B"]);
  const saveAudit = await prisma.employee_activity_logs.findFirstOrThrow({
    where: {
      action_type: "ORDER_MATCHING_POLICY_SAVE",
      target_id: String(salesOfferId),
    },
    orderBy: { id: "desc" },
    include: { changes: true },
  });
  assert(
    saveAudit.changes.length > 0,
    "A successful policy save must retain structured before/after audit evidence."
  );

  const replacementState = policyState(await persistedPolicy());
  const saveLogsBeforeStaleMutations = await successfulLogCount(
    "ORDER_MATCHING_POLICY_SAVE"
  );
  const resetLogsBeforeStaleMutations = await successfulLogCount(
    "ORDER_MATCHING_POLICY_RESET"
  );
  await expectStalePolicyMutation(
    () =>
      saveSalesOfferOrderMatchingPolicy(
        policyInput("stale replacement", ["A"], {
          expectedPolicyId: initial.policyId,
          expectedVersion: initial.version,
        }),
        user
      ),
    initial
  );
  await expectStalePolicyMutation(
    () =>
      resetSalesOfferOrderMatchingPolicy(
        {
          salesOfferId,
          expectedPolicyId: initial.policyId,
          expectedVersion: initial.version,
        },
        user
      ),
    initial
  );
  assert.deepEqual(
    policyState(await persistedPolicy()),
    replacementState,
    "Stale save and reset requests must not change the policy or its tiers."
  );
  assert.equal(
    await successfulLogCount("ORDER_MATCHING_POLICY_SAVE"),
    saveLogsBeforeStaleMutations,
    "A stale save must not create a success audit."
  );
  assert.equal(
    await successfulLogCount("ORDER_MATCHING_POLICY_RESET"),
    resetLogsBeforeStaleMutations,
    "A stale reset must not create a success audit."
  );

  const savedPolicy = await persistedPolicy();
  const savedPolicyId = savedPolicy.policy_id;
  const resetResult = await resetSalesOfferOrderMatchingPolicy(
    {
      salesOfferId,
      expectedPolicyId: saved.policyId,
      expectedVersion: saved.version,
    },
    user
  );
  assert.deepEqual(resetResult, { salesOfferId, reset: true });
  assert.equal(await persistedPolicy(), null);
  assert.equal(
    await prisma.order_matching_priority_tiers.count({
      where: { policy_id: savedPolicyId },
    }),
    0,
    "A successful reset must cascade to saved priority tiers."
  );
  assert.equal(
    await successfulLogCount("ORDER_MATCHING_POLICY_RESET"),
    1
  );

  await expectStalePolicyMutation(
    () =>
      resetSalesOfferOrderMatchingPolicy(
        {
          salesOfferId,
          expectedPolicyId: saved.policyId,
          expectedVersion: saved.version,
        },
        user
      ),
    saved
  );
  assert.equal(
    await successfulLogCount("ORDER_MATCHING_POLICY_RESET"),
    1,
    "Resetting an absent policy must be rejected without a success audit."
  );

  const recreated = await saveSalesOfferOrderMatchingPolicy(
    policyInput("recreated policy", ["A"]),
    user
  );
  assert.notEqual(
    recreated.policyId,
    saved.policyId,
    "Recreating a reset policy must allocate a new policy identity."
  );
  const recreatedState = policyState(await persistedPolicy());
  await expectStalePolicyMutation(
    () =>
      saveSalesOfferOrderMatchingPolicy(
        policyInput("ABA stale save", ["B"], {
          expectedPolicyId: saved.policyId,
          expectedVersion: saved.version,
        }),
        user
      ),
    saved
  );
  await expectStalePolicyMutation(
    () =>
      resetSalesOfferOrderMatchingPolicy(
        {
          salesOfferId,
          expectedPolicyId: saved.policyId,
          expectedVersion: saved.version,
        },
        user
      ),
    saved
  );
  assert.deepEqual(
    policyState(await persistedPolicy()),
    recreatedState,
    "A deleted policy identity must not mutate a recreated version-one policy."
  );
  await resetSalesOfferOrderMatchingPolicy(
    {
      salesOfferId,
      expectedPolicyId: recreated.policyId,
      expectedVersion: recreated.version,
    },
    user
  );

  const saveLogsBeforeConcurrency = await successfulLogCount(
    "ORDER_MATCHING_POLICY_SAVE"
  );
  const concurrentInputs = [
    policyInput("concurrent A", ["A"]),
    policyInput("concurrent B", ["B"]),
  ];
  const concurrentResults = await Promise.allSettled(
    concurrentInputs.map((input) =>
      saveSalesOfferOrderMatchingPolicy(input, user)
    )
  );
  const successfulConcurrentPolicies = concurrentResults.flatMap(
    (result) => (result.status === "fulfilled" ? [result.value] : [])
  );
  assert(
    successfulConcurrentPolicies.length === 1,
    "Only one concurrent create from the same default state may complete."
  );
  assert.equal(
    (await successfulLogCount("ORDER_MATCHING_POLICY_SAVE")) -
      saveLogsBeforeConcurrency,
    successfulConcurrentPolicies.length,
    "Every successful concurrent save must have exactly one success audit."
  );
  const concurrentFinalPolicy = policyState(await persistedPolicy());
  assert(
    successfulConcurrentPolicies.some(
      (policy) =>
        policy.policyName === concurrentFinalPolicy.policyName &&
        policy.tiers[0].saleGradeValues[0] ===
          concurrentFinalPolicy.tiers[0].saleGradeValues[0]
    ),
    "Concurrent saves produced a policy assembled from different requests."
  );

  const concurrentWinner = successfulConcurrentPolicies[0];
  const updateFromSharedSnapshot = await saveSalesOfferOrderMatchingPolicy(
    policyInput("shared snapshot winner", ["A"], {
      expectedPolicyId: concurrentWinner.policyId,
      expectedVersion: concurrentWinner.version,
    }),
    user
  );
  await expectStalePolicyMutation(
    () =>
      saveSalesOfferOrderMatchingPolicy(
        policyInput("shared snapshot loser", ["B"], {
          expectedPolicyId: concurrentWinner.policyId,
          expectedVersion: concurrentWinner.version,
        }),
        user
      ),
    concurrentWinner
  );
  assert.equal(updateFromSharedSnapshot.version, concurrentWinner.version + 1);
  assert.equal(
    (await persistedPolicy()).policy_name,
    "shared snapshot winner",
    "A stale writer from the same snapshot overwrote the successful update."
  );

  console.log(
    "Order matching policy mutation and success audit atomicity verified."
  );
} finally {
  if (prisma) {
    await prisma
      .$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS fail_order_matching_policy_save_audit ON employee_activity_logs"
      )
      .catch(() => undefined);
    await prisma
      .$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS fail_order_matching_policy_reset_audit ON employee_activity_logs"
      )
      .catch(() => undefined);
    await prisma
      .$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS quickhack_test_fail_order_matching_policy_audit()"
      )
      .catch(() => undefined);
    await prisma.$disconnect();
  }
  temporaryDatabase.cleanup();
}
