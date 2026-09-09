import type { Prisma } from "@/generated/prisma/client";
import type { InventoryCandidateWarning } from "@/quickhack_shared/catalog/inventory-candidate-warning";
import { prisma } from "@/quickhack_server/core/prisma";
import { SELLABLE_INVENTORY_STATUSES } from "@/quickhack_shared/inventory/inventory-status";
import {
  ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES,
  INVENTORY_MATCH_FAILURE_REASONS,
} from "@/quickhack_shared/sales-channel/order-matching";
import {
  ORDER_MATCHING_DEFAULT_POLICY_VALUES,
  type OrderMatchingCandidateSortMode,
} from "@/quickhack_shared/sales-channel/order-matching-policy";
import {
  SALE_GRADE_PRIORITY_BY_WARRANTY_GROUP,
  isWarrantyGroupCode,
  warrantyGroupLabel,
} from "@/quickhack_shared/sales-channel/sales-matching";

const DEFAULT_CANDIDATE_LIMIT = 50;
const RANDOM_CANDIDATE_POOL_SIZE = 500;

type CandidateOptions = {
  candidateSortMode?: OrderMatchingCandidateSortMode | null;
  gradeFallbackEnabled?: boolean;
  saleGradeGroups?: string[][];
  allowInactiveOffer?: boolean;
};

type CandidateDevice = Prisma.devicesGetPayload<{
  include: {
    inventory: true;
    inventory_sku: {
      include: {
        model_option: true;
        storage_option: true;
        color_option: true;
        sale_grade_option: true;
      };
    };
    match_worker_allocations: {
      where: { allocation_status: { in: string[] } };
      take: 1;
    };
  };
}>;

function nullableText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function uniqueTexts(values: string[]) {
  return [...new Set(values.map(nullableText).filter(Boolean) as string[])];
}

function stockedOrderBy(
  candidateSortMode: OrderMatchingCandidateSortMode
): Prisma.devicesOrderByWithRelationInput[] {
  const direction =
    candidateSortMode === "SALE_GRADE_THEN_STOCKED_RECENT" ||
    candidateSortMode === "STOCKED_RECENT_THEN_SALE_GRADE"
      ? "desc"
      : "asc";

  return [{ inventory: { stocked_at: direction } }, { device_id: "asc" }];
}

function isStockedFirst(candidateSortMode: OrderMatchingCandidateSortMode) {
  return (
    candidateSortMode === "STOCKED_OLD_THEN_SALE_GRADE" ||
    candidateSortMode === "STOCKED_RECENT_THEN_SALE_GRADE"
  );
}

function randomBucketRows(
  rows: CandidateDevice[],
  randomStorage: boolean,
  randomColor: boolean
) {
  if (!randomStorage && !randomColor) {
    return rows.slice(0, DEFAULT_CANDIDATE_LIMIT);
  }

  const buckets = new Map<string, CandidateDevice[]>();

  for (const row of rows) {
    const parts = [];

    if (randomStorage) {
      parts.push(`storage:${row.inventory_sku?.storage_option_id ?? 0}`);
    }

    if (randomColor) {
      parts.push(`color:${row.inventory_sku?.color_option_id ?? 0}`);
    }

    const key = parts.join("|");
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }

  const values = [...buckets.values()];

  if (values.length === 0) {
    return [];
  }

  return values[Math.floor(Math.random() * values.length)]?.slice(
    0,
    DEFAULT_CANDIDATE_LIMIT
  ) ?? [];
}

export async function findInventoryCandidatesForSalesOffer(
  salesOfferId: number,
  options: CandidateOptions = {}
) {
  const offer = await prisma.sales_offers.findUnique({
    where: { sales_offer_id: salesOfferId },
    include: {
      model_option: true,
      storage_option: true,
      color_option: true,
      warranty_group_option: true,
    },
  });

  if (!offer || (!options.allowInactiveOffer && offer.is_active !== 1)) {
    return {
      offer: null,
      candidates: [],
      warnings: [{ code: "ACTIVE_OFFER_NOT_FOUND" }] satisfies InventoryCandidateWarning[],
      failureReason: INVENTORY_MATCH_FAILURE_REASONS.noChannelSalesOffer,
    };
  }

  const warrantyGroup = offer.warranty_group_option.option_key.toUpperCase();

  if (!isWarrantyGroupCode(warrantyGroup)) {
    return {
      offer: null,
      candidates: [],
      warnings: [{ code: "INVALID_WARRANTY_GROUP" }] satisfies InventoryCandidateWarning[],
      failureReason: INVENTORY_MATCH_FAILURE_REASONS.noChannelSalesOffer,
    };
  }

  const defaultGradeGroups = SALE_GRADE_PRIORITY_BY_WARRANTY_GROUP[warrantyGroup];
  const configuredGradeGroups = (options.saleGradeGroups ?? [])
    .map(uniqueTexts)
    .filter((values) => values.length > 0);
  const gradeGroups =
    configuredGradeGroups.length > 0 ? configuredGradeGroups : defaultGradeGroups;
  const effectiveGradeGroups =
    options.gradeFallbackEnabled === false ? gradeGroups.slice(0, 1) : gradeGroups;
  const gradeValues = uniqueTexts(effectiveGradeGroups.flat());
  const gradeOptions = await prisma.product_criteria_options.findMany({
    where: {
      category: "SALE_GRADE",
      option_key: { in: gradeValues },
    },
    select: { option_id: true, option_key: true },
  });
  const gradeIdByValue = new Map(
    gradeOptions.map((option) => [option.option_key.toUpperCase(), option.option_id])
  );
  const candidateSortMode =
    options.candidateSortMode ??
    ORDER_MATCHING_DEFAULT_POLICY_VALUES.candidateSortMode;
  const randomStorage = offer.storage_match_mode === "RANDOM";
  const randomColor = offer.color_match_mode === "RANDOM";
  const take =
    randomStorage || randomColor
      ? RANDOM_CANDIDATE_POOL_SIZE
      : DEFAULT_CANDIDATE_LIMIT;
  const baseSkuWhere: Prisma.inventory_skusWhereInput = {
    model_option_id: offer.model_option_id,
    ...(offer.storage_match_mode === "EXACT"
      ? { storage_option_id: offer.storage_option_id ?? -1 }
      : {}),
    ...(offer.color_match_mode === "EXACT"
      ? { color_option_id: offer.color_option_id ?? -1 }
      : {}),
  };
  const baseDeviceWhere: Prisma.devicesWhereInput = {
    inventory_sku_id: { not: null },
    inventory: {
      is: { inventory_status: { in: [...SELLABLE_INVENTORY_STATUSES] } },
    },
    match_worker_allocations: {
      none: {
        allocation_status: {
          in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
        },
      },
    },
  };

  async function findRows(saleGrades: string[]) {
    const saleGradeOptionIds = uniqueTexts(saleGrades)
      .map((value) => gradeIdByValue.get(value.toUpperCase()))
      .filter((value): value is number => Number.isInteger(value));

    if (saleGrades.length > 0 && saleGradeOptionIds.length === 0) {
      return [];
    }

    return prisma.devices.findMany({
      where: {
        ...baseDeviceWhere,
        inventory_sku: {
          is: {
            ...baseSkuWhere,
            ...(saleGradeOptionIds.length > 0
              ? { sale_grade_option_id: { in: saleGradeOptionIds } }
              : {}),
          },
        },
      },
      orderBy: stockedOrderBy(candidateSortMode),
      take,
      include: {
        inventory: true,
        inventory_sku: {
          include: {
            model_option: true,
            storage_option: true,
            color_option: true,
            sale_grade_option: true,
          },
        },
        match_worker_allocations: {
          where: {
            allocation_status: {
              in: [...ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES],
            },
          },
          take: 1,
        },
      },
    });
  }

  let rows: CandidateDevice[] = [];
  let fallbackApplied = false;
  let matchedGradeValues: string[] = [];

  if (isStockedFirst(candidateSortMode)) {
    matchedGradeValues = gradeValues;
    rows = randomBucketRows(
      await findRows(gradeValues),
      randomStorage,
      randomColor
    );
  } else {
    for (let index = 0; index < effectiveGradeGroups.length; index += 1) {
      const group = effectiveGradeGroups[index] ?? [];
      const found = await findRows(group);

      if (found.length > 0 || index === effectiveGradeGroups.length - 1) {
        fallbackApplied = index > 0;
        matchedGradeValues = group;
        rows = randomBucketRows(found, randomStorage, randomColor);
        break;
      }
    }
  }

  const warnings: InventoryCandidateWarning[] = [];

  if (randomStorage) {
    warnings.push({ code: "RANDOM_STORAGE_BUCKET" });
  }

  if (randomColor) {
    warnings.push({ code: "RANDOM_COLOR_BUCKET" });
  }

  if (fallbackApplied) {
    warnings.push({
      code: "GRADE_FALLBACK",
      args: {
        warrantyGroup: warrantyGroupLabel(warrantyGroup),
        grades: matchedGradeValues.join(", "),
      },
    });
  }

  const candidates = rows.flatMap((device) => {
    const sku = device.inventory_sku;

    if (!sku) {
      return [];
    }

    return [{
      deviceId: device.device_id,
      pgNo: device.pg_no,
      imei: device.imei,
      inventorySkuId: sku.inventory_sku_id,
      skuCode: sku.sku_code,
      model: sku.model_option.label,
      modelSeq: device.model_seq,
      storage: sku.storage_option.label,
      color: sku.color_option.label,
      saleGrade: sku.sale_grade_option.option_key,
      grade: sku.sale_grade_option.option_key,
      deviceWarranty: device.warranty,
      saleWarranty: warrantyGroupLabel(warrantyGroup),
      warranty: warrantyGroupLabel(warrantyGroup),
      warrantyGroup,
      deviceStatus: device.inventory?.inventory_status ?? null,
      inventoryStatus: device.inventory?.inventory_status ?? null,
      location: device.inventory?.location ?? null,
      stockedAt: device.inventory?.stocked_at ?? null,
    }];
  });
  const failureReason =
    candidates.length > 0
      ? null
      : (await prisma.devices.count({
          where: {
            inventory_sku: {
              is: {
                model_option_id: offer.model_option_id,
              },
            },
          },
        })) === 0
        ? INVENTORY_MATCH_FAILURE_REASONS.noModelCandidate
        : INVENTORY_MATCH_FAILURE_REASONS.insufficientInventory;

  return {
    offer: {
      salesOfferId: offer.sales_offer_id,
      offerCode: offer.offer_code,
      model: offer.model_option.label,
      warrantyGroup,
      warrantyLabel: warrantyGroupLabel(warrantyGroup),
    },
    candidates,
    warnings,
    failureReason,
  };
}
