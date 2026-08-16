import assert from "node:assert/strict";

const {
  resolveLogenTrackingOccurredAt,
  validateLogenTrackingBatch,
} = await import(
  "@/quickhack_server/shipment/carrier-integration/logen/tracking-schema"
);

const context = {
  provider: "LOGEN",
  endpoint: "/lrm02b-edi/edi/inquiryCargoTrackingMulti",
};
const normalized = validateLogenTrackingBatch(
  {
    sttsCd: "PARTIAL SUCCESS",
    sttsMsg: "2건 중 1건 성공",
    data: [
      {
        slipNo: "88110000001",
        resultCd: "TRUE",
        resultMsg: null,
        data1: [
          {
            scanDt: "20260814",
            scanTm: "091530",
            statNm: "배송완료",
            branCd: "216",
            branNm: "강남",
          },
        ],
      },
      {
        slipNo: "88110000002",
        resultCd: "FALSE",
        resultMsg: "유효하지 않은 송장",
        data1: [],
      },
    ],
  },
  context
);
assert.equal(normalized.items.length, 2);
assert.equal(normalized.items[0].events[0].statusName, "배송완료");
assert.equal(normalized.items[1].succeeded, false);

const sourceTime = resolveLogenTrackingOccurredAt({
  scanDate: "20260814",
  scanTime: "091530",
  receivedAt: new Date("2026-08-14T09:20:00+09:00"),
});
assert.equal(sourceTime.source, "PROVIDER_SCAN");
assert.equal(sourceTime.occurredAt.toISOString(), "2026-08-14T00:15:30.000Z");

const impossibleDate = resolveLogenTrackingOccurredAt({
  scanDate: "20260230",
  scanTime: "091530",
  receivedAt: new Date("2026-08-14T09:20:00+09:00"),
});
assert.equal(impossibleDate.source, "RECEIVED_AT");
assert.equal(impossibleDate.invalidReason, "FORMAT");

const futureTime = resolveLogenTrackingOccurredAt({
  scanDate: "20260814",
  scanTime: "101530",
  receivedAt: new Date("2026-08-14T09:20:00+09:00"),
});
assert.equal(futureTime.source, "RECEIVED_AT");
assert.equal(futureTime.invalidReason, "FUTURE");

assert.throws(
  () =>
    validateLogenTrackingBatch(
      { sttsCd: "SUCCESS", data: [{ slipNo: "88110000001" }] },
      context
    ),
  (error) => error?.code === "INTEGRATION_SCHEMA_INVALID"
);

console.log("Logen tracking evidence schema and provider scan time verified.");
