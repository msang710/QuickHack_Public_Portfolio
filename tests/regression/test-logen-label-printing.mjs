import assert from "node:assert/strict";
import { buildLogenTsplForTest } from "@/quickhack_client/printing/printer-service";
import { LOGEN_LABEL_TEMPLATE } from "@/quickhack_shared/shipment/logen-label";

const bitmap = Buffer.alloc(
  (LOGEN_LABEL_TEMPLATE.widthDots / 8) * LOGEN_LABEL_TEMPLATE.lengthDots
).toString("base64");
const payload = buildLogenTsplForTest(
  {
    printerName: "TSC DA200",
    sensorType: "GAP",
    gapMm: 3,
    gapOffsetMm: 0,
    direction: 1,
    referenceX: 0,
    referenceY: 0,
    shiftX: 0,
    shiftY: 0,
    speed: 3,
    density: 8,
  },
  [
    {
      issueItemId: 10,
      issueSequence: 1,
      trackingNumber: "12345678901",
      bitmapBase64: bitmap,
    },
    {
      issueItemId: 11,
      issueSequence: 2,
      trackingNumber: "12345678902",
      bitmapBase64: bitmap,
    },
  ]
);
const ascii = payload.toString("latin1");
assert(
  ascii.includes("SIZE 100 mm,124 mm\r\n") &&
    ascii.includes("GAP 3 mm,0 mm\r\n"),
  "The DA200 media size or gap command is incorrect."
);
assert.equal(
  ascii.match(/PRINT 1,1/g)?.length,
  2,
  "The RAW job did not preserve one PRINT command per ordered label."
);
assert(
  ascii.indexOf("12345678901") < ascii.indexOf("12345678902"),
  "The issue sequence was not preserved in the RAW job."
);

let injectionBlocked = false;
try {
  buildLogenTsplForTest(
    {},
    [
      {
        issueItemId: 12,
        issueSequence: 1,
        trackingNumber: '123"\r\nPRINT 99,99',
        bitmapBase64: bitmap,
      },
    ]
  );
} catch (error) {
  injectionBlocked =
    error instanceof Error &&
    "code" in error &&
    error.code === "INVALID_TRACKING_NUMBER";
}
assert(injectionBlocked, "A tracking number injected a RAW printer command.");

console.log("Logen label RAW print contract verified.");

