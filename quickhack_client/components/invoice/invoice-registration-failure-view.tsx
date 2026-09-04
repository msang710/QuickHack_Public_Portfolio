"use client";

import { useTranslations } from "next-intl";
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
  const t = useTranslations("admin.writeReview.default");
  return (
    <SalesChannelWriteReviewView
      requestTypes={INVOICE_WRITE_TYPES}
      initialSearch={initialSearch}
      title={t("invoiceFailureTitle")}
      description={t("invoiceFailureDescription")}
      searchPlaceholder={t("invoiceFailureSearch")}
      onOpenSourceMenu={onOpenSourceMenu}
    />
  );
}
