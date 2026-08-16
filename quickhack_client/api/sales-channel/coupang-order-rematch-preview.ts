// QuickHack note: 상품 매핑 화면의 읽기 전용 기존 주문 재매칭 대상 preview 호출 계약입니다.
import { sensitiveJsonFetch } from "@/quickhack_client/auth/sensitive-request";

export type CoupangOrderRematchOfferPreview = {
  salesOfferId: number;
  offerCode: string;
  model: string;
  storage: string | null;
  color: string | null;
  warrantyGroup: string;
  warrantyLabel: string;
  isActive: boolean;
};

export type CoupangOrderRematchPreviewItem = {
  firstWorkItemId: number;
  externalOrderId: string;
  externalShipmentId: string;
  externalOrderStatus: string | null;
  eligible: boolean;
  exclusionReasons: Array<{ code: string; label: string }>;
  itemCount: number;
  allocationCount: number;
  items: Array<{
    workItemId: number;
    externalVendorItemId: string;
    vendorItemName: string | null;
    orderedQuantity: number;
    matchableQuantity: number;
    matchedOffer: CoupangOrderRematchOfferPreview | null;
    currentDefaultOffer: CoupangOrderRematchOfferPreview | null;
    allocations: Array<{
      allocationId: number;
      pgNo: string;
      salesOfferId: number | null;
      allocationStatus: string;
      inventoryStatus: string | null;
    }>;
  }>;
};

export type CoupangOrderRematchPreviewData = {
  generatedAt: string;
  manifestToken: string;
  cursor: number | null;
  nextCursor: number | null;
  hasMore: boolean;
  summary: {
    candidateShipmentCount: number;
    eligibleShipmentCount: number;
    excludedShipmentCount: number;
    eligibleWorkItemCount: number;
    eligibleAllocationCount: number;
    exclusionReasonCounts: Array<{
      code: string;
      label: string;
      count: number;
    }>;
  };
  items: CoupangOrderRematchPreviewItem[];
};

export type CoupangOrderRematchExecutionData = {
  resetCommitted: true;
  reset: {
    manifestToken: string;
    resetAt: string;
    shipmentCount: number;
    workItemCount: number;
    allocationCount: number;
    workItemIds: number[];
    allocationIds: number[];
    pgNos: string[];
    shipments: Array<{
      externalOrderId: string;
      externalShipmentId: string;
    }>;
  };
  rematch:
    | {
        status: "COMPLETED";
        summary: {
          processedItemCount: number;
          matchedDeviceCount: number;
          fullyMatchedItemCount: number;
          partialItemCount: number;
          failedItemCount: number;
          skippedItemCount: number;
          deferredItemCount: number;
          conflictCount: number;
        };
        items: unknown[];
      }
    | {
        status: "FAILED";
        message: string;
      };
};

type CoupangOrderRematchPreviewResponse = {
  ok: boolean;
  message?: string;
  data?: CoupangOrderRematchPreviewData;
};

export async function fetchCoupangOrderRematchPreview(input: {
  cursor?: number | null;
  limit?: number;
} = {}) {
  const params = new URLSearchParams();

  if (input.cursor) {
    params.set("cursor", String(input.cursor));
  }
  params.set("limit", String(input.limit ?? 100));

  const response = await fetch(
    `/api/coupang/order-rematch-preview?${params.toString()}`,
    { cache: "no-store" }
  );
  const payload = (await response.json().catch(() => null)) as
    | CoupangOrderRematchPreviewResponse
    | null;

  if (!response.ok || !payload?.ok || !payload.data) {
    throw new Error(payload?.message || "기존 주문 재매칭 대상을 조회하지 못했습니다.");
  }

  return payload.data;
}

export async function executeCoupangOrderRematch(manifestToken: string) {
  const payload = await sensitiveJsonFetch<{
    ok: boolean;
    message?: string;
    data?: CoupangOrderRematchExecutionData;
  }>({
    url: "/api/coupang/order-rematch",
    method: "POST",
    body: { manifestToken },
  });

  if (!payload.ok || !payload.data) {
    throw new Error(payload.message || "기존 주문 재매칭을 완료하지 못했습니다.");
  }

  return payload.data;
}
