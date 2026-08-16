// QuickHack note: 판매 채널 매핑의 기대 재고를 주문 후보 제한 없이 SELLABLE 원장에서 직접 집계합니다.
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  SALE_GRADE_PRIORITY_BY_WARRANTY_GROUP,
  isWarrantyGroupCode,
  type WarrantyGroupCode,
} from "@/quickhack_shared/sales-channel/sales-matching";

const COUPANG_CHANNEL = "COUPANG";
const SUPPORTED_MATCH_MODES = ["EXACT", "ANY", "RANDOM"] as const;

export const INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS = {
  mappingNotFound: "MAPPING_NOT_FOUND",
  mappingNotActive: "MAPPING_NOT_ACTIVE",
  unsupportedChannel: "UNSUPPORTED_CHANNEL",
  salesOfferNotActive: "SALES_OFFER_NOT_ACTIVE",
  invalidWarrantyGroup: "INVALID_WARRANTY_GROUP",
  invalidOfferCriteria: "INVALID_OFFER_CRITERIA",
  saleGradeOptionsMissing: "SALE_GRADE_OPTIONS_MISSING",
} as const;

type ProjectionSkipReason =
  (typeof INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS)[keyof typeof INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS];

type InventoryQuantityProjectionReadClient = Pick<
  Prisma.TransactionClient,
  | "sales_channel_product_mappings"
  | "product_criteria_options"
  | "inventory_quantity_balances"
>;

export type MappedOfferSellableQuantityProjection =
  | {
      status: "PROJECTED";
      mappingId: number;
      channel: string;
      externalVendorItemId: string;
      salesOfferId: number;
      salesOfferCode: string;
      warrantyGroup: WarrantyGroupCode;
      eligibleSaleGrades: string[];
      ledgerQuantity: number;
      mappingUpdatedAt: Date;
      projectionBasisHash: string;
    }
  | {
      status: "SKIPPED";
      mappingId: number;
      channel: string | null;
      externalVendorItemId: string | null;
      salesOfferId: number | null;
      ledgerQuantity: null;
      skipReason: ProjectionSkipReason;
      mappingUpdatedAt: Date | null;
      projectionBasisHash: string | null;
    };

function skippedProjection(input: {
  mappingId: number;
  channel?: string | null;
  externalVendorItemId?: string | null;
  salesOfferId?: number | null;
  skipReason: ProjectionSkipReason;
  mappingUpdatedAt?: Date | null;
  projectionBasisHash?: string | null;
}): MappedOfferSellableQuantityProjection {
  return {
    status: "SKIPPED",
    mappingId: input.mappingId,
    channel: input.channel ?? null,
    externalVendorItemId: input.externalVendorItemId ?? null,
    salesOfferId: input.salesOfferId ?? null,
    ledgerQuantity: null,
    skipReason: input.skipReason,
    mappingUpdatedAt: input.mappingUpdatedAt ?? null,
    projectionBasisHash: input.projectionBasisHash ?? null,
  };
}

function stableProjectionBasisHash(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isSupportedMatchMode(value: string) {
  return SUPPORTED_MATCH_MODES.includes(
    value as (typeof SUPPORTED_MATCH_MODES)[number]
  );
}

export async function calculateMappedOfferSellableQuantity(
  mappingId: number,
  client: InventoryQuantityProjectionReadClient = prisma
): Promise<MappedOfferSellableQuantityProjection> {
  const mapping = await client.sales_channel_product_mappings.findUnique({
    where: { mapping_id: mappingId },
    include: {
      sales_offer: {
        include: {
          warranty_group_option: {
            select: { option_key: true },
          },
        },
      },
    },
  });

  if (!mapping) {
    return skippedProjection({
      mappingId,
      skipReason: INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.mappingNotFound,
    });
  }

  const identity = {
    mappingId: mapping.mapping_id,
    channel: mapping.channel,
    externalVendorItemId: mapping.external_vendor_item_id,
    salesOfferId: mapping.sales_offer_id,
  };
  const offer = mapping.sales_offer;
  const basisInput = (
    projectionStatus: "PROJECTED" | ProjectionSkipReason,
    eligibleSaleGrades: string[] = []
  ) => ({
    projectionStatus,
    mappingId: mapping.mapping_id,
    channel: mapping.channel,
    externalVendorItemId: mapping.external_vendor_item_id,
    mappingStatus: mapping.mapping_status,
    mappingUpdatedAt: mapping.updated_at,
    salesOfferId: mapping.sales_offer_id,
    salesOfferUpdatedAt: offer?.updated_at ?? null,
    salesOfferActive: offer?.is_active ?? null,
    modelOptionId: offer?.model_option_id ?? null,
    storageMatchMode: offer?.storage_match_mode ?? null,
    storageOptionId: offer?.storage_option_id ?? null,
    colorMatchMode: offer?.color_match_mode ?? null,
    colorOptionId: offer?.color_option_id ?? null,
    warrantyGroup: offer?.warranty_group_option.option_key ?? null,
    eligibleSaleGrades: [...eligibleSaleGrades].sort(),
  });
  const skippedWithCurrentBasis = (skipReason: ProjectionSkipReason) =>
    skippedProjection({
      ...identity,
      mappingUpdatedAt: mapping.updated_at,
      projectionBasisHash: stableProjectionBasisHash(
        basisInput(skipReason)
      ),
      skipReason,
    });

  if (mapping.channel !== COUPANG_CHANNEL) {
    return skippedWithCurrentBasis(
      INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.unsupportedChannel
    );
  }

  if (mapping.mapping_status !== "MAPPED" || !mapping.sales_offer_id) {
    return skippedWithCurrentBasis(
      INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.mappingNotActive
    );
  }

  if (!offer || offer.is_active !== 1) {
    return skippedWithCurrentBasis(
      INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.salesOfferNotActive
    );
  }

  const warrantyGroup = offer.warranty_group_option.option_key
    .trim()
    .toUpperCase();

  if (!isWarrantyGroupCode(warrantyGroup)) {
    return skippedWithCurrentBasis(
      INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.invalidWarrantyGroup
    );
  }

  if (
    !isSupportedMatchMode(offer.storage_match_mode) ||
    !isSupportedMatchMode(offer.color_match_mode) ||
    (offer.storage_match_mode === "EXACT" && !offer.storage_option_id) ||
    (offer.color_match_mode === "EXACT" && !offer.color_option_id)
  ) {
    return skippedWithCurrentBasis(
      INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.invalidOfferCriteria
    );
  }

  const eligibleSaleGrades = Array.from(
    new Set(SALE_GRADE_PRIORITY_BY_WARRANTY_GROUP[warrantyGroup].flat())
  );
  const gradeOptions = await client.product_criteria_options.findMany({
    where: {
      category: "SALE_GRADE",
      option_key: { in: eligibleSaleGrades },
    },
    select: {
      option_id: true,
      option_key: true,
    },
  });

  if (gradeOptions.length === 0) {
    return skippedProjection({
      ...identity,
      mappingUpdatedAt: mapping.updated_at,
      projectionBasisHash: stableProjectionBasisHash(
        basisInput(
          INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.saleGradeOptionsMissing,
          eligibleSaleGrades
        )
      ),
      skipReason:
        INVENTORY_QUANTITY_PROJECTION_SKIP_REASONS.saleGradeOptionsMissing,
    });
  }

  const skuWhere: Prisma.inventory_skusWhereInput = {
    is_active: 1,
    model_option_id: offer.model_option_id,
    sale_grade_option_id: {
      in: gradeOptions.map((option) => option.option_id),
    },
    ...(offer.storage_match_mode === "EXACT"
      ? { storage_option_id: offer.storage_option_id! }
      : {}),
    ...(offer.color_match_mode === "EXACT"
      ? { color_option_id: offer.color_option_id! }
      : {}),
  };
  const balance = await client.inventory_quantity_balances.aggregate({
    where: {
      inventory_status: "SELLABLE",
      inventory_sku: { is: skuWhere },
    },
    _sum: { quantity: true },
  });

  return {
    status: "PROJECTED",
    ...identity,
    salesOfferId: offer.sales_offer_id,
    salesOfferCode: offer.offer_code,
    warrantyGroup,
    eligibleSaleGrades,
    ledgerQuantity: balance._sum.quantity ?? 0,
    mappingUpdatedAt: mapping.updated_at,
    projectionBasisHash: stableProjectionBasisHash(
      basisInput("PROJECTED", eligibleSaleGrades)
    ),
  };
}
