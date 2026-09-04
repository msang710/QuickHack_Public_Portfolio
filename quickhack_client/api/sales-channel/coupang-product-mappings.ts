// QuickHack note: 채널 상품 매핑 화면에서 사용하는 쿠팡 상품 매핑 API 호출 헬퍼입니다.
import {
  sensitiveJsonFetch,
  type SensitiveRequestFallbacks,
  type SensitiveJsonRequest,
} from "@/quickhack_client/auth/sensitive-request";

export type CoupangProductMappingMutationResponse = {
  ok: boolean;
  message?: string;
  item?: unknown;
};

function mappingRequest(
  body: Record<string, unknown>,
  fallbacks: SensitiveRequestFallbacks
): SensitiveJsonRequest {
  return {
    url: "/api/coupang/product-mappings",
    method: "POST",
    body,
    fallbacks,
  };
}

export function saveCoupangProductMapping(input: {
  externalVendorItemId: string;
  salesOfferId?: number | null;
  fallbacks: SensitiveRequestFallbacks;
}) {
  return sensitiveJsonFetch<CoupangProductMappingMutationResponse>(
    mappingRequest({
      action: "set",
      externalVendorItemId: input.externalVendorItemId,
      salesOfferId: input.salesOfferId ?? null,
    }, input.fallbacks)
  );
}
