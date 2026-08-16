import assert from "node:assert/strict";
import {
  createInvoiceActionNoteSnapshot,
  createManualInvoiceReplacementDraftSnapshot,
  invoiceActionNoteSnapshotsEqual,
  invoiceReplacementFormIds,
  manualInvoiceReplacementDraftIsDirty,
  salesChannelWriteReviewFormId,
} from "../../quickhack_client/components/invoice/invoice-operation-draft-state.ts";

{
  assert.equal(
    manualInvoiceReplacementDraftIsDirty(
      createManualInvoiceReplacementDraftSnapshot({
        packageGroupId: "  ",
        reason: "\n",
      })
    ),
    false,
    "Whitespace-only manual replacement values were marked dirty."
  );
  assert.equal(
    manualInvoiceReplacementDraftIsDirty(
      createManualInvoiceReplacementDraftSnapshot({
        packageGroupId: "42",
        reason: "",
      })
    ),
    true,
    "A package-group draft was not marked dirty."
  );
  assert.equal(
    manualInvoiceReplacementDraftIsDirty(
      createManualInvoiceReplacementDraftSnapshot({
        packageGroupId: "",
        reason: "주소 변경",
      })
    ),
    true,
    "A replacement reason was not marked dirty."
  );
}

{
  assert.equal(
    invoiceActionNoteSnapshotsEqual(
      createInvoiceActionNoteSnapshot("기존 송장 폐기 확인"),
      createInvoiceActionNoteSnapshot("  기존 송장 폐기 확인\n")
    ),
    true,
    "Outer note whitespace created a false dirty state."
  );
  assert.equal(
    invoiceActionNoteSnapshotsEqual(
      createInvoiceActionNoteSnapshot("기존 송장 폐기 확인"),
      createInvoiceActionNoteSnapshot("기사님에게 폐기 요청")
    ),
    false,
    "A meaningful action-note change was not detected."
  );
}

{
  assert.deepEqual(invoiceReplacementFormIds(15), [
    "invoice.replacement-confirm:15",
    "invoice.replacement-cancel:15",
  ]);
  assert.deepEqual(
    invoiceReplacementFormIds(null),
    [],
    "A missing replacement registered placeholder form ids."
  );
  assert.equal(
    salesChannelWriteReviewFormId(21),
    "sales-channel.write-review:21"
  );
}

console.log("Invoice operation draft state verified.");
