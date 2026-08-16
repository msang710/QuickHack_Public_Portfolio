import type { Prisma } from "@/generated/prisma/client";
import {
  INSPECTION_SOURCE_TYPE,
  INSPECTION_TYPE,
} from "@/quickhack_shared/inspection/inspection-types";

type InspectionReadClient = Pick<Prisma.TransactionClient, "inspections">;

const POSTGRESQL_IN_FILTER_CHUNK_SIZE = 5_000;

export const inboundInspectionEvidenceSelect = {
  inspection_id: true,
  revision: true,
  pg_no: true,
  inbound_id: true,
  inspection_type: true,
  inspection_round: true,
  inspection_result: true,
  source_type: true,
  coupang_return_allocation_id: true,
  checked_by_user_id: true,
  appearance_grade: true,
  appearance_defect: true,
  appearance_worker: true,
  appearance_checked_at: true,
  function_defect: true,
  function_worker: true,
  function_checked_at: true,
  csc: true,
  first_call_date: true,
  return_yn: true,
  checked_at: true,
  note: true,
  created_at: true,
} satisfies Prisma.inspectionsSelect;

export type InboundInspectionEvidence = Prisma.inspectionsGetPayload<{
  select: typeof inboundInspectionEvidenceSelect;
}>;

export type InboundInspectionTarget = {
  pgNo: string;
  inboundId: number;
};

function chunks<T>(values: readonly T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

export async function loadInboundInspectionEvidence(
  client: InspectionReadClient,
  targets: readonly InboundInspectionTarget[]
) {
  const targetPgByInboundId = new Map<number, string>();

  for (const target of targets) {
    if (Number.isSafeInteger(target.inboundId) && target.inboundId > 0) {
      targetPgByInboundId.set(target.inboundId, target.pgNo);
    }
  }

  const inboundIds = [...targetPgByInboundId.keys()].sort((left, right) => left - right);
  const rows = (
    await Promise.all(
      chunks(inboundIds, POSTGRESQL_IN_FILTER_CHUNK_SIZE).map((inboundIdChunk) =>
        client.inspections.findMany({
          where: {
            inbound_id: { in: inboundIdChunk },
            source_type: {
              in: [
                INSPECTION_SOURCE_TYPE.inbound,
                INSPECTION_SOURCE_TYPE.manual,
              ],
            },
            inspection_type: {
              in: [INSPECTION_TYPE.appearance, INSPECTION_TYPE.function],
            },
          },
          orderBy: { inspection_id: "desc" },
          select: inboundInspectionEvidenceSelect,
        })
      )
    )
  ).flat();
  const evidenceByInboundId = new Map<number, InboundInspectionEvidence[]>();

  for (const row of rows) {
    if (
      row.inbound_id === null ||
      targetPgByInboundId.get(row.inbound_id) !== row.pg_no
    ) {
      continue;
    }

    const current = evidenceByInboundId.get(row.inbound_id) ?? [];
    current.push(row);
    evidenceByInboundId.set(row.inbound_id, current);
  }

  return evidenceByInboundId;
}
