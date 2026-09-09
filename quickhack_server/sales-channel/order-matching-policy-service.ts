// QuickHack note: 주문 매칭 운영 정책과 판매 오퍼별 우선순위 단계를 조회/저장합니다.
import type { Prisma } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import {
  ORDER_MATCHING_CANDIDATE_SORT_MODES,
  ORDER_MATCHING_DEFAULT_POLICY_VALUES,
  ORDER_MATCHING_SALE_GRADE_VALUES,
  type OrderMatchingCandidateSortMode,
  type OrderMatchingPoliciesPayload,
  type OrderMatchingPolicyDto,
  type OrderMatchingPriorityTierDto,
  type OrderMatchingSalesOfferPolicyRow,
} from "@/quickhack_shared/sales-channel/order-matching-policy";
import {
  isWarrantyGroupCode,
  warrantyGroupLabel,
  type WarrantyGroupCode,
} from "@/quickhack_shared/sales-channel/sales-matching";
import { explicitActivityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  databaseNow,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { isPostgresqlUniqueViolation } from "@/quickhack_server/core/database/postgres-errors";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";

type PolicyRow = Awaited<
  ReturnType<typeof prisma.order_matching_policies.findMany>
>[number] & {
  tiers?: PriorityTierRow[];
};

type PriorityTierRow = Prisma.order_matching_priority_tiersGetPayload<{
  include: {
    sale_grades: {
      include: {
        sale_grade_option: {
          select: { option_key: true };
        };
      };
    };
  };
}>;

const DEFAULT_POLICY_VERSION = 1;

const policyTiersInclude = {
  tiers: {
    orderBy: { priority_order: "asc" as const },
    include: {
      sale_grades: {
        orderBy: { sort_order: "asc" as const },
        include: {
          sale_grade_option: {
            select: { option_key: true },
          },
        },
      },
    },
  },
};

type SalesOfferPolicyInput = Record<string, unknown>;
type TransactionClient = Prisma.TransactionClient;

type ExpectedPolicyState = {
  expectedPolicyId: number | null;
  expectedVersion: number;
};

function isUniqueConflict(error: unknown) {
  return isPostgresqlUniqueViolation(error);
}

function nullableText(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function boolValue(value: unknown, fallback = false) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return ["1", "true", "y", "yes"].includes(String(value).trim().toLowerCase());
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
  fieldName: string
): T[number] {
  const text = nullableText(value) ?? fallback;

  if (!allowed.includes(text)) {
    throw publicBadRequest(
      "INVALID_ORDER_MATCHING_POLICY_VALUE",
      "INVALID_ORDER_MATCHING_POLICY_VALUE"
    );
  }

  return text;
}

function candidateSortModeValue(value: unknown): OrderMatchingCandidateSortMode {
  const text = nullableText(value);

  if (
    text === "STOCKED_OLD_FIRST" ||
    text === "STOCKED_OLD_THEN_SALE_GRADE"
  ) {
    return "STOCKED_OLD_THEN_SALE_GRADE";
  }

  if (
    text === "DEVICE_ID_ASC" ||
    text === "PG_ASC" ||
    text === "MODEL_SEQ_ASC" ||
    text === "SALE_GRADE_THEN_STOCKED_OLD"
  ) {
    return "SALE_GRADE_THEN_STOCKED_OLD";
  }

  return enumValue(
    text,
    ORDER_MATCHING_CANDIDATE_SORT_MODES,
    ORDER_MATCHING_DEFAULT_POLICY_VALUES.candidateSortMode,
    "candidateSortMode"
  );
}

function normalizeTextArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  const text = nullableText(value);

  return text
    ? text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function saleGradeValuesForTier(tier: PriorityTierRow) {
  return (tier.sale_grades ?? [])
    .slice()
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((item) => item.sale_grade_option.option_key.trim())
    .filter(Boolean);
}

function normalizeSaleGradeValues(value: unknown, index: number) {
  const values = Array.from(
    new Set(normalizeTextArray(value).map((item) => item.toUpperCase()))
  );

  if (values.length === 0) {
    throw publicBadRequest(
      "ORDER_MATCHING_SALE_GRADE_REQUIRED",
      "ORDER_MATCHING_SALE_GRADE_REQUIRED"
    );
  }

  const invalidValue = values.find(
    (item) => !ORDER_MATCHING_SALE_GRADE_VALUES.some((value) => value === item)
  );

  if (invalidValue) {
    throw publicBadRequest(
      "INVALID_ORDER_MATCHING_SALE_GRADE",
      "INVALID_ORDER_MATCHING_SALE_GRADE"
    );
  }

  return values;
}

function tiersForWarrantyGroup(value: unknown): OrderMatchingPriorityTierDto[] {
  const warrantyGroup = isWarrantyGroupCode(value) ? value : null;
  const gradesByWarrantyGroup: Record<WarrantyGroupCode, string[]> = {
    "2Y": ["A", "A-", "B+"],
    "1Y": ["B+", "B"],
  };
  const grades = warrantyGroup
    ? gradesByWarrantyGroup[warrantyGroup]
    : ["A", "A-", "B+", "B"];

  return grades.map((grade, index) => ({
    priorityOrder: index + 1,
    saleGradeValues: [grade],
    isEnabled: true,
  }));
}

function defaultPolicy(input: {
  salesOfferId: number;
  requiredWarrantyGroup: string | null;
}): OrderMatchingPolicyDto {
  return {
    policyId: null,
    salesOfferId: input.salesOfferId,
    policyName: null,
    autoMatchEnabled: ORDER_MATCHING_DEFAULT_POLICY_VALUES.autoMatchEnabled,
    candidateSortMode: ORDER_MATCHING_DEFAULT_POLICY_VALUES.candidateSortMode,
    gradeFallbackEnabled:
      ORDER_MATCHING_DEFAULT_POLICY_VALUES.gradeFallbackEnabled,
    isActive: true,
    version: DEFAULT_POLICY_VERSION,
    source: "DEFAULT",
    tiers: tiersForWarrantyGroup(input.requiredWarrantyGroup),
    updatedAt: null,
  };
}

function policyDto(row: PolicyRow): OrderMatchingPolicyDto {
  return {
    policyId: row.policy_id,
    salesOfferId: row.sales_offer_id,
    policyName: row.policy_name,
    autoMatchEnabled: row.auto_match_enabled === 1,
    candidateSortMode: candidateSortModeValue(row.candidate_sort_mode),
    gradeFallbackEnabled: row.grade_fallback_enabled === 1,
    isActive: row.is_active === 1,
    version: row.version,
    source: "SAVED",
    tiers:
      row.tiers && row.tiers.length > 0
        ? row.tiers.map((tier) => ({
            tierId: tier.tier_id,
            priorityOrder: tier.priority_order,
            saleGradeValues: saleGradeValuesForTier(tier),
            isEnabled: tier.is_enabled === 1,
          }))
        : [],
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

function normalizeTier(input: unknown, index: number): OrderMatchingPriorityTierDto {
  const item = typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
  const saleGradeValues = normalizeSaleGradeValues(item.saleGradeValues, index);

  return {
    priorityOrder: index + 1,
    saleGradeValues,
    isEnabled: boolValue(item.isEnabled, true),
  };
}

function normalizeSalesOfferPolicyInput(input: SalesOfferPolicyInput) {
  const salesOfferId = Number(input.salesOfferId ?? 0);

  if (!Number.isInteger(salesOfferId) || salesOfferId <= 0) {
    throw publicBadRequest(
      "SALES_OFFER_ID_REQUIRED",
      "SALES_OFFER_ID_REQUIRED"
    );
  }
  const rawTiers = Array.isArray(input.tiers) ? input.tiers : [];
  const tiers = rawTiers.map(normalizeTier).filter((tier) => tier.isEnabled);

  if (tiers.length === 0) {
    throw publicBadRequest(
      "ORDER_MATCHING_PRIORITY_REQUIRED",
      "ORDER_MATCHING_PRIORITY_REQUIRED"
    );
  }

  return {
    salesOfferId,
    ...normalizeExpectedPolicyState(input),
    policyName: nullableText(input.policyName),
    autoMatchEnabled: boolValue(input.autoMatchEnabled, true),
    candidateSortMode: candidateSortModeValue(input.candidateSortMode),
    gradeFallbackEnabled: boolValue(input.gradeFallbackEnabled, true),
    tiers,
  };
}

function normalizePositiveInteger(value: unknown) {
  const numberValue = Number(value);

  return Number.isInteger(numberValue) && numberValue > 0
    ? numberValue
    : null;
}

function normalizeExpectedPolicyState(
  input: SalesOfferPolicyInput,
  options: { policyIdRequired?: boolean } = {}
): ExpectedPolicyState {
  const expectedVersion = normalizePositiveInteger(input.expectedVersion);
  const expectedPolicyId =
    input.expectedPolicyId === null
      ? null
      : normalizePositiveInteger(input.expectedPolicyId);
  const invalidPolicyId =
    expectedPolicyId === null && input.expectedPolicyId !== null;
  const missingRequiredPolicyId =
    expectedPolicyId === null && options.policyIdRequired === true;
  const invalidDefaultVersion =
    expectedPolicyId === null &&
    expectedVersion !== null &&
    expectedVersion !== DEFAULT_POLICY_VERSION;

  if (
    expectedVersion === null ||
    invalidPolicyId ||
    missingRequiredPolicyId ||
    invalidDefaultVersion
  ) {
    throw publicBadRequest(
      "INVALID_ORDER_MATCHING_POLICY_EXPECTED_STATE",
      "INVALID_ORDER_MATCHING_POLICY_EXPECTED_STATE"
    );
  }

  return { expectedPolicyId, expectedVersion };
}

function policyMatchesExpectedState(
  policy: Pick<PolicyRow, "policy_id" | "version"> | null,
  expected: ExpectedPolicyState
) {
  if (expected.expectedPolicyId === null) {
    return policy === null;
  }

  return (
    policy?.policy_id === expected.expectedPolicyId &&
    policy.version === expected.expectedVersion
  );
}

function stalePolicyError(input: {
  salesOfferId: number;
  expectedPolicyId: number | null;
  expectedVersion: number;
}) {
  const details = {
    salesOfferId: input.salesOfferId,
    expectedPolicyId: input.expectedPolicyId,
    expectedVersion: input.expectedVersion,
  };

  return publicConflict(
    "ORDER_MATCHING_POLICY_STALE_STATE",
    "ORDER_MATCHING_POLICY_STALE_STATE",
    details
  );
}

async function logPolicyChange(client: TransactionClient, input: {
  user: AuthUser;
  targetId: string;
  before: OrderMatchingPolicyDto | null;
  after: OrderMatchingPolicyDto | null;
  actionType: string;
}) {
  await client.employee_activity_logs.create({
    data: {
      user_id: input.user.userId,
      action_type: input.actionType,
      target_type: "ORDER_MATCHING_POLICY",
      target_id: input.targetId,
      ...orderMatchingPolicyAuditChangeData(input.before, input.after),
      result: "SUCCESS",
      created_at: databaseNow(),
    },
  });
}

function auditText(value: string | number | boolean | null | undefined) {
  return value === null || value === undefined ? null : String(value);
}

function policyAuditSummary(policy: OrderMatchingPolicyDto | null) {
  return policy
    ? `policyId=${policy.policyId ?? "default"} / version=${policy.version} / tiers=${policy.tiers.length}`
    : "policy=absent";
}

export function orderMatchingPolicyAuditChangeData(
  before: OrderMatchingPolicyDto | null,
  after: OrderMatchingPolicyDto | null
) {
  const changes = [
    "policyId",
    "salesOfferId",
    "policyName",
    "autoMatchEnabled",
    "candidateSortMode",
    "gradeFallbackEnabled",
    "isActive",
    "version",
    "source",
  ].map((fieldName) => ({
    fieldName: `policy.${fieldName}`,
    beforeValue: auditText(before?.[fieldName as keyof OrderMatchingPolicyDto] as string | number | boolean | null | undefined),
    afterValue: auditText(after?.[fieldName as keyof OrderMatchingPolicyDto] as string | number | boolean | null | undefined),
  }));
  const beforeTiers = new Map(
    (before?.tiers ?? []).map((tier) => [tier.priorityOrder, tier])
  );
  const afterTiers = new Map(
    (after?.tiers ?? []).map((tier) => [tier.priorityOrder, tier])
  );
  const priorities = Array.from(
    new Set([...beforeTiers.keys(), ...afterTiers.keys()])
  ).sort((left, right) => left - right);

  for (const priority of priorities) {
    const beforeTier = beforeTiers.get(priority);
    const afterTier = afterTiers.get(priority);
    changes.push(
      {
        fieldName: `tiers.${priority}.isEnabled`,
        beforeValue: auditText(beforeTier?.isEnabled),
        afterValue: auditText(afterTier?.isEnabled),
      },
      {
        fieldName: `tiers.${priority}.saleGradeValues`,
        beforeValue: beforeTier?.saleGradeValues.join(", ") ?? null,
        afterValue: afterTier?.saleGradeValues.join(", ") ?? null,
      }
    );
  }

  return explicitActivityLogChangeData(
    changes.filter((change) => change.beforeValue !== change.afterValue),
    {
      beforeSummary: policyAuditSummary(before),
      afterSummary: policyAuditSummary(after),
    }
  );
}

export async function listOrderMatchingPolicies(): Promise<OrderMatchingPoliciesPayload> {
  const offers = await prisma.sales_offers.findMany({
    include: {
      model_option: { select: { label: true } },
      storage_option: { select: { label: true } },
      color_option: { select: { label: true } },
      warranty_group_option: { select: { option_key: true, label: true } },
    },
    orderBy: [
      { is_active: "desc" },
      { model_option_id: "asc" },
      { warranty_group_option_id: "desc" },
      { sales_offer_id: "asc" },
    ],
  });
  const offerIds = offers.map((offer) => offer.sales_offer_id);
  const [mappings, orderItemCounts, savedPolicyRows] = await Promise.all([
    offerIds.length === 0
      ? []
      : prisma.sales_channel_product_mappings.findMany({
          where: {
            sales_offer_id: { in: offerIds },
            mapping_status: "MAPPED",
          },
          select: {
            channel: true,
            sales_offer_id: true,
          },
        }),
    offerIds.length === 0
      ? []
      : prisma.order_matching_work_queue.groupBy({
          by: ["sales_offer_id"],
          where: { sales_offer_id: { in: offerIds } },
          _count: {
            _all: true,
          },
        }),
    offerIds.length === 0
      ? []
      : prisma.order_matching_policies.findMany({
          where: {
            sales_offer_id: { in: offerIds },
          },
          include: policyTiersInclude,
        }),
  ]);
  const mappingCountByOfferId = new Map<number, number>();
  const channelsByOfferId = new Map<number, Set<string>>();

  for (const mapping of mappings) {
    if (!mapping.sales_offer_id) {
      continue;
    }

    mappingCountByOfferId.set(
      mapping.sales_offer_id,
      (mappingCountByOfferId.get(mapping.sales_offer_id) ?? 0) + 1
    );

    const channels =
      channelsByOfferId.get(mapping.sales_offer_id) ?? new Set<string>();

    channels.add(mapping.channel);
    channelsByOfferId.set(mapping.sales_offer_id, channels);
  }

  const orderItemCountByOfferId = new Map(
    orderItemCounts
      .filter((item) => item.sales_offer_id)
      .map((item) => [
        item.sales_offer_id as number,
        item._count._all,
      ])
  );
  const policyByOfferId = new Map(
    savedPolicyRows
      .filter((policy) => policy.sales_offer_id)
      .map((policy) => [policy.sales_offer_id, policyDto(policy)])
  );
  const rows: OrderMatchingSalesOfferPolicyRow[] = offers.map((offer) => {
    const warrantyGroup = offer.warranty_group_option.option_key.toUpperCase();
    const requiredStorage =
      offer.storage_match_mode === "RANDOM"
        ? "__RANDOM__"
        : offer.storage_match_mode === "EXACT"
          ? offer.storage_option?.label ?? null
          : null;
    const requiredColor =
      offer.color_match_mode === "RANDOM"
        ? "__RANDOM__"
        : offer.color_match_mode === "EXACT"
          ? offer.color_option?.label ?? null
          : null;

    return {
      salesOfferId: offer.sales_offer_id,
      offerCode: offer.offer_code,
      model: offer.model_option.label,
      requiredStorage,
      requiredColor,
      requiredWarrantyGroup: warrantyGroup,
      requiredWarrantyLabel:
        offer.warranty_group_option.label || warrantyGroupLabel(warrantyGroup),
      isActive: offer.is_active === 1,
      channelNames: Array.from(
        channelsByOfferId.get(offer.sales_offer_id) ?? []
      ).sort(),
      mappedVendorItemCount:
        mappingCountByOfferId.get(offer.sales_offer_id) ?? 0,
      orderItemCount: orderItemCountByOfferId.get(offer.sales_offer_id) ?? 0,
      policy:
        policyByOfferId.get(offer.sales_offer_id) ??
        defaultPolicy({
          salesOfferId: offer.sales_offer_id,
          requiredWarrantyGroup: warrantyGroup,
        }),
    };
  });

  return { rows };
}

export async function getSalesOfferOrderMatchingPolicy(
  salesOfferId: number
): Promise<OrderMatchingPolicyDto | null> {
  const offer = await prisma.sales_offers.findUnique({
    where: { sales_offer_id: salesOfferId },
    include: {
      warranty_group_option: { select: { option_key: true } },
    },
  });

  if (!offer) {
    return null;
  }

  const saved = await prisma.order_matching_policies.findUnique({
    where: { sales_offer_id: salesOfferId },
    include: policyTiersInclude,
  });

  if (saved && saved.is_active === 1) {
    return policyDto(saved);
  }

  return defaultPolicy({
    salesOfferId,
    requiredWarrantyGroup: offer.warranty_group_option.option_key.toUpperCase(),
  });
}

export async function saveSalesOfferOrderMatchingPolicy(
  input: SalesOfferPolicyInput,
  user: AuthUser
) {
  const normalized = normalizeSalesOfferPolicyInput(input);
  const now = databaseNow();

  return prisma.$transaction(async (tx) => {
    const offer = await tx.sales_offers.findUnique({
      where: { sales_offer_id: normalized.salesOfferId },
    });

    if (!offer) {
      throw publicNotFound(
        "SALES_OFFER_NOT_FOUND",
        "SALES_OFFER_NOT_FOUND"
      );
    }

    const before = await tx.order_matching_policies.findUnique({
      where: { sales_offer_id: normalized.salesOfferId },
      include: policyTiersInclude,
    });

    if (!policyMatchesExpectedState(before, normalized)) {
      throw stalePolicyError(normalized);
    }

    const saleGradeValues = Array.from(
      new Set(normalized.tiers.flatMap((tier) => tier.saleGradeValues))
    );
    const saleGradeOptions = await tx.product_criteria_options.findMany({
      where: {
        category: "SALE_GRADE",
        option_key: { in: saleGradeValues },
        is_active: 1,
      },
      select: { option_id: true, option_key: true },
    });
    const saleGradeOptionIdByValue = new Map(
      saleGradeOptions.map((option) => [
        option.option_key.toUpperCase(),
        option.option_id,
      ])
    );
    const missingSaleGrade = saleGradeValues.find(
      (grade) => !saleGradeOptionIdByValue.has(grade.toUpperCase())
    );

    if (missingSaleGrade) {
      throw publicBadRequest(
        "ORDER_MATCHING_SALE_GRADE_NOT_FOUND",
        "ORDER_MATCHING_SALE_GRADE_NOT_FOUND"
      );
    }

    let policyId: number;

    if (normalized.expectedPolicyId === null) {
      try {
        const created = await tx.order_matching_policies.create({
          data: {
            sales_offer_id: normalized.salesOfferId,
            policy_name: normalized.policyName,
            auto_match_enabled: normalized.autoMatchEnabled ? 1 : 0,
            candidate_sort_mode: normalized.candidateSortMode,
            grade_fallback_enabled: normalized.gradeFallbackEnabled ? 1 : 0,
            is_active: 1,
            version: DEFAULT_POLICY_VERSION,
            created_by_user_id: user.userId,
            updated_by_user_id: user.userId,
            created_at: now,
            updated_at: now,
          },
        });
        policyId = created.policy_id;
      } catch (error) {
        if (isUniqueConflict(error)) {
          throw stalePolicyError(normalized);
        }

        throw error;
      }
    } else {
      const updated = await tx.order_matching_policies.updateMany({
        where: {
          policy_id: normalized.expectedPolicyId,
          sales_offer_id: normalized.salesOfferId,
          version: normalized.expectedVersion,
        },
        data: {
          policy_name: normalized.policyName,
          auto_match_enabled: normalized.autoMatchEnabled ? 1 : 0,
          candidate_sort_mode: normalized.candidateSortMode,
          grade_fallback_enabled: normalized.gradeFallbackEnabled ? 1 : 0,
          is_active: 1,
          version: { increment: 1 },
          updated_by_user_id: user.userId,
          updated_at: now,
        },
      });

      if (updated.count !== 1) {
        throw stalePolicyError(normalized);
      }

      policyId = normalized.expectedPolicyId;
    }

    await tx.order_matching_priority_tiers.deleteMany({
      where: { policy_id: policyId },
    });

    for (const tier of normalized.tiers) {
      const createdTier = await tx.order_matching_priority_tiers.create({
        data: {
          policy_id: policyId,
          priority_order: tier.priorityOrder,
          is_enabled: tier.isEnabled ? 1 : 0,
          created_at: now,
          updated_at: now,
        },
      });

      await tx.order_matching_priority_tier_sale_grades.createMany({
        data: tier.saleGradeValues.map((grade, index) => ({
          tier_id: createdTier.tier_id,
          sale_grade_option_id:
            saleGradeOptionIdByValue.get(grade.toUpperCase())!,
          sort_order: index + 1,
          created_at: now,
        })),
      });
    }

    const saved = await tx.order_matching_policies.findUniqueOrThrow({
      where: { sales_offer_id: normalized.salesOfferId },
      include: policyTiersInclude,
    });
    const item = policyDto(saved);

    await logPolicyChange(tx, {
      user,
      targetId: String(normalized.salesOfferId),
      before: before ? policyDto(before) : null,
      after: item,
      actionType: "ORDER_MATCHING_POLICY_SAVE",
    });

    return item;
  });
}

export async function resetSalesOfferOrderMatchingPolicy(
  input: SalesOfferPolicyInput,
  user: AuthUser
) {
  const salesOfferId = Number(input.salesOfferId ?? 0);

  if (!Number.isInteger(salesOfferId) || salesOfferId <= 0) {
    throw publicBadRequest(
      "SALES_OFFER_ID_REQUIRED",
      "SALES_OFFER_ID_REQUIRED"
    );
  }
  const expected = normalizeExpectedPolicyState(input, {
    policyIdRequired: true,
  });

  return prisma.$transaction(async (tx) => {
    const before = await tx.order_matching_policies.findUnique({
      where: { sales_offer_id: salesOfferId },
      include: policyTiersInclude,
    });

    if (!policyMatchesExpectedState(before, expected)) {
      throw stalePolicyError({ salesOfferId, ...expected });
    }

    const deleted = await tx.order_matching_policies.deleteMany({
      where: {
        policy_id: expected.expectedPolicyId!,
        sales_offer_id: salesOfferId,
        version: expected.expectedVersion,
      },
    });

    if (deleted.count !== 1) {
      throw stalePolicyError({ salesOfferId, ...expected });
    }

    await logPolicyChange(tx, {
      user,
      targetId: String(salesOfferId),
      before: before ? policyDto(before) : null,
      after: null,
      actionType: "ORDER_MATCHING_POLICY_RESET",
    });

    return { salesOfferId, reset: true };
  });
}
