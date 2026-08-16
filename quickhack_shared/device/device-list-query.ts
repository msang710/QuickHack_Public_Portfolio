import type { DeviceListItem } from "@/quickhack_shared/device/types";

export const DEVICE_LIST_CONTEXT = {
  inventory: "INVENTORY",
  correction: "CORRECTION",
  audit: "AUDIT",
  purchasePending: "PURCHASE_PENDING",
} as const;

export type DeviceListContext =
  (typeof DEVICE_LIST_CONTEXT)[keyof typeof DEVICE_LIST_CONTEXT];

export const DEVICE_LIST_SORT_KEYS = [
  "pgNo",
  "model",
  "modelSeq",
  "imei",
  "saleGrade",
  "status",
  "batchNo",
  "supplierName",
  "location",
  "updatedAt",
] as const;

export type DeviceListSortKey = (typeof DEVICE_LIST_SORT_KEYS)[number];
export type DeviceListSortDirection = "asc" | "desc";

export type DeviceListColumnFilters = Partial<
  Record<Exclude<DeviceListSortKey, "updatedAt">, string>
>;

// 목록 응답에는 상세 이력 배열을 싣지 않는다. 사용자가 행을 열 때 PG 단건 상세 API가
// DeviceListItem을 반환한다.
export type DeviceListRow = Omit<
  DeviceListItem,
  "inspections" | "orders" | "detailRecords"
>;

export type DeviceListPage = {
  items: DeviceListRow[];
  nextCursor: string | null;
  hasMore: boolean;
  facets?: {
    models: string[];
  };
};
