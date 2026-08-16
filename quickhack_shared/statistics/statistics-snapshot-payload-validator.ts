import type {
  StatisticsSnapshotDataByDomain,
  StatisticsSnapshotDomain,
} from "@/quickhack_shared/statistics/statistics-snapshot";
import { inventoryStatisticsDataSchema } from "@/quickhack_shared/statistics/statistics-snapshot-payload-schema-inventory";
import { purchaseStatisticsDataSchema } from "@/quickhack_shared/statistics/statistics-snapshot-payload-schema-purchase";
import { returnStatisticsDataSchema } from "@/quickhack_shared/statistics/statistics-snapshot-payload-schema-returns";
import { salesStatisticsDataSchema } from "@/quickhack_shared/statistics/statistics-snapshot-payload-schema-sales";
import {
  assertRuntimeSchema,
  type RuntimeSchema,
} from "@/quickhack_shared/statistics/statistics-runtime-schema";

const statisticsSnapshotDataSchemas = {
  PURCHASE: purchaseStatisticsDataSchema,
  INVENTORY: inventoryStatisticsDataSchema,
  SALES: salesStatisticsDataSchema,
  RETURNS: returnStatisticsDataSchema,
} satisfies {
  [Domain in StatisticsSnapshotDomain]: RuntimeSchema<
    StatisticsSnapshotDataByDomain[Domain]
  >;
};

export function assertStatisticsSnapshotDomainData<
  Domain extends StatisticsSnapshotDomain,
>(
  domain: Domain,
  value: unknown
): asserts value is StatisticsSnapshotDataByDomain[Domain] {
  const schema = statisticsSnapshotDataSchemas[domain] as RuntimeSchema<
    StatisticsSnapshotDataByDomain[Domain]
  >;
  assertRuntimeSchema(schema, value, "data");
}
