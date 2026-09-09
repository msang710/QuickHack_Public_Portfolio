"use client";

import { useTranslations } from "next-intl";

export function useInvoiceReplacementPresentation() {
  const t = useTranslations("shipment.invoiceReplacement.presentation");
  function status(value: string) {
    switch (value) {
      case "PENDING": return t("status.pending");
      case "PROCESSING": return t("status.processing");
      case "WAITING_MANUAL": return t("status.waitingManual");
      case "WAITING_LABEL": return t("status.waitingLabel");
      case "COMPLETED": return t("status.completed");
      case "REVIEW_REQUIRED": return t("status.reviewRequired");
      case "FAILED": return t("status.failed");
      case "CANCELED": return t("status.canceled");
      default: return value;
    }
  }
  function stage(value: string) {
    switch (value) {
      case "PRECHECK": return t("stage.precheck");
      case "OLD_INVOICE_HANDLING": return t("stage.oldInvoice");
      case "ALLOCATION": return t("stage.allocation");
      case "CHANNEL_UPDATE": return t("stage.channel");
      case "CARRIER_REGISTRATION": return t("stage.carrier");
      case "LABEL_PRINT": return t("stage.label");
      case "FINALIZE": return t("stage.finalize");
      default: return value;
    }
  }
  function action(value: string) {
    switch (value) {
      case "RESUME_INTERRUPTED": return { label: t("action.resume.label"), description: t("action.resume.description") };
      case "CONFIRM_OLD_INVOICE_HANDLING": return { label: t("action.confirmOld.label"), description: t("action.confirmOld.description") };
      case "PRINT_REPLACEMENT_LABEL": return { label: t("action.print.label"), description: t("action.print.description") };
      case "REVIEW_FAILURE": return { label: t("action.review.label"), description: t("action.review.description") };
      case "NONE": return { label: t("action.none.label"), description: t("action.none.description") };
      case "OPEN_REPLACEMENT": return { label: t("action.open.label"), description: "" };
      case "RETRY_ALLOCATION": return { label: t("action.retryAllocation.label"), description: "" };
      case "REVIEW_ALLOCATION": return { label: t("action.reviewAllocation.label"), description: "" };
      default: return { label: t("action.wait.label"), description: t("action.wait.description") };
    }
  }
  return { status, stage, action };
}
