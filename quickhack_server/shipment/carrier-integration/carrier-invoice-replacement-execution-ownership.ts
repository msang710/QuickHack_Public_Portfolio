import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  parseKstSqlDateTime,
  quickHackClock,
  type DateTimeInput,
} from "@/quickhack_shared/core/time";
import {
  databaseDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import {
  CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE,
  TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES,
} from "@/quickhack_shared/shipment/invoice-replacement";

export const REPLACEMENT_EXECUTION_STALE_AFTER_MS = 15 * 60 * 1000;

type ReplacementExecutionClient = Pick<
  Prisma.TransactionClient,
  "carrier_invoice_replacement_works"
>;

type ReplacementExecutionRow = {
  execution_token: string | null;
  execution_started_at: Date | null;
};

const TERMINAL_STATUSES = new Set<string>(
  TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES
);

export class ReplacementExecutionOwnershipError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReplacementExecutionOwnershipError";
    this.code = code;
  }
}

export function replacementExecutionState(
  row: ReplacementExecutionRow,
  now = quickHackClock.nowDate()
) {
  if (!row.execution_token) {
    return CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE.idle;
  }
  const startedAt = parseKstSqlDateTime(row.execution_started_at);
  if (
    !startedAt ||
    now.getTime() - startedAt.getTime() >= REPLACEMENT_EXECUTION_STALE_AFTER_MS
  ) {
    return CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE.stale;
  }
  return CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE.running;
}

export async function claimReplacementExecution(input: {
  client?: ReplacementExecutionClient;
  workId: number;
  expectedStatuses?: readonly string[];
  expectedStages?: readonly string[];
  allowStaleTakeover?: boolean;
  executionToken?: string;
  claimedAt?: DateTimeInput;
}) {
  const client = input.client ?? prisma;
  const observed = await client.carrier_invoice_replacement_works.findUnique({
    where: { carrier_invoice_replacement_work_id: input.workId },
    select: {
      work_status: true,
      current_stage: true,
      workflow_version: true,
      execution_token: true,
      execution_started_at: true,
    },
  });
  if (!observed) {
    throw new ReplacementExecutionOwnershipError(
      "REPLACEMENT_WORK_NOT_FOUND",
      "The carrier invoice replacement work was not found."
    );
  }
  if (TERMINAL_STATUSES.has(observed.work_status)) {
    throw new ReplacementExecutionOwnershipError(
      "REPLACEMENT_WORK_TERMINAL",
      "A terminal carrier invoice replacement work cannot be claimed."
    );
  }
  if (
    input.expectedStatuses &&
    !input.expectedStatuses.includes(observed.work_status)
  ) {
    throw new ReplacementExecutionOwnershipError(
      "REPLACEMENT_STATE_CONFLICT",
      "The carrier invoice replacement status changed before it was claimed."
    );
  }
  if (
    input.expectedStages &&
    !input.expectedStages.includes(observed.current_stage)
  ) {
    throw new ReplacementExecutionOwnershipError(
      "REPLACEMENT_STATE_CONFLICT",
      "The carrier invoice replacement stage changed before it was claimed."
    );
  }

  const executionState = replacementExecutionState(observed);
  if (
    executionState === CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE.running ||
    (executionState === CARRIER_INVOICE_REPLACEMENT_EXECUTION_STATE.stale &&
      input.allowStaleTakeover === false)
  ) {
    throw new ReplacementExecutionOwnershipError(
      "REPLACEMENT_EXECUTION_IN_PROGRESS",
      "The carrier invoice replacement is already being processed."
    );
  }

  const executionToken = input.executionToken ?? randomUUID();
  const claimedAt = input.claimedAt
    ? databaseDateTime(input.claimedAt)
    : databaseNow();
  const claimed = await client.carrier_invoice_replacement_works.updateMany({
    where: {
      carrier_invoice_replacement_work_id: input.workId,
      work_status: observed.work_status,
      current_stage: observed.current_stage,
      workflow_version: observed.workflow_version,
      execution_token: observed.execution_token,
      execution_started_at: observed.execution_started_at,
    },
    data: {
      execution_token: executionToken,
      execution_started_at: claimedAt,
      workflow_version: { increment: 1 },
      updated_at: claimedAt,
    },
  });
  if (claimed.count !== 1) {
    throw new ReplacementExecutionOwnershipError(
      "REPLACEMENT_EXECUTION_IN_PROGRESS",
      "The carrier invoice replacement was claimed by another request."
    );
  }
  return {
    executionToken,
    workflowVersion: observed.workflow_version + 1,
    previousStatus: observed.work_status,
    previousStage: observed.current_stage,
  };
}

export async function updateOwnedReplacement(input: {
  client?: ReplacementExecutionClient;
  workId: number;
  executionToken: string;
  workflowVersion: number;
  expectedStatuses?: readonly string[];
  expectedStages?: readonly string[];
  data: Prisma.carrier_invoice_replacement_worksUncheckedUpdateManyInput;
}) {
  const client = input.client ?? prisma;
  const updated = await client.carrier_invoice_replacement_works.updateMany({
    where: {
      carrier_invoice_replacement_work_id: input.workId,
      execution_token: input.executionToken,
      workflow_version: input.workflowVersion,
      ...(input.expectedStatuses
        ? { work_status: { in: [...input.expectedStatuses] } }
        : {}),
      ...(input.expectedStages
        ? { current_stage: { in: [...input.expectedStages] } }
        : {}),
    },
    data: {
      ...input.data,
      workflow_version: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    throw new ReplacementExecutionOwnershipError(
      "REPLACEMENT_EXECUTION_OWNERSHIP_LOST",
      "The carrier invoice replacement execution ownership changed."
    );
  }
  return input.workflowVersion + 1;
}

export async function releaseReplacementExecution(input: {
  client?: ReplacementExecutionClient;
  workId: number;
  executionToken: string;
  workflowVersion: number;
  expectedStatuses?: readonly string[];
  expectedStages?: readonly string[];
  data?: Prisma.carrier_invoice_replacement_worksUncheckedUpdateManyInput;
}) {
  return updateOwnedReplacement({
    ...input,
    data: {
      ...input.data,
      execution_token: null,
      execution_started_at: null,
    },
  });
}

export async function transitionReplacement(input: {
  client?: ReplacementExecutionClient;
  workId: number;
  workflowVersion: number;
  expectedStatuses?: readonly string[];
  expectedStages?: readonly string[];
  data: Prisma.carrier_invoice_replacement_worksUncheckedUpdateManyInput;
}) {
  const client = input.client ?? prisma;
  const updated = await client.carrier_invoice_replacement_works.updateMany({
    where: {
      carrier_invoice_replacement_work_id: input.workId,
      workflow_version: input.workflowVersion,
      execution_token: null,
      execution_started_at: null,
      work_status: {
        notIn: [...TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES],
        ...(input.expectedStatuses
          ? { in: [...input.expectedStatuses] }
          : {}),
      },
      ...(input.expectedStages
        ? { current_stage: { in: [...input.expectedStages] } }
        : {}),
    },
    data: {
      ...input.data,
      workflow_version: { increment: 1 },
    },
  });
  return updated.count === 1;
}
