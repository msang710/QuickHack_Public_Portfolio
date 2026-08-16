export interface SyntheticCoupangCatalogItem {
  sourceRowIndex: number;
  productId: string;
  sellerProductId: string;
  sellerProductName: string;
  sellerProductItemName: string;
  vendorItemId: string;
  vendorItemName: string;
  vendorSkuCode: string;
  quickhackModel: string;
  quickhackColor: string;
  quickhackCapacity: string;
  quickhackGrade: string;
  currentQuantitySnapshot: number;
  averagePriceSnapshot: number;
  quickhackGradeGroupCode: string;
  quickhackGradeGroupLabel: string;
  rawJson: string;
}

export const SYNTHETIC_CATALOG_VERSION: string;
export const SYNTHETIC_SELLER_PRODUCT_COUNT: 88;
export const SYNTHETIC_VENDOR_ITEM_COUNT: 806;
export const SYNTHETIC_PRODUCT_COUNT: 88;

export function createSyntheticProductCatalog(options?: {
  randomInteger?: (maxExclusive: number) => number;
}): SyntheticCoupangCatalogItem[];
