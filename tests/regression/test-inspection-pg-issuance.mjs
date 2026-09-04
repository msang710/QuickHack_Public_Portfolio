import assert from "node:assert/strict";
import { generateRandomPgNo } from "../../quickhack_server/inspection/pg-issuance-service.ts";
import {
  CLIENT_PG_RESERVATION_STATUSES,
  PG_RESERVATION_STATUS_COLUMN,
  INSPECTION_RECORD_KINDS,
  createUploadRecord,
} from "../../quickhack_shared/inspection/inspection-schema.ts";
import { recordForUpload } from "../../quickhack_client/components/inspection/inspection-record-logic.ts";

const sequence = [0, 25, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
let index = 0;
assert.equal(generateRandomPgNo(() => sequence[index++] ?? 0), "AZ9876543210");

const pending = createUploadRecord(
  { PG: "", IMEI: "123456789012345", 기능검수자: "worker" },
  INSPECTION_RECORD_KINDS.function
);
assert.equal(pending.PG, "");
assert.equal(
  pending[PG_RESERVATION_STATUS_COLUMN],
  CLIENT_PG_RESERVATION_STATUSES.issuing
);

const reserved = {
  ...pending,
  PG: "AB0123456789",
  [PG_RESERVATION_STATUS_COLUMN]: CLIENT_PG_RESERVATION_STATUSES.reserved,
};
assert.deepEqual(recordForUpload(reserved), {
  clientRecordId: reserved.__clientRecordId,
  inspectionKind: INSPECTION_RECORD_KINDS.function,
  record: Object.fromEntries(
    Object.entries(reserved).filter(([key]) => !key.startsWith("__") && key !== "업로드상태")
  ),
});

console.log("inspection PG issuance regression: PASS");
