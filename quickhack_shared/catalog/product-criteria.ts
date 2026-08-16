// QuickHack note: 상품 기준값 카테고리와 payload 타입을 클라이언트/서버가 공유합니다.
export const PRODUCT_CRITERIA_CATEGORIES = [
  "PRODUCT_MODEL",
  "CARRIER",
  "STORAGE",
  "DEVICE_COLOR",
  "APPEARANCE_GRADE",
  "SALE_GRADE",
  "WARRANTY_GROUP",
  "APPEARANCE_DEFECT",
  "FUNCTION_DEFECT",
  "CAMERA_LENS",
  "CAMERA_FOCUS_RULE",
] as const;

export type ProductCriteriaCategory =
  (typeof PRODUCT_CRITERIA_CATEGORIES)[number];

export const PRODUCT_CRITERIA_CATEGORY_LABELS: Record<
  ProductCriteriaCategory,
  string
> = {
  PRODUCT_MODEL: "제품명 / 모델코드",
  CARRIER: "통신사",
  STORAGE: "저장공간",
  DEVICE_COLOR: "공식 색상명",
  APPEARANCE_GRADE: "외관등급",
  SALE_GRADE: "판매등급",
  WARRANTY_GROUP: "판매 보증조건",
  APPEARANCE_DEFECT: "외관하자",
  FUNCTION_DEFECT: "기능하자",
  CAMERA_LENS: "카메라 렌즈 배율",
  CAMERA_FOCUS_RULE: "카메라 초점 기준",
};

export const PRODUCT_CRITERIA_PARENT_KEY_CATEGORIES = [
  "APPEARANCE_DEFECT",
  "FUNCTION_DEFECT",
] as const satisfies readonly ProductCriteriaCategory[];

export function canUseProductCriteriaParentKey(
  category: ProductCriteriaCategory
) {
  return (PRODUCT_CRITERIA_PARENT_KEY_CATEGORIES as readonly string[]).includes(
    category
  );
}

export type ProductCriteriaOptionDto = {
  optionId: number;
  revision: number;
  relationRevision: number;
  category: ProductCriteriaCategory;
  optionKey: string;
  label: string;
  parentKey: string;
  sortOrder: number;
  isActive: boolean;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductCriteriaOptionLinkDto = {
  linkId: number;
  relationType: string;
  parentOptionId: number;
  parentCategory: ProductCriteriaCategory;
  parentKey: string;
  parentLabel: string;
  childOptionId: number;
  childCategory: ProductCriteriaCategory;
  childKey: string;
  childLabel: string;
  sortOrder: number;
  isActive: boolean;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductCameraCheckRuleDto = {
  ruleId: number;
  modelOptionId: number;
  modelLabel: string;
  cameraLensOptionId: number | null;
  focusRuleOptionId: number | null;
  cameraName: string;
  focusRule: string;
  sortOrder: number;
  isActive: boolean;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductCriteriaProductOption = {
  value: string;
  searchText: string;
};

export type ProductCriteriaPayload = {
  modelOptions: ProductCriteriaOptionDto[];
  products: ProductCriteriaProductOption[];
  productValues: string[];
  carriers: string[];
  storages: string[];
  storagesByProduct: Record<string, string[]>;
  colors: string[];
  colorModelsByColor: Record<string, string[]>;
  grades: string[];
  appearanceDefectMap: Record<string, string[]>;
  functionDefectMap: Record<string, string[]>;
  cameraCheckByProduct: Record<string, string>;
  rawOptions: ProductCriteriaOptionDto[];
  rawLinks: ProductCriteriaOptionLinkDto[];
  rawCameraRules: ProductCameraCheckRuleDto[];
};

export function getStorageOptionsForProduct(
  criteria: Pick<ProductCriteriaPayload, "storages" | "storagesByProduct">,
  product: string
) {
  const productKey = product.trim();
  const modelStorages = productKey
    ? criteria.storagesByProduct[productKey] ?? []
    : [];

  return modelStorages.length > 0 ? modelStorages : criteria.storages;
}

export function getColorOptionsForProduct(
  criteria: Pick<ProductCriteriaPayload, "colors" | "colorModelsByColor">,
  product: string
) {
  const productKey = product.trim();

  if (!productKey) {
    return criteria.colors;
  }

  const modelColors = criteria.colors.filter((color) =>
    (criteria.colorModelsByColor[color] ?? []).includes(productKey)
  );

  return modelColors.length > 0 ? modelColors : criteria.colors;
}

export function isProductCriteriaCategory(
  value: string
): value is ProductCriteriaCategory {
  return (PRODUCT_CRITERIA_CATEGORIES as readonly string[]).includes(value);
}
