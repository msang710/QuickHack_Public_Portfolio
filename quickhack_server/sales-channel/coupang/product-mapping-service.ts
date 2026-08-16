// QuickHack note: 채널 상품 옵션을 판매 상품 정의에 연결하고 주문 작업 큐에 재적용합니다.
import { prisma } from "@/quickhack_server/core/prisma";
import { findInventoryCandidatesForSalesOffer } from "@/quickhack_server/catalog/sales-offer-candidate-service";
import {
  getSalesOfferMatchingDefinition,
} from "@/quickhack_server/catalog/sales-offer-service";
import { getSalesOfferOrderMatchingPolicy } from "@/quickhack_server/sales-channel/order-matching-policy-service";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  getCoupangSellerProduct,
  getCoupangSellerProducts,
  openCoupangApiCredentialContext,
} from "@/quickhack_server/sales-channel/coupang/api-client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import {
  warrantyGroupFromSaleGrade,
  warrantyGroupLabel,
} from "@/quickhack_shared/sales-channel/sales-matching";
import {
  CHANNEL_ORDER_MAPPING_FAILURE_REASONS,
  includesRandomMatchingOptionText,
  isRandomMatchingOption,
  RANDOM_MATCHING_OPTION_VALUE,
} from "@/quickhack_shared/sales-channel/order-matching";
import {
  publicBadRequest,
  publicNotFound,
  publicUnavailable,
} from "@/quickhack_server/core/public-error";
import {
  applyChangedMappingSnapshotToWorkItem,
  type OrderMappingApplicationOutcome,
} from "@/quickhack_server/sales-channel/coupang/order-mapping-snapshot-service";
import {
  apiDateTime,
  databaseNow,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

const COUPANG_CHANNEL = "COUPANG";
const MAPPING_STATUS = {
  mapped: "MAPPED",
  unmapped: "UNMAPPED",
} as const;
const PRODUCT_DETAIL_CONCURRENCY = 6;
const MAX_PRODUCT_CATALOG_PAGES = 1000;
const RAW_ORDER_PAIR_BATCH_SIZE = 100;
const MATCHING_FAILURE_REASON = CHANNEL_ORDER_MAPPING_FAILURE_REASONS;

type ProductCatalogDependencies = {
  openCredentialContext?: typeof openCoupangApiCredentialContext;
  getSellerProducts?: typeof getCoupangSellerProducts;
  getSellerProduct?: typeof getCoupangSellerProduct;
  maxPages?: number;
  detailConcurrency?: number;
};

type CoupangShipmentIdentity = {
  external_order_id: string;
  external_shipment_id: string;
};

type CoupangOrderActivityWorkItem = CoupangShipmentIdentity & {
  external_vendor_item_id: string;
};

function shipmentPairKey(input: CoupangShipmentIdentity) {
  return JSON.stringify([
    input.external_order_id,
    input.external_shipment_id,
  ]);
}

function uniqueShipmentPairs(items: readonly CoupangShipmentIdentity[]) {
  const pairs = new Map<string, CoupangShipmentIdentity>();

  for (const item of items) {
    const pair = {
      external_order_id: item.external_order_id,
      external_shipment_id: item.external_shipment_id,
    };

    pairs.set(shipmentPairKey(pair), pair);
  }

  return Array.from(pairs.values());
}

function chunks<T>(items: readonly T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

export async function loadCoupangVendorItemLastOrderedAt(
  items: readonly CoupangOrderActivityWorkItem[]
) {
  const lastOrderedAtByVendorItemId = new Map<string, Date | null>();
  const shipmentPairs = uniqueShipmentPairs(items);
  const rawOrderRows: Array<{
    external_order_id: string;
    external_shipment_id: string;
    ordered_at: Date | null;
  }> = [];

  for (const item of items) {
    if (!lastOrderedAtByVendorItemId.has(item.external_vendor_item_id)) {
      lastOrderedAtByVendorItemId.set(item.external_vendor_item_id, null);
    }
  }

  for (const batch of chunks(shipmentPairs, RAW_ORDER_PAIR_BATCH_SIZE)) {
    rawOrderRows.push(
      ...(await prisma.coupang_order_raw.findMany({
        where: {
          OR: batch.map((pair) => ({
            external_order_id: pair.external_order_id,
            external_shipment_id: pair.external_shipment_id,
          })),
        },
        select: {
          external_order_id: true,
          external_shipment_id: true,
          ordered_at: true,
        },
      }))
    );
  }

  const rawOrdersByShipmentPair = new Map(
    rawOrderRows.map((order) => [shipmentPairKey(order), order])
  );

  for (const item of items) {
    const orderedAt = rawOrdersByShipmentPair.get(
      shipmentPairKey(item)
    )?.ordered_at;
    const current = lastOrderedAtByVendorItemId.get(
      item.external_vendor_item_id
    );

    if (orderedAt && (!current || orderedAt.getTime() > current.getTime())) {
      lastOrderedAtByVendorItemId.set(
        item.external_vendor_item_id,
        orderedAt
      );
    }
  }

  return lastOrderedAtByVendorItemId;
}

function nullableText(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function requiredText(value: unknown, fieldName: string) {
  const text = nullableText(value);

  if (!text) {
    throw publicBadRequest(
      "COUPANG_PRODUCT_MAPPING_VALUE_REQUIRED",
      `${fieldName} 값이 필요합니다.`
    );
  }

  return text;
}

function mappingSnapshot(
  mapping: {
    mapping_id: number;
    channel: string;
    external_product_id: string | null;
    external_vendor_item_id: string;
    external_option_name: string | null;
    sales_offer_id: number | null;
    mapping_status: string;
    mapped_at: Date | null;
    updated_at: Date;
  } | null
) {
  if (!mapping) {
    return null;
  }

  return {
    id: mapping.mapping_id,
    channel: mapping.channel,
    externalProductId: mapping.external_product_id,
    externalVendorItemId: mapping.external_vendor_item_id,
    externalOptionName: mapping.external_option_name,
    salesOfferId: mapping.sales_offer_id,
    mappingStatus: mapping.mapping_status,
    mappedAt: apiDateTime(mapping.mapped_at),
    updatedAt: requiredApiDateTime(mapping.updated_at),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

type CoupangProductOption = {
  productId: string | null;
  sellerProductId: string | null;
  sellerProductName: string | null;
  sellerProductItemName: string | null;
  vendorItemId: string;
  vendorItemName: string | null;
  vendorSkuCode: string | null;
  quickhackModel: string | null;
  quickhackColor: string | null;
  quickhackCapacity: string | null;
  quickhackGrade: string | null;
  quickhackGradeGroupCode: string | null;
  quickhackGradeGroupLabel: string | null;
  currentQuantitySnapshot: number;
  averagePriceSnapshot: number;
  updatedAt: string | null;
};

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSaleGrade(value: unknown) {
  const text = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  if (!text) {
    return null;
  }

  if (text === "APLUS" || text === "A+") {
    return "A";
  }

  if (text === "AMINUS" || text === "A-" || text === "A_MINUS") {
    return "A-";
  }

  if (
    text === "BPLUS" ||
    text === "B+" ||
    text === "B_PLUS" ||
    text.includes("플")
  ) {
    return "B+";
  }

  if (text === "B") {
    return "B";
  }

  return text;
}

function parseQuickHackSku(value: unknown) {
  const sku = nullableText(value);

  if (!sku) {
    return {
      model: null,
      capacity: null,
      color: null,
      grade: null,
      gradeGroupCode: null,
      gradeGroupLabel: null,
    };
  }

  const parts = sku.split("_").filter(Boolean);

  if (parts.length < 5 || parts[0] !== "QH") {
    return {
      model: null,
      capacity: null,
      color: null,
      grade: null,
      gradeGroupCode: null,
      gradeGroupLabel: null,
    };
  }

  const gradeIndex = parts.length - 1;
  const capacityIndex = parts.findIndex(
    (part, index) =>
      index > 0 && index < gradeIndex && /^\d+(GB|TB)$/i.test(part)
  );

  if (capacityIndex < 0) {
    return {
      model: null,
      capacity: null,
      color: null,
      grade: null,
      gradeGroupCode: null,
      gradeGroupLabel: null,
    };
  }

  const grade = normalizeSaleGrade(parts[gradeIndex]);
  const capacity = nullableText(parts[capacityIndex]);
  const colorParts = parts.slice(capacityIndex + 1, gradeIndex);
  const color = colorParts.length > 0 ? colorParts.join("_") : null;
  const modelParts = parts.slice(1, capacityIndex);
  const model = modelParts.length > 0 ? modelParts.join("_") : null;
  const gradeGroupCode = warrantyGroupFromSaleGrade(grade);

  return {
    model,
    capacity,
    color,
    grade,
    gradeGroupCode,
    gradeGroupLabel: warrantyGroupLabel(gradeGroupCode),
  };
}

function inferRandomColorFromCoupangOption(...values: unknown[]) {
  return values.some((value) => includesRandomMatchingOptionText(value))
    ? RANDOM_MATCHING_OPTION_VALUE
    : null;
}

function normalizeColorCondition(value: unknown) {
  const text = nullableText(value);

  if (!text) {
    return null;
  }

  return isRandomMatchingOption(text) ? RANDOM_MATCHING_OPTION_VALUE : text;
}

function normalizeCoupangProductOption(
  value: unknown,
  product: Record<string, unknown> = {}
): CoupangProductOption | null {
  if (!isRecord(value)) {
    return null;
  }

  const quickhack = isRecord(value.quickhack) ? value.quickhack : {};
  const vendorItemId = nullableText(value.vendorItemId);
  const vendorSkuCode =
    nullableText(value.externalVendorSku) ??
    nullableText(value.externalVendorSkuCode) ??
    nullableText(value.vendorSkuCode);
  const skuParts = parseQuickHackSku(vendorSkuCode);
  const quickhackColor = normalizeColorCondition(quickhack.color);
  const skuColor = normalizeColorCondition(skuParts.color);
  const inferredRandomColor = inferRandomColorFromCoupangOption(
    value.sellerProductItemName,
    value.vendorItemName,
    value.itemName,
    value.externalVendorSku,
    value.externalVendorSkuCode,
    value.vendorSkuCode
  );
  const quickhackGrade =
    normalizeSaleGrade(quickhack.grade) ?? normalizeSaleGrade(skuParts.grade);
  const quickhackGradeGroupCode =
    nullableText(quickhack.gradeGroupCode) ??
    warrantyGroupFromSaleGrade(quickhackGrade) ??
    skuParts.gradeGroupCode;

  if (!vendorItemId) {
    return null;
  }

  return {
    productId: nullableText(value.productId) ?? nullableText(product.productId),
    sellerProductId:
      nullableText(value.sellerProductId) ?? nullableText(product.sellerProductId),
    sellerProductName:
      nullableText(value.sellerProductName) ??
      nullableText(product.sellerProductName),
    sellerProductItemName:
      nullableText(value.sellerProductItemName) ?? nullableText(value.itemName),
    vendorItemId,
    vendorItemName:
      nullableText(value.vendorItemName) ??
      nullableText(value.itemName) ??
      nullableText(value.sellerProductItemName),
    vendorSkuCode,
    quickhackModel: nullableText(quickhack.model) ?? skuParts.model,
    quickhackColor: quickhackColor ?? inferredRandomColor ?? skuColor,
    quickhackCapacity: nullableText(quickhack.capacity) ?? skuParts.capacity,
    quickhackGrade,
    quickhackGradeGroupCode,
    quickhackGradeGroupLabel:
      nullableText(quickhack.gradeGroupLabel) ??
      warrantyGroupLabel(quickhackGradeGroupCode),
    currentQuantitySnapshot:
      numberValue(value.currentQuantitySnapshot) ||
      numberValue(value.maximumBuyCount),
    averagePriceSnapshot:
      numberValue(value.averagePriceSnapshot) || numberValue(value.salePrice),
    updatedAt:
      nullableText(value.updatedAt) ??
      nullableText(product.updatedAt) ??
      nullableText(product.createdAt),
  };
}

function productOptionsFromPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return [];
  }

  const data = isRecord(payload.data) ? payload.data : {};
  return asArray(data.products)
    .map((item) => normalizeCoupangProductOption(item))
    .filter((item): item is CoupangProductOption => Boolean(item));
}

function sellerProductsFromPayload(payload: unknown) {
  if (!isRecord(payload)) {
    throw publicUnavailable(
      "COUPANG_CATALOG_PAYLOAD_INVALID",
      "쿠팡 상품 목록 응답 형식을 확인할 수 없습니다."
    );
  }

  const data = isRecord(payload.data) ? payload.data : {};
  const hasOfficialList = Array.isArray(payload.data);
  const hasLegacyProductList = Array.isArray(data.sellerProducts);
  const hasEmbeddedOptionList = Array.isArray(data.products);

  if (!hasOfficialList && !hasLegacyProductList && !hasEmbeddedOptionList) {
    throw publicUnavailable(
      "COUPANG_CATALOG_PAYLOAD_INVALID",
      "쿠팡 상품 목록 응답에서 상품 배열을 확인할 수 없습니다."
    );
  }

  return {
    nextToken: nullableText(payload.nextToken) ?? nullableText(data.nextToken),
    products: (Array.isArray(payload.data) ? payload.data : asArray(data.sellerProducts))
      .filter(isRecord),
    options: productOptionsFromPayload(payload),
  };
}

function productDetailOptionsFromPayload(
  payload: unknown,
  product: Record<string, unknown>
) {
  if (!isRecord(payload)) {
    return [];
  }

  const data = isRecord(payload.data) ? payload.data : {};
  const productInfo = {
    ...product,
    productId: data.productId ?? product.productId,
    sellerProductId: data.sellerProductId ?? product.sellerProductId,
    sellerProductName: data.sellerProductName ?? product.sellerProductName,
    updatedAt: data.updatedAt ?? data.createdAt ?? product.updatedAt,
  };

  return asArray(data.items)
    .map((item) =>
      normalizeCoupangProductOption(item, productInfo as Record<string, unknown>)
    )
    .filter((item): item is CoupangProductOption => Boolean(item));
}

export async function listCoupangProductOptions(
  dependencies: ProductCatalogDependencies = {}
) {
  const options: CoupangProductOption[] = [];
  const products: Record<string, unknown>[] = [];
  const seenTokens = new Set<string>();
  const openCredentialContext =
    dependencies.openCredentialContext ?? openCoupangApiCredentialContext;
  const getSellerProducts =
    dependencies.getSellerProducts ?? getCoupangSellerProducts;
  const getSellerProduct =
    dependencies.getSellerProduct ?? getCoupangSellerProduct;
  const maxPages = Math.max(
    1,
    dependencies.maxPages ?? MAX_PRODUCT_CATALOG_PAGES
  );
  const detailConcurrency = Math.max(
    1,
    dependencies.detailConcurrency ?? PRODUCT_DETAIL_CONCURRENCY
  );
  const credentialContext = await openCredentialContext("CACHED_READ");
  let nextToken: string | null = null;
  let pageCount = 0;

  do {
    if (nextToken && seenTokens.has(nextToken)) {
      throw publicUnavailable(
        "COUPANG_CATALOG_PAGINATION_INCOMPLETE",
        "쿠팡 상품 목록의 페이지 토큰이 반복되어 전체 목록을 확인하지 못했습니다."
      );
    }

    if (nextToken) {
      seenTokens.add(nextToken);
    }

    if (pageCount >= maxPages) {
      throw publicUnavailable(
        "COUPANG_CATALOG_PAGE_LIMIT_EXCEEDED",
        "쿠팡 상품 목록이 안전 조회 한도를 초과해 전체 목록을 확인하지 못했습니다."
      );
    }

    const response = await getSellerProducts({
      nextToken,
      maxPerPage: 100,
    }, credentialContext);
    const page = sellerProductsFromPayload(response.payload);

    options.push(...page.options);
    products.push(...page.products);
    nextToken = page.nextToken;
    pageCount += 1;
  } while (nextToken);

  for (let index = 0; index < products.length; index += detailConcurrency) {
    const chunk = products.slice(index, index + detailConcurrency);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (product) => {
        const sellerProductId = nullableText(product.sellerProductId);

        if (!sellerProductId) {
          throw publicUnavailable(
            "COUPANG_CATALOG_PRODUCT_ID_MISSING",
            "쿠팡 상품 목록에 sellerProductId가 없는 항목이 있어 전체 옵션을 확인하지 못했습니다."
          );
        }

        const detailResponse = await getSellerProduct(
          sellerProductId,
          credentialContext
        );
        const detailOptions = productDetailOptionsFromPayload(
          detailResponse.payload,
          product
        );

        if (detailOptions.length === 0) {
          throw publicUnavailable(
            "COUPANG_CATALOG_PRODUCT_DETAIL_INCOMPLETE",
            `쿠팡 상품 ${sellerProductId}의 옵션 상세를 확인하지 못했습니다.`
          );
        }

        return detailOptions;
      })
    );

    for (const result of chunkResults) {
      if (result.status === "rejected") {
        throw publicUnavailable(
          "COUPANG_CATALOG_PRODUCT_DETAIL_FAILED",
          "쿠팡 상품 상세 일부를 확인하지 못해 전체 목록을 갱신하지 않았습니다.",
          { failedDetailCount: 1 }
        );
      }

      options.push(...result.value);
    }
  }

  const optionsByVendorItemId = new Map<string, CoupangProductOption>();

  for (const option of options) {
    optionsByVendorItemId.set(option.vendorItemId, option);
  }

  return {
    options: Array.from(optionsByVendorItemId.values()),
    pageCount,
    sellerProductCount: products.length,
    optionCount: optionsByVendorItemId.size,
    completedAt: requiredApiDateTime(databaseNow()),
  };
}

export async function resolveChannelOrderItemMapping(input: {
  channel?: unknown;
  externalVendorItemId?: unknown;
}) {
  const channel = nullableText(input.channel) ?? COUPANG_CHANNEL;
  const externalVendorItemId = requiredText(
    input.externalVendorItemId,
    "externalVendorItemId"
  );
  const mapping = await prisma.sales_channel_product_mappings.findUnique({
    where: {
      channel_external_vendor_item_id: {
        channel,
        external_vendor_item_id: externalVendorItemId,
      },
    },
  });

  if (!mapping) {
    return {
      channel,
      externalVendorItemId,
      mappingStatus: MAPPING_STATUS.unmapped,
      salesOfferId: null,
      salesOfferCode: null,
      requiredStorage: null,
      requiredColor: null,
      requiredWarrantyGroup: null,
      matchingFailureReason: MATCHING_FAILURE_REASON.noChannelProductMapping,
    };
  }

  if (
    mapping.mapping_status !== MAPPING_STATUS.mapped ||
    !mapping.sales_offer_id
  ) {
    return {
      channel,
      externalVendorItemId,
      mappingStatus: MAPPING_STATUS.unmapped,
      salesOfferId: null,
      salesOfferCode: null,
      requiredStorage: null,
      requiredColor: null,
      requiredWarrantyGroup: null,
      matchingFailureReason: MATCHING_FAILURE_REASON.salesOfferNotMapped,
    };
  }

  const offer = await getSalesOfferMatchingDefinition(
    prisma,
    mapping.sales_offer_id
  );

  if (!offer) {
    return {
      channel,
      externalVendorItemId,
      mappingStatus: MAPPING_STATUS.unmapped,
      salesOfferId: null,
      salesOfferCode: null,
      requiredStorage: null,
      requiredColor: null,
      requiredWarrantyGroup: null,
      matchingFailureReason: MATCHING_FAILURE_REASON.salesOfferNotFound,
    };
  }

  return {
    channel,
    externalVendorItemId,
    mappingStatus: MAPPING_STATUS.mapped,
    salesOfferId: offer.salesOfferId,
    salesOfferCode: offer.offerCode,
    requiredStorage: offer.requiredStorage,
    requiredColor: offer.requiredColor,
    requiredWarrantyGroup: offer.requiredWarrantyGroup,
    matchingFailureReason: null,
  };
}

export async function listCoupangProductMappings() {
  const mappings = await prisma.sales_channel_product_mappings.findMany({
    where: { channel: COUPANG_CHANNEL },
    orderBy: [{ mapping_status: "asc" }, { updated_at: "desc" }],
    include: {
      sales_offer: {
        include: {
          model_option: true,
          storage_option: true,
          color_option: true,
          warranty_group_option: true,
        },
      },
    },
  });
  const vendorItemIds = mappings.map((mapping) => mapping.external_vendor_item_id);
  const orderItems =
    vendorItemIds.length === 0
      ? []
      : await prisma.order_matching_work_queue.findMany({
          where: {
            external_vendor_item_id: { in: vendorItemIds },
            channel: COUPANG_CHANNEL,
          },
          orderBy: { work_item_id: "desc" },
        });
  const orderItemsByVendorItemId = new Map<string, typeof orderItems>();

  for (const item of orderItems) {
    const current = orderItemsByVendorItemId.get(item.external_vendor_item_id) ?? [];

    current.push(item);
    orderItemsByVendorItemId.set(item.external_vendor_item_id, current);
  }

  return mappings.map((mapping) => {
    const items = orderItemsByVendorItemId.get(mapping.external_vendor_item_id) ?? [];
    const sample = items[0] ?? null;
    const offer = mapping.sales_offer;
    const requiredStorage = offer
      ? offer.storage_match_mode === "RANDOM"
        ? RANDOM_MATCHING_OPTION_VALUE
        : offer.storage_match_mode === "EXACT"
          ? offer.storage_option?.label ?? null
          : null
      : null;
    const requiredColor = offer
      ? offer.color_match_mode === "RANDOM"
        ? RANDOM_MATCHING_OPTION_VALUE
        : offer.color_match_mode === "EXACT"
          ? offer.color_option?.label ?? null
          : null
      : null;
    const warrantyGroup = offer?.warranty_group_option.option_key ?? null;

    return {
      id: mapping.mapping_id,
      channel: mapping.channel,
      externalProductId: mapping.external_product_id,
      externalVendorItemId: mapping.external_vendor_item_id,
      externalOptionName: mapping.external_option_name,
      mappingStatus: mapping.mapping_status,
      salesOfferId: mapping.sales_offer_id,
      salesOfferCode: offer?.offer_code ?? null,
      model: offer?.model_option.label ?? null,
      requiredStorage,
      requiredColor,
      requiredWarrantyGroup: warrantyGroup,
      requiredWarrantyLabel: warrantyGroupLabel(warrantyGroup),
      mappedAt: mapping.mapped_at,
      orderItemCount: items.length,
      sample: sample
        ? {
            vendorItemName: sample.vendor_item_name,
            sellerProductName: sample.seller_product_name,
            sellerProductItemName: sample.seller_product_item_name,
            externalVendorSkuCode: sample.external_vendor_sku_code,
          }
        : null,
      updatedAt: mapping.updated_at,
    };
  });
}

export async function listCoupangChannelProducts() {
  const catalog = await listCoupangProductOptions();
  const channelProducts = catalog.options;
  const channelProductsByVendorItemId = new Map(
    channelProducts.map((product) => [product.vendorItemId, product])
  );
  const mappings = await prisma.sales_channel_product_mappings.findMany({
    where: { channel: COUPANG_CHANNEL },
    orderBy: [
      { external_product_id: "asc" },
      { external_option_name: "asc" },
      { external_vendor_item_id: "asc" },
    ],
    include: {
      sales_offer: {
        include: {
          model_option: true,
          storage_option: true,
          color_option: true,
          warranty_group_option: true,
        },
      },
    },
  });
  const vendorItemIds = Array.from(
    new Set([
      ...mappings.map((mapping) => mapping.external_vendor_item_id),
      ...channelProducts.map((product) => product.vendorItemId),
    ])
  );
  const orderItems =
    vendorItemIds.length === 0
      ? []
      : await prisma.order_matching_work_queue.findMany({
          where: {
            external_vendor_item_id: { in: vendorItemIds },
            channel: COUPANG_CHANNEL,
          },
          orderBy: { work_item_id: "desc" },
        });
  const lastOrderedAtByVendorItemId =
    await loadCoupangVendorItemLastOrderedAt(orderItems);
  const orderItemsByVendorItemId = new Map<string, typeof orderItems>();

  for (const item of orderItems) {
    const current = orderItemsByVendorItemId.get(item.external_vendor_item_id) ?? [];

    current.push(item);
    orderItemsByVendorItemId.set(item.external_vendor_item_id, current);
  }

  const optionRows = mappings.map((mapping) => {
    const items = orderItemsByVendorItemId.get(mapping.external_vendor_item_id) ?? [];
    const sample = items[0] ?? null;
    const channelProduct = channelProductsByVendorItemId.get(
      mapping.external_vendor_item_id
    );
    const offer = mapping.sales_offer;
    const requiredStorage = offer
      ? offer.storage_match_mode === "RANDOM"
        ? RANDOM_MATCHING_OPTION_VALUE
        : offer.storage_match_mode === "EXACT"
          ? offer.storage_option?.label ?? null
          : null
      : null;
    const requiredColor = offer
      ? offer.color_match_mode === "RANDOM"
        ? RANDOM_MATCHING_OPTION_VALUE
        : offer.color_match_mode === "EXACT"
          ? offer.color_option?.label ?? null
          : null
      : null;
    const warrantyGroup = offer?.warranty_group_option.option_key ?? null;
    const orderItemCount = items.length;
    const availableQuantity = items.reduce(
      (sum, item) => sum + item.matchable_quantity,
      0
    );
    const cancelQuantity = items.reduce(
      (sum, item) => sum + item.canceled_quantity,
      0
    );
    const lastOrderedAt =
      apiDateTime(
        lastOrderedAtByVendorItemId.get(mapping.external_vendor_item_id)
      );
    const externalProductId =
      mapping.external_product_id ||
      sample?.seller_product_id ||
      channelProduct?.sellerProductId ||
      channelProduct?.productId ||
      null;

    return {
      mappingId: mapping.mapping_id,
      channel: mapping.channel,
      externalProductId,
      productKey: externalProductId || `VENDOR:${mapping.external_vendor_item_id}`,
      productName:
        sample?.seller_product_name ?? channelProduct?.sellerProductName ?? null,
      externalVendorItemId: mapping.external_vendor_item_id,
      externalOptionName:
        mapping.external_option_name ??
        channelProduct?.sellerProductItemName ??
        null,
      vendorItemName:
        sample?.vendor_item_name ?? channelProduct?.vendorItemName ?? null,
      sellerProductItemName:
        sample?.seller_product_item_name ??
        channelProduct?.sellerProductItemName ??
        null,
      externalVendorSkuCode:
        sample?.external_vendor_sku_code ?? channelProduct?.vendorSkuCode ?? null,
      mappingStatus: mapping.mapping_status,
      salesOfferId: mapping.sales_offer_id,
      salesOfferCode: offer?.offer_code ?? null,
      model: offer?.model_option.label ?? null,
      requiredStorage:
        requiredStorage ?? channelProduct?.quickhackCapacity ?? null,
      requiredColor:
        requiredColor ?? channelProduct?.quickhackColor ?? null,
      requiredWarrantyGroup:
        warrantyGroup ?? channelProduct?.quickhackGradeGroupCode ?? null,
      requiredWarrantyLabel:
        warrantyGroup
          ? warrantyGroupLabel(warrantyGroup)
          : channelProduct?.quickhackGradeGroupLabel ??
            warrantyGroupLabel(channelProduct?.quickhackGradeGroupCode),
      orderItemCount,
      availableQuantity,
      cancelQuantity,
      lastOrderedAt,
      mappedAt: apiDateTime(mapping.mapped_at),
      updatedAt: requiredApiDateTime(mapping.updated_at),
    };
  });
  const optionRowsByVendorItemId = new Map(
    optionRows.map((option) => [option.externalVendorItemId, option])
  );

  for (const product of channelProducts) {
    if (optionRowsByVendorItemId.has(product.vendorItemId)) {
      continue;
    }

    const items = orderItemsByVendorItemId.get(product.vendorItemId) ?? [];
    const orderItemCount = items.length;
    const availableQuantity = items.reduce(
      (sum, item) => sum + item.matchable_quantity,
      0
    );
    const cancelQuantity = items.reduce(
      (sum, item) => sum + item.canceled_quantity,
      0
    );
    const lastOrderedAt =
      apiDateTime(lastOrderedAtByVendorItemId.get(product.vendorItemId));
    const externalProductId = product.sellerProductId || product.productId;

    optionRows.push({
      mappingId: 0,
      channel: COUPANG_CHANNEL,
      externalProductId,
      productKey: externalProductId || `VENDOR:${product.vendorItemId}`,
      productName: product.sellerProductName,
      externalVendorItemId: product.vendorItemId,
      externalOptionName: product.sellerProductItemName,
      vendorItemName: product.vendorItemName,
      sellerProductItemName: product.sellerProductItemName,
      externalVendorSkuCode: product.vendorSkuCode,
      mappingStatus: MAPPING_STATUS.unmapped,
      salesOfferId: null,
      salesOfferCode: null,
      model: null,
      requiredStorage: product.quickhackCapacity,
      requiredColor: product.quickhackColor,
      requiredWarrantyGroup: product.quickhackGradeGroupCode,
      requiredWarrantyLabel:
        product.quickhackGradeGroupLabel ??
        warrantyGroupLabel(product.quickhackGradeGroupCode),
      orderItemCount,
      availableQuantity,
      cancelQuantity,
      lastOrderedAt,
      mappedAt: null,
      updatedAt: product.updatedAt ?? "",
    });
  }
  const productsByKey = new Map<string, typeof optionRows>();

  for (const option of optionRows) {
    const current = productsByKey.get(option.productKey) ?? [];

    current.push(option);
    productsByKey.set(option.productKey, current);
  }

  const items = Array.from(productsByKey.entries())
    .map(([productKey, options]) => {
      const first = options[0];
      const productName =
        options.find((option) => option.productName)?.productName ??
        first?.externalOptionName ??
        first?.vendorItemName ??
        first?.externalVendorItemId ??
        "-";
      const mappedOptionCount = options.filter(
        (option) => option.mappingStatus === MAPPING_STATUS.mapped
      ).length;
      const orderItemCount = options.reduce(
        (sum, option) => sum + option.orderItemCount,
        0
      );
      const availableQuantity = options.reduce(
        (sum, option) => sum + option.availableQuantity,
        0
      );
      const updatedAt =
        options
          .map((option) => option.updatedAt)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null;
      const lastOrderedAt =
        options
          .map((option) => option.lastOrderedAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null;

      return {
        productKey,
        channel: first?.channel ?? COUPANG_CHANNEL,
        externalProductId: first?.externalProductId ?? null,
        productName,
        optionCount: options.length,
        mappedOptionCount,
        unmappedOptionCount: options.length - mappedOptionCount,
        orderItemCount,
        availableQuantity,
        lastOrderedAt,
        updatedAt,
        options,
      };
    })
    .sort((left, right) => {
      const statusDelta = right.unmappedOptionCount - left.unmappedOptionCount;

      return (
        statusDelta ||
        left.productName.localeCompare(right.productName, "ko-KR", {
          numeric: true,
          sensitivity: "base",
        })
      );
    });

  return {
    items,
    completeness: {
      complete: true,
      pageCount: catalog.pageCount,
      sellerProductCount: catalog.sellerProductCount,
      optionCount: catalog.optionCount,
      completedAt: catalog.completedAt,
    },
  };
}

export async function setCoupangProductMapping(input: {
  externalVendorItemId?: unknown;
  salesOfferId?: unknown;
}, user?: AuthUser) {
  const externalVendorItemId = requiredText(
    input.externalVendorItemId,
    "externalVendorItemId"
  );
  const parsedSalesOfferId = Number(input.salesOfferId ?? 0);
  const salesOfferId =
    Number.isInteger(parsedSalesOfferId) && parsedSalesOfferId > 0
      ? parsedSalesOfferId
      : null;
  const now = databaseNow();
  const mappingStatus = salesOfferId
    ? MAPPING_STATUS.mapped
    : MAPPING_STATUS.unmapped;

  return prisma.$transaction(async (tx) => {
    let offerDefinition: Awaited<
      ReturnType<typeof getSalesOfferMatchingDefinition>
    > = null;

    if (salesOfferId) {
      // Mapping changes and offer deactivation lock the same row first. This keeps
      // the "current mappings require an active offer" rule race-free on PG too.
      await tx.$queryRaw`
        SELECT sales_offer_id
        FROM sales_offers
        WHERE sales_offer_id = ${salesOfferId}
        FOR UPDATE
      `;
      const offer = await tx.sales_offers.findUnique({
        where: { sales_offer_id: salesOfferId },
      });

      if (!offer || offer.is_active !== 1) {
        throw publicNotFound(
          "ACTIVE_SALES_OFFER_NOT_FOUND",
          `활성 판매 오퍼를 찾을 수 없습니다: ${salesOfferId}`
        );
      }

      offerDefinition = await getSalesOfferMatchingDefinition(tx, salesOfferId);

      if (!offerDefinition) {
        throw publicNotFound(
          "ACTIVE_SALES_OFFER_NOT_FOUND",
          `활성 판매 오퍼를 찾을 수 없습니다: ${salesOfferId}`
        );
      }
    }
    const snapshot = {
      mappingStatus,
      salesOfferId,
      mappingFailureReason: salesOfferId
        ? null
        : MATCHING_FAILURE_REASON.salesOfferNotMapped,
      requiredModelLabel: offerDefinition?.model ?? null,
      requiredStorageLabel: offerDefinition?.requiredStorage ?? null,
      requiredColorLabel: offerDefinition?.requiredColor ?? null,
      requiredWarrantyGroup:
        offerDefinition?.requiredWarrantyGroup ?? null,
    };

    await tx.$queryRaw`
      SELECT mapping_id
      FROM sales_channel_product_mappings
      WHERE channel = ${COUPANG_CHANNEL}
        AND external_vendor_item_id = ${externalVendorItemId}
      FOR UPDATE
    `;
    const before = await tx.sales_channel_product_mappings.findUnique({
      where: {
        channel_external_vendor_item_id: {
          channel: COUPANG_CHANNEL,
          external_vendor_item_id: externalVendorItemId,
        },
      },
    });
    const mappingChanged =
      !before ||
      before.sales_offer_id !== salesOfferId ||
      before.mapping_status !== mappingStatus;
    const mapping = mappingChanged
      ? await tx.sales_channel_product_mappings.upsert({
          where: {
            channel_external_vendor_item_id: {
              channel: COUPANG_CHANNEL,
              external_vendor_item_id: externalVendorItemId,
            },
          },
          create: {
            channel: COUPANG_CHANNEL,
            external_vendor_item_id: externalVendorItemId,
            sales_offer_id: salesOfferId,
            mapping_status: mappingStatus,
            mapped_by_user_id: salesOfferId ? user?.userId ?? null : null,
            mapped_at: salesOfferId ? now : null,
            created_at: now,
            updated_at: now,
          },
          update: {
            sales_offer_id: salesOfferId,
            mapping_status: mappingStatus,
            mapped_by_user_id: salesOfferId ? user?.userId ?? null : null,
            mapped_at: salesOfferId ? now : null,
            updated_at: now,
          },
        })
      : before;
    const outcomeCounts: Record<OrderMappingApplicationOutcome, number> = {
      UPDATED: 0,
      UNCHANGED: 0,
      PROTECTED_BY_WORK_STATUS: 0,
      PROTECTED_BY_ACTIVE_ALLOCATION: 0,
    };

    if (mappingChanged) {
      const orderItems = await tx.order_matching_work_queue.findMany({
        where: {
          channel: COUPANG_CHANNEL,
          external_vendor_item_id: externalVendorItemId,
        },
        select: { work_item_id: true },
        orderBy: { work_item_id: "asc" },
      });

      for (const orderItem of orderItems) {
        const applied = await applyChangedMappingSnapshotToWorkItem({
          tx,
          workItemId: orderItem.work_item_id,
          snapshot,
          timestamp: now,
        });
        outcomeCounts[applied.outcome] += 1;
      }
    }

    const result = {
      id: mapping.mapping_id,
      externalVendorItemId: mapping.external_vendor_item_id,
      mappingStatus: mapping.mapping_status,
      salesOfferId: mapping.sales_offer_id,
      mappingChanged,
      updatedOrderItemCount: outcomeCounts.UPDATED,
      unchangedOrderItemCount: outcomeCounts.UNCHANGED,
      protectedOrderItemCount:
        outcomeCounts.PROTECTED_BY_WORK_STATUS +
        outcomeCounts.PROTECTED_BY_ACTIVE_ALLOCATION,
      protectedByWorkStatusCount: outcomeCounts.PROTECTED_BY_WORK_STATUS,
      protectedByActiveAllocationCount:
        outcomeCounts.PROTECTED_BY_ACTIVE_ALLOCATION,
    };

    if (user) {
      await tx.employee_activity_logs.create({
        data: {
          user_id: user.userId,
          action_type: "CHANNEL_ORDER_MAPPING_SET",
          target_type: "CHANNEL_PRODUCT_MAPPING",
          target_id: `${COUPANG_CHANNEL}:${externalVendorItemId}`,
          ...activityLogChangeData(
            {
              mapping: mappingSnapshot(before),
              outcome: null,
            },
            {
              mapping: mappingSnapshot(mapping),
              outcome: {
                mappingChanged: result.mappingChanged,
                updatedOrderItemCount: result.updatedOrderItemCount,
                unchangedOrderItemCount: result.unchangedOrderItemCount,
                protectedOrderItemCount: result.protectedOrderItemCount,
                protectedByWorkStatusCount:
                  result.protectedByWorkStatusCount,
                protectedByActiveAllocationCount:
                  result.protectedByActiveAllocationCount,
              },
            }
          ),
          result: "SUCCESS",
          created_at: now,
        },
      });
    }

    return result;
  });
}

export async function getCoupangInventoryCandidates(externalVendorItemId: string) {
  const mapping = await prisma.sales_channel_product_mappings.findUnique({
    where: {
      channel_external_vendor_item_id: {
        channel: COUPANG_CHANNEL,
        external_vendor_item_id: externalVendorItemId,
      },
    },
  });

  if (!mapping) {
    return {
      mappingStatus: "NOT_FOUND",
      externalVendorItemId,
      salesOfferId: null,
      salesOfferCode: null,
      requiredStorage: null,
      requiredColor: null,
      candidates: [],
      warnings: ["쿠팡 상품 매핑 행을 찾을 수 없습니다."],
    };
  }

  if (mapping.mapping_status !== "MAPPED" || !mapping.sales_offer_id) {
    return {
      mappingStatus: mapping.mapping_status,
      externalVendorItemId,
      salesOfferId: mapping.sales_offer_id,
      salesOfferCode: null,
      requiredStorage: null,
      requiredColor: null,
      candidates: [],
      warnings: ["판매 상품 조합 매핑 전에는 재고 후보를 조회하지 않습니다."],
    };
  }

  const offer = await getSalesOfferMatchingDefinition(
    prisma,
    mapping.sales_offer_id
  );

  if (!offer) {
    return {
      mappingStatus: "INVALID_OFFER",
      externalVendorItemId,
      salesOfferId: mapping.sales_offer_id,
      salesOfferCode: null,
      requiredStorage: null,
      requiredColor: null,
      candidates: [],
      warnings: ["연결된 판매 오퍼가 없거나 비활성화되어 있습니다."],
    };
  }

  const policy = await getSalesOfferOrderMatchingPolicy(mapping.sales_offer_id);
  const result = await findInventoryCandidatesForSalesOffer(
    mapping.sales_offer_id,
    {
      candidateSortMode: policy?.candidateSortMode,
      gradeFallbackEnabled: policy?.gradeFallbackEnabled,
      saleGradeGroups: policy?.tiers.map((tier) => tier.saleGradeValues),
    }
  );

  return {
    mappingStatus: mapping.mapping_status,
    externalVendorItemId,
    salesOfferId: offer.salesOfferId,
    salesOfferCode: offer.offerCode,
    requiredStorage: offer.requiredStorage,
    requiredColor: offer.requiredColor,
    ...result,
  };
}
