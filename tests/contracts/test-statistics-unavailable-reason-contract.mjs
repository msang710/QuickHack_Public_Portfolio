import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rateMetricSchema } from "@/quickhack_shared/statistics/statistics-snapshot-payload-schema-common";
import { assertRuntimeSchema, StatisticsRuntimeSchemaError } from "@/quickhack_shared/statistics/statistics-runtime-schema";
import { STATISTICS_UNAVAILABLE_REASON_CODES } from "@/quickhack_shared/statistics/statistics";
import { koMessages } from "@/quickhack_client/i18n/catalogs/ko/index.ts";
import { enMessages } from "@/quickhack_client/i18n/catalogs/en/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const code of STATISTICS_UNAVAILABLE_REASON_CODES) {
  const metric = { value: null, numerator: 0, denominator: 0, unavailableReasonCode: code };
  assert.doesNotThrow(() => assertRuntimeSchema(rateMetricSchema, metric, "metric"));
  assert.equal(typeof koMessages.statistics.metric.unavailableReason[code], "string");
  assert.equal(typeof enMessages.statistics.metric.unavailableReason[code], "string");
}

assert.doesNotThrow(() => assertRuntimeSchema(rateMetricSchema, {
  value: null,
  numerator: 0,
  denominator: 0,
  unavailableReason: "과거 snapshot 원문",
}, "legacyMetric"));
assert.throws(
  () => assertRuntimeSchema(rateMetricSchema, {
    value: null,
    numerator: 0,
    denominator: 0,
    unavailableReasonCode: "UNKNOWN_REASON",
  }, "invalidMetric"),
  StatisticsRuntimeSchemaError
);

for (const file of [
  "quickhack_server/statistics/sales-statistics-service.ts",
  "quickhack_server/statistics/return-statistics-service.ts",
  "quickhack_server/statistics/purchase-statistics-service.ts",
  "quickhack_server/statistics/inventory-statistics-service.ts",
]) {
  const source = readFileSync(path.join(root, file), "utf8");
  assert.equal(
    /unavailableReason\s*:\s*(?:"[^"\n]*[가-힣]|`[^`\n]*[가-힣])/u.test(source),
    false,
    file
  );
}

console.log("Statistics unavailable-reason code and legacy snapshot contract passed.");
