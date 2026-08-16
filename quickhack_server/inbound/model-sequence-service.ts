import type { Prisma } from "@/generated/prisma/client";
import { lockAggregateKey } from "@/quickhack_server/core/database/aggregate-command";

type TransactionClient = Prisma.TransactionClient;

export async function allocateNextModelSequence(
  tx: TransactionClient,
  input: { model: string; timestamp: Date }
) {
  const model = input.model.trim();
  if (!model) {
    throw new Error("Model is required to allocate a model sequence.");
  }

  await lockAggregateKey(tx, { namespace: "model-sequence", key: model });
  const rows = await tx.$queryRaw<Array<{ last_seq: number }>>`
    INSERT INTO model_sequences (model, last_seq, created_at, updated_at)
    SELECT
      ${model},
      COALESCE(MAX(model_seq), 0) + 1,
      ${input.timestamp},
      ${input.timestamp}
    FROM devices
    WHERE model = ${model}
    ON CONFLICT (model) DO UPDATE
    SET
      last_seq = GREATEST(
        model_sequences.last_seq,
        EXCLUDED.last_seq - 1
      ) + 1,
      updated_at = EXCLUDED.updated_at
    RETURNING last_seq
  `;

  if (rows.length !== 1 || !Number.isInteger(rows[0].last_seq)) {
    throw new Error(`Failed to allocate a model sequence for ${model}.`);
  }
  return rows[0].last_seq;
}

export async function raiseModelSequenceFloor(
  tx: TransactionClient,
  input: { model: string; floor: number | null; timestamp: Date }
) {
  if (input.floor === null) return;
  const model = input.model.trim();
  if (!model || !Number.isSafeInteger(input.floor) || input.floor <= 0) {
    throw new Error("A valid model and positive sequence floor are required.");
  }

  await lockAggregateKey(tx, { namespace: "model-sequence", key: model });
  await tx.$executeRaw`
    INSERT INTO model_sequences (model, last_seq, created_at, updated_at)
    VALUES (${model}, ${input.floor}, ${input.timestamp}, ${input.timestamp})
    ON CONFLICT (model) DO UPDATE
    SET
      last_seq = GREATEST(model_sequences.last_seq, EXCLUDED.last_seq),
      updated_at = EXCLUDED.updated_at
  `;
}
