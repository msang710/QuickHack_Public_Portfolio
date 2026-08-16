import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";

export type ManualInvoiceReplacementDraftSnapshot = {
  packageGroupId: string;
  reason: string;
};

export type InvoiceActionNoteSnapshot = {
  note: string;
};

function normalizedText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedPositiveId(value: number | null | undefined) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

export function createManualInvoiceReplacementDraftSnapshot({
  packageGroupId,
  reason,
}: ManualInvoiceReplacementDraftSnapshot): ManualInvoiceReplacementDraftSnapshot {
  return {
    packageGroupId: normalizedText(packageGroupId),
    reason: normalizedText(reason),
  };
}

export function manualInvoiceReplacementDraftIsDirty(
  snapshot: ManualInvoiceReplacementDraftSnapshot
) {
  return !unsavedFormSnapshotsEqual(
    createManualInvoiceReplacementDraftSnapshot({
      packageGroupId: "",
      reason: "",
    }),
    createManualInvoiceReplacementDraftSnapshot(snapshot)
  );
}

export function createInvoiceActionNoteSnapshot(
  note: string
): InvoiceActionNoteSnapshot {
  return {
    note: normalizedText(note),
  };
}

export function invoiceActionNoteSnapshotsEqual(
  baseline: InvoiceActionNoteSnapshot,
  current: InvoiceActionNoteSnapshot
) {
  return unsavedFormSnapshotsEqual(baseline, current);
}

export function invoiceReplacementConfirmFormId(
  replacementWorkId: number | null | undefined
) {
  const normalizedId = normalizedPositiveId(replacementWorkId);
  return normalizedId
    ? `invoice.replacement-confirm:${normalizedId}`
    : "invoice.replacement-confirm:none";
}

export function invoiceReplacementCancelFormId(
  replacementWorkId: number | null | undefined
) {
  const normalizedId = normalizedPositiveId(replacementWorkId);
  return normalizedId
    ? `invoice.replacement-cancel:${normalizedId}`
    : "invoice.replacement-cancel:none";
}

export function invoiceReplacementFormIds(
  replacementWorkId: number | null | undefined
) {
  if (!normalizedPositiveId(replacementWorkId)) {
    return [];
  }

  return [
    invoiceReplacementConfirmFormId(replacementWorkId),
    invoiceReplacementCancelFormId(replacementWorkId),
  ];
}

export function salesChannelWriteReviewFormId(
  requestId: number | null | undefined
) {
  const normalizedId = normalizedPositiveId(requestId);
  return normalizedId
    ? `sales-channel.write-review:${normalizedId}`
    : "sales-channel.write-review:none";
}
