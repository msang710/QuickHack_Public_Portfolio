import type { Prisma } from "@/generated/prisma/client";
import {
  databaseDateTime,
  databaseNow,
  type DatabaseDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import type { DateTimeInput } from "@/quickhack_shared/core/time";

export const SALES_CHANNEL_PROJECTION_CHANNEL = {
  coupang: "COUPANG",
} as const;

export type SalesChannelProjectionChannel =
  (typeof SALES_CHANNEL_PROJECTION_CHANNEL)[keyof typeof SALES_CHANNEL_PROJECTION_CHANNEL];

export type SalesChannelProjectionObservation = {
  channel: SalesChannelProjectionChannel;
  revision: number;
  startedAt: DatabaseDateTime;
};

type ProjectionRevisionClient = Pick<
  Prisma.TransactionClient,
  "sales_channel_projection_clocks"
>;

export async function advanceSalesChannelProjectionRevision(
  client: ProjectionRevisionClient,
  channel: SalesChannelProjectionChannel,
  timestamp: DateTimeInput = databaseNow()
) {
  const persistedAt = databaseDateTime(timestamp);
  const clock = await client.sales_channel_projection_clocks.upsert({
    where: { channel },
    create: {
      channel,
      current_revision: 1,
      created_at: persistedAt,
      updated_at: persistedAt,
    },
    update: {
      current_revision: { increment: 1 },
      updated_at: persistedAt,
    },
    select: { current_revision: true },
  });

  return clock.current_revision;
}

export async function reserveSalesChannelProjectionObservation(
  channel: SalesChannelProjectionChannel =
    SALES_CHANNEL_PROJECTION_CHANNEL.coupang,
  startedAt: DateTimeInput = databaseNow()
): Promise<SalesChannelProjectionObservation> {
  const persistedAt = databaseDateTime(startedAt);
  const revision = await prisma.$transaction((tx) =>
    advanceSalesChannelProjectionRevision(tx, channel, persistedAt)
  );

  return { channel, revision, startedAt: persistedAt };
}
