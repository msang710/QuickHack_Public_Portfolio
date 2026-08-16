import {
  MODEL_MAP,
  getCameraCheckByProduct,
} from "@/quickhack_client/adb/adb-config";
import {
  APPEARANCE_DEFECT_MAP,
  FUNCTION_DEFECT_MAP,
  GRADE_OPTIONS,
} from "@/quickhack_shared/inspection/inspection-schema";
import type { ProductCriteriaPayload } from "@/quickhack_shared/catalog/product-criteria";

export type ProductOption = {
  value: string;
  searchText: string;
  label?: string;
  description?: string;
};

const HIDDEN_PRODUCT_NAMES = new Set(["★ 만든놈폰"]);

const DEFAULT_PRODUCT_OPTIONS: ProductOption[] = Object.values(
  Object.entries(MODEL_MAP).reduce<Record<string, ProductOption>>(
    (options, [modelCode, product]) => {
      if (!options[product]) {
        options[product] = {
          value: product,
          searchText: `${product} ${modelCode}`.toLowerCase(),
        };
      } else {
        options[product].searchText += ` ${modelCode.toLowerCase()}`;
      }

      return options;
    },
    {}
  )
)
  .filter((option) => !HIDDEN_PRODUCT_NAMES.has(option.value))
  .sort((a, b) => a.value.localeCompare(b.value, "ko"));

const DEFAULT_PRODUCT_OPTION_VALUES = Array.from(
  new Set(Object.values(MODEL_MAP))
);
const DEFAULT_CAMERA_CHECK_BY_PRODUCT = Object.fromEntries(
  DEFAULT_PRODUCT_OPTION_VALUES.map((product) => [
    product,
    getCameraCheckByProduct(product),
  ])
);
const DEFAULT_CARRIER_OPTIONS = ["SKT", "KT", "LG U+", "자급제"] as const;
const DEFAULT_STORAGE_OPTIONS = [
  "32GB",
  "64GB",
  "128GB",
  "256GB",
  "512GB",
  "1TB",
  "2TB",
] as const;

// QuickHack object: 상품 기준값 API가 비어 있거나 일부 누락될 때 검수 화면에서 사용할 기본값입니다.
export function defaultProductCriteria(): ProductCriteriaPayload {
  return {
    modelOptions: [],
    products: DEFAULT_PRODUCT_OPTIONS,
    productValues: DEFAULT_PRODUCT_OPTION_VALUES,
    carriers: [...DEFAULT_CARRIER_OPTIONS],
    storages: [...DEFAULT_STORAGE_OPTIONS],
    storagesByProduct: {},
    colors: [],
    colorModelsByColor: {},
    grades: [...GRADE_OPTIONS],
    appearanceDefectMap: Object.fromEntries(
      Object.entries(APPEARANCE_DEFECT_MAP).map(([part, states]) => [
        part,
        [...states],
      ])
    ),
    functionDefectMap: Object.fromEntries(
      Object.entries(FUNCTION_DEFECT_MAP).map(([part, states]) => [
        part,
        [...states],
      ])
    ),
    cameraCheckByProduct: DEFAULT_CAMERA_CHECK_BY_PRODUCT,
    rawOptions: [],
    rawLinks: [],
    rawCameraRules: [],
  };
}

export function mergeProductCriteriaPayload(
  payload: ProductCriteriaPayload | null | undefined
) {
  const fallback = defaultProductCriteria();

  if (!payload) {
    return fallback;
  }

  return {
    modelOptions:
      payload.modelOptions.length > 0
        ? payload.modelOptions
        : fallback.modelOptions,
    products: payload.products.length > 0 ? payload.products : fallback.products,
    productValues:
      payload.productValues.length > 0
        ? payload.productValues
        : fallback.productValues,
    carriers: payload.carriers.length > 0 ? payload.carriers : fallback.carriers,
    storages: payload.storages.length > 0 ? payload.storages : fallback.storages,
    storagesByProduct: payload.storagesByProduct ?? {},
    colors: payload.colors,
    colorModelsByColor: payload.colorModelsByColor ?? {},
    grades: payload.grades.length > 0 ? payload.grades : fallback.grades,
    appearanceDefectMap:
      Object.keys(payload.appearanceDefectMap).length > 0
        ? payload.appearanceDefectMap
        : fallback.appearanceDefectMap,
    functionDefectMap:
      Object.keys(payload.functionDefectMap).length > 0
        ? payload.functionDefectMap
        : fallback.functionDefectMap,
    cameraCheckByProduct: {
      ...fallback.cameraCheckByProduct,
      ...payload.cameraCheckByProduct,
    },
    rawOptions: payload.rawOptions,
    rawLinks: payload.rawLinks ?? [],
    rawCameraRules: payload.rawCameraRules ?? [],
  };
}
