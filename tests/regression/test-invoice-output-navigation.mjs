import assert from "node:assert/strict";

import { selectInvoiceIssueBatch } from "../../quickhack_client/components/shipment/shipment-output-focus.ts";

const issueBatches = [
  {
    issueBatchId: 101,
    issueType: "INITIAL",
  },
  {
    issueBatchId: 202,
    issueType: "REPLACEMENT",
  },
];

assert.equal(
  selectInvoiceIssueBatch(issueBatches, 202)?.issueBatchId,
  202,
  "재발급 화면에서 전달한 REPLACEMENT 배치를 INITIAL보다 우선해야 합니다."
);
assert.equal(
  selectInvoiceIssueBatch(issueBatches)?.issueBatchId,
  101,
  "일반 출력 화면은 INITIAL 배치를 기본값으로 유지해야 합니다."
);
assert.equal(
  selectInvoiceIssueBatch(issueBatches, 999),
  null,
  "지정한 재발급 배치가 없으면 다른 배치로 조용히 대체하면 안 됩니다."
);

console.log("Invoice output navigation tests passed.");
