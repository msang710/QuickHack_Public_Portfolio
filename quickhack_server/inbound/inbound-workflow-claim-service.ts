import type { Prisma } from "@/generated/prisma/client";

type TransactionClient = Prisma.TransactionClient;

export type InboundWorkflowClaimResult =
  | { claimed: true }
  | {
      claimed: false;
      currentStatus: string | null;
      currentRevision: number | null;
    };

// The conditional no-op update acquires the inbound row's transaction lock.
// Callers must reload their dependent snapshot after a successful claim.
export async function claimInboundWorkflowState(
  tx: TransactionClient,
  input: {
    inboundId: number;
    pgNo: string;
    expectedStatus: string;
    expectedRevision: number;
  }
): Promise<InboundWorkflowClaimResult> {
  const claimed = await tx.inbounds.updateMany({
    where: {
      inbound_id: input.inboundId,
      pg_no: input.pgNo,
      inbound_status: input.expectedStatus,
      revision: input.expectedRevision,
    },
    data: {
      inbound_status: input.expectedStatus,
    },
  });

  if (claimed.count === 1) {
    return { claimed: true };
  }

  const current = await tx.inbounds.findFirst({
    where: {
      inbound_id: input.inboundId,
      pg_no: input.pgNo,
    },
    select: { inbound_status: true, revision: true },
  });

  return {
    claimed: false,
    currentStatus: current?.inbound_status ?? null,
    currentRevision: current?.revision ?? null,
  };
}
