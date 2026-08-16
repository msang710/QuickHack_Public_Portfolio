"use client";

import { SalesChannelWriteReviewView } from "@/quickhack_client/components/admin/sales-channel-write-review-view";

const INVOICE_WRITE_TYPES = [
  "COUPANG_INVOICE_UPLOAD",
  "COUPANG_INVOICE_UPDATE",
];

export function InvoiceRegistrationFailureView({
  initialSearch,
  onOpenSourceMenu,
}: {
  initialSearch?: string;
  onOpenSourceMenu?: (menuId: string) => void;
}) {
  return (
    <SalesChannelWriteReviewView
      requestTypes={INVOICE_WRITE_TYPES}
      initialSearch={initialSearch}
      title="송장 등록 실패 조회"
      description="쿠팡 송장 등록·변경 결과가 불확실하거나 내부 확정에 실패한 건만 모아 안전하게 복구합니다."
      searchPlaceholder="송장번호, 주문번호, PG, 오류 검색"
      onOpenSourceMenu={onOpenSourceMenu}
    />
  );
}
