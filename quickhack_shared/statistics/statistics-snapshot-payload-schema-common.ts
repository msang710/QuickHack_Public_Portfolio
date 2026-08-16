import type {
  ReturnDurationMetric,
  SalesAmountMetric,
  SalesRateMetric,
  StatisticsCalculationDelivery,
  StatisticsCalculationMetadata,
  StatisticsGroup,
  StatisticsPoint,
} from "@/quickhack_shared/statistics/statistics";
import {
  booleanSchema,
  finiteNumberSchema,
  nullableSchema,
  objectSchema,
  oneOfSchema,
  optionalSchema,
  stringSchema,
  unionSchema,
} from "@/quickhack_shared/statistics/statistics-runtime-schema";

type SnapshotDelivery = Extract<
  StatisticsCalculationDelivery,
  {
    status: "SNAPSHOT_CURRENT" | "SNAPSHOT_DELAYED";
  }
>;

type LiveCustomPeriodDelivery = Extract<
  StatisticsCalculationDelivery,
  {
    status: "LIVE_CUSTOM_PERIOD";
  }
>;

type LiveFallbackDelivery = Extract<
  StatisticsCalculationDelivery,
  {
    status: "LIVE_FALLBACK";
  }
>;

const statisticsPeriodSchema = objectSchema<
  StatisticsCalculationMetadata["period"]
>({
  fromDate: stringSchema,
  toDate: stringSchema,
  dayCount: finiteNumberSchema,
});

const snapshotDeliverySchema = objectSchema<SnapshotDelivery>({
  status: oneOfSchema("SNAPSHOT_CURRENT", "SNAPSHOT_DELAYED"),
  snapshotCutoffDate: stringSchema,
  snapshotCutoffLagDays: finiteNumberSchema,
});

const liveCustomPeriodDeliverySchema =
  objectSchema<LiveCustomPeriodDelivery>({
    status: oneOfSchema("LIVE_CUSTOM_PERIOD"),
  });

const liveFallbackDeliverySchema = objectSchema<LiveFallbackDelivery>({
  status: oneOfSchema("LIVE_FALLBACK"),
  fallbackReason: oneOfSchema("NOT_FOUND", "TOO_OLD", "INVALID"),
});

const statisticsCalculationDeliverySchema =
  unionSchema(
    snapshotDeliverySchema,
    liveCustomPeriodDeliverySchema,
    liveFallbackDeliverySchema
  );

export const statisticsCalculationMetadataSchema =
  objectSchema<StatisticsCalculationMetadata>({
    mode: oneOfSchema("LIVE", "SNAPSHOT"),
    period: statisticsPeriodSchema,
    comparisonPeriod: statisticsPeriodSchema,
    dataCutoffDate: stringSchema,
    isDefaultPeriod: booleanSchema,
    delivery: optionalSchema(statisticsCalculationDeliverySchema),
  });

export const statisticsGroupSchema = objectSchema<StatisticsGroup>({
  label: stringSchema,
  count: finiteNumberSchema,
  meta: optionalSchema(stringSchema),
});

export const statisticsPointSchema = objectSchema<StatisticsPoint>({
  label: stringSchema,
  value: finiteNumberSchema,
});

export const rateMetricSchema = objectSchema<SalesRateMetric>({
  value: nullableSchema(finiteNumberSchema),
  numerator: finiteNumberSchema,
  denominator: finiteNumberSchema,
  unavailableReason: optionalSchema(stringSchema),
});

export const amountMetricSchema = objectSchema<SalesAmountMetric>({
  amount: nullableSchema(finiteNumberSchema),
  pricedCount: finiteNumberSchema,
  totalCount: finiteNumberSchema,
  coveragePercent: finiteNumberSchema,
});

export const durationMetricSchema = objectSchema<ReturnDurationMetric>({
  sampleCount: finiteNumberSchema,
  medianHours: nullableSchema(finiteNumberSchema),
  p90Hours: nullableSchema(finiteNumberSchema),
  excludedAnomalyCount: finiteNumberSchema,
});

export const nullableNumberSchema = nullableSchema(finiteNumberSchema);
export const nullableStringSchema = nullableSchema(stringSchema);
