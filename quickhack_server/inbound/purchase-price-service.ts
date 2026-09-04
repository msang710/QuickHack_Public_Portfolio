// QuickHack object: stable product option ids own purchase-price criteria and labels are read projections only.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  databaseDate,
  databaseNow,
  requiredApiDate,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import {
  publicBadRequest,
  publicConflict,
} from "@/quickhack_server/core/public-error";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";

type PurchasePriceRateInput = Record<string, unknown>;

export type PurchasePriceRateDto = {
  id: number;
  revision: number;
  modelOptionId: number;
  modelOptionKey: string;
  model: string;
  storageOptionId: number;
  storageOptionKey: string;
  storage: string;
  appearanceGradeOptionId: number;
  appearanceGradeOptionKey: string;
  appearanceGrade: string;
  priceDate: string;
  purchasePrice: number;
  note: string;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

type PurchasePriceRateRow = Prisma.purchase_price_ratesGetPayload<{
  include: {
    model_option: { select: { option_key: true; label: true } };
    storage_option: { select: { option_key: true; label: true } };
    appearance_grade_option: { select: { option_key: true; label: true } };
  };
}>;

type NormalizedRateInput = {
  modelOptionId: number;
  storageOptionId: number;
  appearanceGradeOptionId: number;
  expectedRevision: number | null;
  purchasePrice: number;
};

type NormalizedPurchasePriceInput = {
  priceDate: string;
  note: string;
  rates: NormalizedRateInput[];
};

const rateInclude = {
  model_option: { select: { option_key: true, label: true } },
  storage_option: { select: { option_key: true, label: true } },
  appearance_grade_option: { select: { option_key: true, label: true } },
} as const;

function inputError(message: string) {
  return publicBadRequest("PURCHASE_PRICE_INPUT_INVALID", message);
}

function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizePriceDate(value: unknown) {
  const normalized = text(value);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw inputError("PURCHASE_PRICE_INPUT_INVALID");
  }

  return normalized;
}

function positiveId(value: unknown, label: string) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw inputError("PURCHASE_PRICE_INPUT_INVALID");
  }

  return parsed;
}

function optionalRevision(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw inputError("PURCHASE_PRICE_INPUT_INVALID");
  }

  return parsed;
}

function normalizePurchasePrice(value: unknown) {
  const normalized = text(value).replace(/,/g, "");

  if (!/^\d+$/.test(normalized)) {
    throw inputError("PURCHASE_PRICE_INPUT_INVALID");
  }

  return Number.parseInt(normalized, 10);
}

function rateIdentity(input: {
  modelOptionId: number;
  storageOptionId: number;
  appearanceGradeOptionId: number;
}) {
  return [
    input.modelOptionId,
    input.storageOptionId,
    input.appearanceGradeOptionId,
  ].join(":");
}

function normalizeRateInputs(
  input: Record<string, unknown>
): NormalizedPurchasePriceInput {
  const priceDate = normalizePriceDate(input.priceDate);
  const note = text(input.note ?? input.conditionNote);
  const rawRates = Array.isArray(input.rates) ? input.rates : [];

  if (rawRates.length === 0) {
    throw inputError("PURCHASE_PRICE_INPUT_INVALID");
  }

  const rates = rawRates.map((rawRate): NormalizedRateInput => {
    const record =
      typeof rawRate === "object" && rawRate !== null
        ? (rawRate as PurchasePriceRateInput)
        : {};

    return {
      modelOptionId: positiveId(record.modelOptionId, "모델"),
      storageOptionId: positiveId(record.storageOptionId, "용량"),
      appearanceGradeOptionId: positiveId(
        record.appearanceGradeOptionId,
        "외관등급"
      ),
      expectedRevision: optionalRevision(record.expectedRevision),
      purchasePrice: normalizePurchasePrice(record.purchasePrice),
    };
  });
  const identities = rates.map(rateIdentity);

  if (new Set(identities).size !== identities.length) {
    throw inputError("PURCHASE_PRICE_INPUT_INVALID");
  }

  return { priceDate, note, rates };
}

function toDto(row: PurchasePriceRateRow): PurchasePriceRateDto {
  return {
    id: row.purchase_price_rate_id,
    revision: row.revision,
    modelOptionId: row.model_option_id,
    modelOptionKey: row.model_option.option_key,
    model: row.model_option.label,
    storageOptionId: row.storage_option_id,
    storageOptionKey: row.storage_option.option_key,
    storage: row.storage_option.label,
    appearanceGradeOptionId: row.appearance_grade_option_id,
    appearanceGradeOptionKey: row.appearance_grade_option.option_key,
    appearanceGrade:
      row.appearance_grade_option.label ||
      row.appearance_grade_option.option_key,
    priceDate: requiredApiDate(row.price_date),
    purchasePrice: row.purchase_price,
    note: row.note,
    createdByUserId: row.created_by_user_id,
    createdAt: requiredApiDateTime(row.created_at),
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

export async function listPurchasePriceRates(
  client: PrismaClient,
  priceDate: string,
  note: string
) {
  const normalizedDate = normalizePriceDate(priceDate);
  const rows = await client.purchase_price_rates.findMany({
    where: {
      price_date: databaseDate(normalizedDate),
      note: text(note),
    },
    include: rateInclude,
    orderBy: [
      { model_option_id: "asc" },
      { storage_option_id: "asc" },
      { appearance_grade_option_id: "asc" },
    ],
  });

  return rows.map(toDto);
}

export async function listPurchasePriceConditionNotes(
  client: PrismaClient,
  priceDate: string
) {
  const rows = await client.purchase_price_rates.findMany({
    where: { price_date: databaseDate(normalizePriceDate(priceDate)) },
    select: { note: true },
    orderBy: [{ note: "asc" }],
  });

  return Array.from(new Set(rows.map((row) => row.note)));
}

async function validateCriteria(
  tx: Prisma.TransactionClient,
  rates: NormalizedRateInput[]
) {
  const optionIds = Array.from(
    new Set(
      rates.flatMap((rate) => [
        rate.modelOptionId,
        rate.storageOptionId,
        rate.appearanceGradeOptionId,
      ])
    )
  ).sort((left, right) => left - right);
  await tx.$queryRaw`
    SELECT option_id
    FROM product_criteria_options
    WHERE option_id IN (${Prisma.join(optionIds)})
    ORDER BY option_id
    FOR SHARE
  `;
  const options = await tx.product_criteria_options.findMany({
    where: { option_id: { in: optionIds }, is_active: 1 },
    select: { option_id: true, category: true },
  });
  const categoryById = new Map(
    options.map((option) => [option.option_id, option.category])
  );

  for (const rate of rates) {
    if (
      categoryById.get(rate.modelOptionId) !== "PRODUCT_MODEL" ||
      categoryById.get(rate.storageOptionId) !== "STORAGE" ||
      categoryById.get(rate.appearanceGradeOptionId) !== "APPEARANCE_GRADE"
    ) {
      throw publicConflict(
        "PURCHASE_PRICE_CRITERIA_CONFLICT",
        "PURCHASE_PRICE_CRITERIA_CONFLICT"
      );
    }
  }

  const links = await tx.product_criteria_option_links.findMany({
    where: {
      relation_type: "MODEL_STORAGE",
      is_active: 1,
      OR: rates.map((rate) => ({
        parent_option_id: rate.modelOptionId,
        child_option_id: rate.storageOptionId,
      })),
    },
    select: { parent_option_id: true, child_option_id: true },
  });
  const linked = new Set(
    links.map((link) => `${link.parent_option_id}:${link.child_option_id}`)
  );

  for (const rate of rates) {
    if (!linked.has(`${rate.modelOptionId}:${rate.storageOptionId}`)) {
      throw publicConflict(
        "PURCHASE_PRICE_CRITERIA_CONFLICT",
        "PURCHASE_PRICE_CRITERIA_CONFLICT"
      );
    }
  }
}

export async function savePurchasePriceRates(
  client: PrismaClient,
  input: Record<string, unknown>,
  user: AuthUser
) {
  const normalized = normalizeRateInputs(input);
  const priceDate = databaseDate(normalized.priceDate);

  return runMeasuredTransaction(
    client,
    "inbound.purchase-price.save",
    async (tx) => {
      await validateCriteria(tx, normalized.rates);
      const orderedRates = [...normalized.rates].sort((left, right) =>
        rateIdentity(left).localeCompare(rateIdentity(right))
      );
      const prepared: Array<{
        input: NormalizedRateInput;
        before: PurchasePriceRateRow | null;
      }> = [];

      for (const rate of orderedRates) {
        const operationIdentity = [
          "PURCHASE_PRICE_RATE",
          normalized.priceDate,
          normalized.note,
          rateIdentity(rate),
        ].join(":");
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${operationIdentity}, 0)
          )
        `;
        await tx.$queryRaw`
          SELECT purchase_price_rate_id
          FROM purchase_price_rates
          WHERE model_option_id = ${rate.modelOptionId}
            AND storage_option_id = ${rate.storageOptionId}
            AND appearance_grade_option_id = ${rate.appearanceGradeOptionId}
            AND price_date = ${priceDate}
            AND note = ${normalized.note}
          FOR UPDATE
        `;
        const before = await tx.purchase_price_rates.findFirst({
          where: {
            model_option_id: rate.modelOptionId,
            storage_option_id: rate.storageOptionId,
            appearance_grade_option_id: rate.appearanceGradeOptionId,
            price_date: priceDate,
            note: normalized.note,
          },
          include: rateInclude,
        });

        if (before && rate.expectedRevision !== before.revision) {
          throw publicConflict(
            "PURCHASE_PRICE_RATE_CONFLICT",
            "PURCHASE_PRICE_RATE_CONFLICT",
            {
              rateId: before.purchase_price_rate_id,
              currentRevision: before.revision,
            }
          );
        }

        if (!before && rate.expectedRevision !== null) {
          throw publicConflict(
            "PURCHASE_PRICE_RATE_CONFLICT",
            "PURCHASE_PRICE_RATE_CONFLICT"
          );
        }

        prepared.push({ input: rate, before });
      }

      const savedRates: PurchasePriceRateDto[] = [];

      for (const item of prepared) {
        const timestamp = databaseNow();
        const unchanged =
          item.before?.purchase_price === item.input.purchasePrice;
        const after = unchanged
          ? item.before
          : item.before
            ? await tx.purchase_price_rates.update({
                where: {
                  purchase_price_rate_id:
                    item.before.purchase_price_rate_id,
                },
                data: {
                  purchase_price: item.input.purchasePrice,
                  revision: { increment: 1 },
                  created_by_user_id: user.userId,
                  updated_at: timestamp,
                },
                include: rateInclude,
              })
            : await tx.purchase_price_rates.create({
                data: {
                  model_option_id: item.input.modelOptionId,
                  storage_option_id: item.input.storageOptionId,
                  appearance_grade_option_id:
                    item.input.appearanceGradeOptionId,
                  price_date: priceDate,
                  purchase_price: item.input.purchasePrice,
                  note: normalized.note,
                  created_by_user_id: user.userId,
                  created_at: timestamp,
                  updated_at: timestamp,
                },
                include: rateInclude,
              });

        if (!after) {
          throw new Error("Purchase price save produced no row.");
        }

        if (!unchanged) {
          await tx.employee_activity_logs.create({
            data: {
              user_id: user.userId,
              action_type: "PURCHASE_PRICE_RATE_UPSERT",
              target_type: "PURCHASE_PRICE_RATE",
              target_id: String(after.purchase_price_rate_id),
              ...activityLogChangeData(
                item.before ? toDto(item.before) : null,
                toDto(after)
              ),
              result: "SUCCESS",
              created_at: timestamp,
            },
          });
        }

        savedRates.push(toDto(after));
      }

      return { savedRates };
    }
  );
}
