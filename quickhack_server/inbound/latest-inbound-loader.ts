import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { LatestInboundDeviceDto } from "@/quickhack_shared/inbound/inbound-reconciliation";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

type InboundReadClient = Pick<PrismaClient, "inbounds">;

const POSTGRESQL_IN_FILTER_CHUNK_SIZE = 5_000;

const latestInboundSelect = {
  inbound_id: true,
  pg_no: true,
  inbound_batch_id: true,
  inbound_status: true,
  received_at: true,
  created_at: true,
  updated_at: true,
  devices: {
    select: {
      inventory_sku_id: true,
      model: true,
      storage: true,
      color: true,
      sale_grade: true,
    },
  },
} satisfies Prisma.inboundsSelect;

type LatestInboundRow = Prisma.inboundsGetPayload<{
  select: typeof latestInboundSelect;
}>;

function uniqueNonEmpty(values: readonly string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  );
}

function chunks<T>(values: readonly T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

function toDto(row: LatestInboundRow): LatestInboundDeviceDto {
  return {
    inboundId: row.inbound_id,
    pgNo: row.pg_no,
    inboundBatchId: row.inbound_batch_id,
    inboundStatus: row.inbound_status,
    receivedAt: apiDateTime(row.received_at),
    createdAt: requiredApiDateTime(row.created_at),
    updatedAt: requiredApiDateTime(row.updated_at),
    inventorySkuId: row.devices.inventory_sku_id,
    model: row.devices.model,
    storage: row.devices.storage,
    color: row.devices.color,
    saleGrade: row.devices.sale_grade,
  };
}

async function latestInboundIds(
  client: InboundReadClient,
  pgNos: readonly string[] | undefined
) {
  if (pgNos && pgNos.length === 0) {
    return [];
  }

  const groups = pgNos
    ? (
        await Promise.all(
          chunks(pgNos, POSTGRESQL_IN_FILTER_CHUNK_SIZE).map((pgNoChunk) =>
            client.inbounds.groupBy({
              by: ["pg_no"],
              where: { pg_no: { in: pgNoChunk } },
              _max: { inbound_id: true },
            })
          )
        )
      ).flat()
    : await client.inbounds.groupBy({
        by: ["pg_no"],
        _max: { inbound_id: true },
      });

  return groups
    .map((group) => group._max.inbound_id)
    .filter((inboundId): inboundId is number => typeof inboundId === "number");
}

export async function loadLatestInbounds(
  client: InboundReadClient,
  options: { pgNos?: readonly string[] } = {}
) {
  const pgNos = options.pgNos
    ? uniqueNonEmpty(options.pgNos)
    : undefined;
  const inboundIds = await latestInboundIds(client, pgNos);

  if (inboundIds.length === 0) {
    return [];
  }

  const rows = (
    await Promise.all(
      chunks(inboundIds, POSTGRESQL_IN_FILTER_CHUNK_SIZE).map((inboundIdChunk) =>
        client.inbounds.findMany({
          where: { inbound_id: { in: inboundIdChunk } },
          select: latestInboundSelect,
          orderBy: { inbound_id: "asc" },
        })
      )
    )
  )
    .flat()
    .sort((left, right) => left.inbound_id - right.inbound_id);

  return rows.map(toDto);
}
