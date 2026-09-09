import type { Prisma } from "@/generated/prisma/client";
import { insertOrObserve } from "@/quickhack_server/core/database/aggregate-command";
import {
  databaseNow,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import {
  isRandomMatchingOption,
  RANDOM_MATCHING_OPTION_VALUE,
} from "@/quickhack_shared/sales-channel/order-matching";
import {
  WARRANTY_GROUPS,
  isWarrantyGroupCode,
  warrantyGroupLabel,
} from "@/quickhack_shared/sales-channel/sales-matching";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { prisma } from "@/quickhack_server/core/prisma";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";

type TransactionClient = Prisma.TransactionClient;
type SalesOfferReadClient = Pick<TransactionClient, "sales_offers">;
type MatchMode = "EXACT" | "ANY" | "RANDOM";
export type SalesOfferMutationOutcome =
  | "CREATED"
  | "REACTIVATED"
  | "DEACTIVATED"
  | "UNCHANGED";

type SalesOfferRow = Prisma.sales_offersGetPayload<{
  include: {
    model_option: { select: { label: true } };
    storage_option: { select: { label: true } };
    color_option: { select: { label: true } };
    warranty_group_option: { select: { option_key: true; label: true } };
  };
}>;

export type SalesOfferDefinitionInput = {
  modelOptionId?: unknown;
  storageOptionId?: unknown;
  colorOptionId?: unknown;
  warrantyGroupOptionId?: unknown;
  storageMatchMode?: unknown;
  colorMatchMode?: unknown;
  model?: unknown;
  storage?: unknown;
  color?: unknown;
  warrantyGroup?: unknown;
};

const salesOfferInclude = {
  model_option: { select: { label: true } },
  storage_option: { select: { label: true } },
  color_option: { select: { label: true } },
  warranty_group_option: { select: { option_key: true, label: true } },
} as const;

function nullableText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function requiredText(value: unknown, label: string) {
  const text = nullableText(value);

  if (!text) {
    throw publicBadRequest(
      "SALES_OFFER_VALUE_REQUIRED",
      "SALES_OFFER_VALUE_REQUIRED"
    );
  }

  return text;
}

function matchingCondition(value: unknown): {
  mode: MatchMode;
  value: string | null;
} {
  const normalized = nullableText(value);

  if (!normalized) {
    return { mode: "ANY", value: null };
  }

  if (isRandomMatchingOption(normalized)) {
    return { mode: "RANDOM", value: null };
  }

  return { mode: "EXACT", value: normalized };
}

function boolValue(value: unknown, fallback: boolean) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return !["0", "FALSE", "N", "NO", "INACTIVE"].includes(
    String(value).trim().toUpperCase()
  );
}

function conditionValue(mode: string, label: string | null) {
  if (mode === "RANDOM") {
    return RANDOM_MATCHING_OPTION_VALUE;
  }

  return mode === "EXACT" ? label : null;
}

function salesOfferDto(row: SalesOfferRow, mappedVendorItemCount = 0) {
  const warrantyGroup = row.warranty_group_option.option_key.toUpperCase();

  return {
    id: row.sales_offer_id,
    revision: row.revision,
    offerCode: row.offer_code,
    modelOptionId: row.model_option_id,
    model: row.model_option.label,
    storageMatchMode: row.storage_match_mode as MatchMode,
    requiredStorage: conditionValue(
      row.storage_match_mode,
      row.storage_option?.label ?? null
    ),
    storageOptionId: row.storage_option_id,
    colorMatchMode: row.color_match_mode as MatchMode,
    requiredColor: conditionValue(
      row.color_match_mode,
      row.color_option?.label ?? null
    ),
    colorOptionId: row.color_option_id,
    warrantyGroupOptionId: row.warranty_group_option_id,
    warrantyGroup,
    warrantyLabel:
      row.warranty_group_option.label || warrantyGroupLabel(warrantyGroup),
    isActive: row.is_active === 1,
    mappedVendorItemCount,
    createdAt: requiredApiDateTime(row.created_at),
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

function optionalPositiveId(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function matchingConditionFromInput(
  explicitMode: unknown,
  optionId: unknown,
  legacyValue: unknown
) {
  const mode = String(explicitMode ?? "").trim().toUpperCase();

  if (mode === "ANY" || mode === "RANDOM") {
    return { mode: mode as MatchMode, value: null };
  }

  if (mode === "EXACT" || optionalPositiveId(optionId)) {
    return { mode: "EXACT" as const, value: nullableText(legacyValue) };
  }

  return matchingCondition(legacyValue);
}

async function requireActiveOptionById(
  tx: TransactionClient,
  category: string,
  optionId: number,
  label: string
) {
  const option = await tx.product_criteria_options.findUnique({
    where: { option_id: optionId },
  });

  if (!option || option.category !== category || option.is_active !== 1) {
    throw publicBadRequest(
      "SALES_OFFER_CRITERIA_NOT_FOUND",
      "SALES_OFFER_CRITERIA_NOT_FOUND"
    );
  }

  return option;
}

async function requireUniqueActiveOption(
  tx: TransactionClient,
  category: string,
  value: string,
  label: string,
  field: "label" | "option_key" = "label"
) {
  const options = await tx.product_criteria_options.findMany({
    where: { category, is_active: 1, [field]: value },
    orderBy: { option_id: "asc" },
    take: 2,
  });

  if (options.length === 0) {
    throw publicBadRequest(
      "SALES_OFFER_CRITERIA_NOT_FOUND",
      "SALES_OFFER_CRITERIA_NOT_FOUND"
    );
  }

  if (options.length > 1) {
    throw publicConflict(
      "SALES_OFFER_CRITERIA_AMBIGUOUS",
      "SALES_OFFER_CRITERIA_AMBIGUOUS"
    );
  }

  return options[0];
}

async function resolveActiveOption(
  tx: TransactionClient,
  input: {
    optionId: unknown;
    category: string;
    fallbackValue: unknown;
    fallbackField?: "label" | "option_key";
    label: string;
  }
) {
  const optionId = optionalPositiveId(input.optionId);

  return optionId
    ? requireActiveOptionById(tx, input.category, optionId, input.label)
    : requireUniqueActiveOption(
        tx,
        input.category,
        requiredText(input.fallbackValue, input.label),
        input.label,
        input.fallbackField
      );
}

export async function resolveOrCreateSalesOffer(
  tx: TransactionClient,
  input: SalesOfferDefinitionInput,
  options: {
    actorUserId?: number | null;
    desiredActive?: boolean;
  } = {}
) {
  const storage = matchingConditionFromInput(
    input.storageMatchMode,
    input.storageOptionId,
    input.storage
  );
  const color = matchingConditionFromInput(
    input.colorMatchMode,
    input.colorOptionId,
    input.color
  );
  const [modelOption, warrantyOption, storageOption, colorOption] =
    await Promise.all([
      resolveActiveOption(tx, {
        optionId: input.modelOptionId,
        category: "PRODUCT_MODEL",
        fallbackValue: input.model,
        label: "모델",
      }),
      resolveActiveOption(tx, {
        optionId: input.warrantyGroupOptionId,
        category: "WARRANTY_GROUP",
        fallbackValue: String(input.warrantyGroup ?? "").trim().toUpperCase(),
        fallbackField: "option_key",
        label: "판매 보증조건",
      }),
      storage.mode === "EXACT"
        ? resolveActiveOption(tx, {
            optionId: input.storageOptionId,
            category: "STORAGE",
            fallbackValue: storage.value,
            label: "용량",
          })
        : Promise.resolve(null),
      color.mode === "EXACT"
        ? resolveActiveOption(tx, {
            optionId: input.colorOptionId,
            category: "DEVICE_COLOR",
            fallbackValue: color.value,
            label: "색상",
          })
        : Promise.resolve(null),
    ]);
  const warrantyGroup = warrantyOption.option_key.toUpperCase();

  if (!isWarrantyGroupCode(warrantyGroup)) {
    throw publicBadRequest(
      "INVALID_SALES_OFFER_WARRANTY",
      "INVALID_SALES_OFFER_WARRANTY"
    );
  }
  const where = {
    model_option_id: modelOption.option_id,
    storage_match_mode: storage.mode,
    storage_option_id: storageOption?.option_id ?? null,
    color_match_mode: color.mode,
    color_option_id: colorOption?.option_id ?? null,
    warranty_group_option_id: warrantyOption.option_id,
  };
  const desiredActive = options.desiredActive ?? true;
  const desiredActiveValue = desiredActive ? 1 : 0;
  const existing = await tx.sales_offers.findFirst({ where });

  if (existing) {
    await lockSalesOffer(tx, existing.sales_offer_id);
    const current = await tx.sales_offers.findUniqueOrThrow({
      where: { sales_offer_id: existing.sales_offer_id },
    });

    if (current.is_active !== desiredActiveValue) {
      if (!desiredActive) {
        await assertSalesOfferCanDeactivate(tx, current.sales_offer_id);
      }

      const row = await tx.sales_offers.update({
        where: { sales_offer_id: current.sales_offer_id },
        data: {
          is_active: desiredActiveValue,
          revision: { increment: 1 },
          updated_by_user_id: options.actorUserId ?? null,
          updated_at: databaseNow(),
        },
      });

      return {
        row,
        outcome: desiredActive ? "REACTIVATED" : "DEACTIVATED",
        beforeIsActive: current.is_active === 1,
      } as const;
    }

    return {
      row: current,
      outcome: "UNCHANGED",
      beforeIsActive: current.is_active === 1,
    } as const;
  }

  const offerCode =
    `QH-OFFER-M${where.model_option_id}` +
    `-S${storage.mode}${where.storage_option_id ?? ""}` +
    `-C${color.mode}${where.color_option_id ?? ""}` +
    `-W${where.warranty_group_option_id}`;
  const timestamp = databaseNow();

  const resolved = await insertOrObserve({
    name: "sales_offers.offer_code",
    insert: () => tx.$queryRaw<Array<{ sales_offer_id: number }>>`
      INSERT INTO sales_offers (
        offer_code,
        model_option_id,
        storage_match_mode,
        storage_option_id,
        color_match_mode,
        color_option_id,
        warranty_group_option_id,
        is_active,
        created_by_user_id,
        updated_by_user_id,
        created_at,
        updated_at
      ) VALUES (
        ${offerCode},
        ${where.model_option_id},
        ${where.storage_match_mode},
        ${where.storage_option_id},
        ${where.color_match_mode},
        ${where.color_option_id},
        ${where.warranty_group_option_id},
        ${desiredActiveValue},
        ${options.actorUserId ?? null},
        ${options.actorUserId ?? null},
        ${timestamp},
        ${timestamp}
      )
      ON CONFLICT (offer_code) DO NOTHING
      RETURNING sales_offer_id
    `,
    observe: () => tx.sales_offers.findUnique({
      where: { offer_code: offerCode },
      select: { sales_offer_id: true },
    }),
  });

  if (resolved.inserted) {
    const row = await tx.sales_offers.findUniqueOrThrow({
      where: { sales_offer_id: resolved.row.sales_offer_id },
    });
    return {
      row,
      outcome: "CREATED",
      beforeIsActive: null,
    } as const;
  }

  await lockSalesOffer(tx, resolved.row.sales_offer_id);
  const current = await tx.sales_offers.findUniqueOrThrow({
    where: { sales_offer_id: resolved.row.sales_offer_id },
  });
  const sameIdentity =
    current.offer_code === offerCode &&
    current.model_option_id === where.model_option_id &&
    current.storage_match_mode === where.storage_match_mode &&
    current.storage_option_id === where.storage_option_id &&
    current.color_match_mode === where.color_match_mode &&
    current.color_option_id === where.color_option_id &&
    current.warranty_group_option_id === where.warranty_group_option_id;
  if (!sameIdentity) {
    throw new Error(`Sales offer identity collision: ${offerCode}.`);
  }

  if (current.is_active !== desiredActiveValue) {
    if (!desiredActive) {
      await assertSalesOfferCanDeactivate(tx, current.sales_offer_id);
    }

    const row = await tx.sales_offers.update({
      where: { sales_offer_id: current.sales_offer_id },
      data: {
        is_active: desiredActiveValue,
        revision: { increment: 1 },
        updated_by_user_id: options.actorUserId ?? null,
        updated_at: databaseNow(),
      },
    });

    return {
      row,
      outcome: desiredActive ? "REACTIVATED" : "DEACTIVATED",
      beforeIsActive: current.is_active === 1,
    } as const;
  }

  return {
    row: current,
    outcome: "UNCHANGED",
    beforeIsActive: current.is_active === 1,
  } as const;
}

async function getSalesOfferDefinition(
  tx: SalesOfferReadClient,
  salesOfferId: number,
  requireActive: boolean
) {
  const offer = await tx.sales_offers.findUnique({
    where: { sales_offer_id: salesOfferId },
    include: {
      model_option: true,
      storage_option: true,
      color_option: true,
      warranty_group_option: true,
    },
  });

  if (!offer || (requireActive && offer.is_active !== 1)) {
    return null;
  }

  const warrantyGroup = offer.warranty_group_option.option_key.toUpperCase();

  if (!isWarrantyGroupCode(warrantyGroup)) {
    throw new Error(`판매 오퍼의 보증조건이 올바르지 않습니다: ${offer.offer_code}`);
  }

  return {
    salesOfferId: offer.sales_offer_id,
    revision: offer.revision,
    offerCode: offer.offer_code,
    modelOptionId: offer.model_option_id,
    model: offer.model_option.label,
    storageOptionId: offer.storage_option_id,
    requiredStorage:
      offer.storage_match_mode === "RANDOM"
        ? RANDOM_MATCHING_OPTION_VALUE
        : offer.storage_option?.label ?? null,
    requiredColor:
      offer.color_match_mode === "RANDOM"
        ? RANDOM_MATCHING_OPTION_VALUE
        : offer.color_option?.label ?? null,
    colorOptionId: offer.color_option_id,
    warrantyGroupOptionId: offer.warranty_group_option_id,
    requiredWarrantyGroup: warrantyGroup,
  };
}

/** Resolves a definition for selecting a current product mapping. */
export async function getSalesOfferMatchingDefinition(
  tx: SalesOfferReadClient,
  salesOfferId: number
) {
  return getSalesOfferDefinition(tx, salesOfferId, true);
}

/** Resolves the immutable offer referenced by an existing order snapshot. */
export async function getSalesOfferSnapshotDefinition(
  tx: SalesOfferReadClient,
  salesOfferId: number
) {
  return getSalesOfferDefinition(tx, salesOfferId, false);
}

export async function listSalesOffers() {
  const [rows, counts] = await Promise.all([
    prisma.sales_offers.findMany({
      include: salesOfferInclude,
      orderBy: [
        { is_active: "desc" },
        { model_option_id: "asc" },
        { warranty_group_option_id: "desc" },
        { storage_match_mode: "asc" },
        { storage_option_id: "asc" },
        { color_match_mode: "asc" },
        { color_option_id: "asc" },
      ],
    }),
    prisma.sales_channel_product_mappings.groupBy({
      by: ["sales_offer_id"],
      where: { sales_offer_id: { not: null } },
      _count: { mapping_id: true },
    }),
  ]);
  const countByOfferId = new Map(
    counts
      .filter((row) => row.sales_offer_id !== null)
      .map((row) => [row.sales_offer_id as number, row._count.mapping_id])
  );

  return rows.map((row) =>
    salesOfferDto(row, countByOfferId.get(row.sales_offer_id) ?? 0)
  );
}

function salesOfferSnapshot(
  row: SalesOfferRow,
  isActive = row.is_active === 1
) {
  return {
    offerCode: row.offer_code,
    model: row.model_option.label,
    storageMatchMode: row.storage_match_mode,
    storage:
      row.storage_match_mode === "EXACT"
        ? row.storage_option?.label ?? null
        : null,
    colorMatchMode: row.color_match_mode,
    color:
      row.color_match_mode === "EXACT"
        ? row.color_option?.label ?? null
        : null,
    warrantyGroup: row.warranty_group_option.option_key.toUpperCase(),
    isActive,
  };
}

function mutationActionType(
  outcome: Exclude<SalesOfferMutationOutcome, "UNCHANGED">
) {
  if (outcome === "CREATED") {
    return "SALES_OFFER_CREATE";
  }

  return outcome === "REACTIVATED"
    ? "SALES_OFFER_ACTIVATE"
    : "SALES_OFFER_DEACTIVATE";
}

async function readSalesOfferRow(
  tx: TransactionClient,
  salesOfferId: number
) {
  return tx.sales_offers.findUnique({
    where: { sales_offer_id: salesOfferId },
    include: salesOfferInclude,
  });
}

async function mappedVendorItemCount(
  tx: TransactionClient,
  salesOfferId: number
) {
  return tx.sales_channel_product_mappings.count({
    where: { sales_offer_id: salesOfferId },
  });
}

async function lockSalesOffer(tx: TransactionClient, salesOfferId: number) {
  await tx.$queryRaw`
    SELECT sales_offer_id
    FROM sales_offers
    WHERE sales_offer_id = ${salesOfferId}
    FOR UPDATE
  `;
}

async function assertSalesOfferCanDeactivate(
  tx: TransactionClient,
  salesOfferId: number
) {
  const mappingCount = await mappedVendorItemCount(tx, salesOfferId);

  if (mappingCount > 0) {
    throw publicBadRequest(
      "SALES_OFFER_IN_USE",
      "SALES_OFFER_IN_USE"
    );
  }
}

async function logSalesOfferMutation(
  tx: TransactionClient,
  user: AuthUser,
  row: SalesOfferRow,
  outcome: Exclude<SalesOfferMutationOutcome, "UNCHANGED">,
  beforeIsActive: boolean | null,
  timestamp: Date
) {
  await tx.employee_activity_logs.create({
    data: {
      user_id: user.userId,
      action_type: mutationActionType(outcome),
      target_type: "SALES_OFFER",
      target_id: String(row.sales_offer_id),
      ...activityLogChangeData(
        outcome === "CREATED"
          ? null
          : salesOfferSnapshot(row, beforeIsActive ?? false),
        salesOfferSnapshot(row)
      ),
      result: "SUCCESS",
      created_at: timestamp,
    },
  });
}

export async function saveSalesOffer(
  input: Record<string, unknown>,
  user: AuthUser
) {
  const salesOfferId = Number(input.salesOfferId ?? 0);
  const isActive = boolValue(input.isActive, true);

  return prisma.$transaction(async (tx) => {
    const timestamp = databaseNow();
    let outcome: SalesOfferMutationOutcome;
    let beforeIsActive: boolean | null;
    let row: SalesOfferRow | null;

    if (Number.isInteger(salesOfferId) && salesOfferId > 0) {
      await lockSalesOffer(tx, salesOfferId);
      const existing = await readSalesOfferRow(tx, salesOfferId);

      if (!existing) {
        throw publicNotFound(
          "SALES_OFFER_NOT_FOUND",
          "SALES_OFFER_NOT_FOUND"
        );
      }

      const expectedRevision = Number(input.expectedRevision);

      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw publicBadRequest(
          "SALES_OFFER_REVISION_REQUIRED",
          "SALES_OFFER_REVISION_REQUIRED"
        );
      }

      if (existing.revision !== expectedRevision) {
        throw publicConflict(
          "SALES_OFFER_CONFLICT",
          "SALES_OFFER_CONFLICT",
          { currentRevision: existing.revision }
        );
      }

      beforeIsActive = existing.is_active === 1;
      if (beforeIsActive === isActive) {
        outcome = "UNCHANGED";
        row = existing;
      } else {
        if (!isActive) {
          await assertSalesOfferCanDeactivate(tx, salesOfferId);
        }
        outcome = isActive ? "REACTIVATED" : "DEACTIVATED";
        row = await tx.sales_offers.update({
          where: { sales_offer_id: salesOfferId },
          data: {
            is_active: isActive ? 1 : 0,
            revision: { increment: 1 },
            updated_by_user_id: user.userId,
            updated_at: timestamp,
          },
          include: salesOfferInclude,
        });
      }
    } else {
      const resolved = await resolveOrCreateSalesOffer(
        tx,
        {
          modelOptionId: input.modelOptionId,
          storageOptionId: input.storageOptionId,
          colorOptionId: input.colorOptionId,
          warrantyGroupOptionId: input.warrantyGroupOptionId,
          storageMatchMode: input.storageMatchMode,
          colorMatchMode: input.colorMatchMode,
          model: input.model,
          storage: input.storage,
          color: input.color,
          warrantyGroup: input.warrantyGroup,
        },
        {
          actorUserId: user.userId,
          desiredActive: isActive,
        }
      );
      outcome = resolved.outcome;
      beforeIsActive = resolved.beforeIsActive;
      row = await readSalesOfferRow(tx, resolved.row.sales_offer_id);
    }

    if (!row) {
      throw publicNotFound(
        "SALES_OFFER_NOT_FOUND",
        "SALES_OFFER_NOT_FOUND"
      );
    }

    if (outcome !== "UNCHANGED") {
      await logSalesOfferMutation(
        tx,
        user,
        row,
        outcome,
        beforeIsActive,
        timestamp
      );
    }

    const mappingCount = await mappedVendorItemCount(tx, row.sales_offer_id);
    return salesOfferDto(row, mappingCount);
  });
}

export async function bootstrapSalesOffersFromCriteria(user: AuthUser) {
  return prisma.$transaction(async (tx) => {
    const [models, warrantyOptions] = await Promise.all([
      tx.product_criteria_options.findMany({
        where: { category: "PRODUCT_MODEL", is_active: 1 },
        orderBy: [{ sort_order: "asc" }, { option_id: "asc" }],
        select: { option_id: true },
      }),
      tx.product_criteria_options.findMany({
        where: {
          category: "WARRANTY_GROUP",
          option_key: { in: [...WARRANTY_GROUPS] },
          is_active: 1,
        },
        select: { option_id: true, option_key: true },
      }),
    ]);
    const warrantyOptionIdByCode = new Map(
      warrantyOptions.map((option) => [
        option.option_key.toUpperCase(),
        option.option_id,
      ])
    );
    const timestamp = databaseNow();
    const affectedOfferIds: number[] = [];
    let createdCount = 0;
    let reactivatedCount = 0;
    let unchangedCount = 0;

    for (const model of models) {
      for (const warrantyGroup of WARRANTY_GROUPS) {
        const warrantyGroupOptionId = warrantyOptionIdByCode.get(warrantyGroup);

        if (!warrantyGroupOptionId) {
          throw publicBadRequest(
            "SALES_OFFER_CRITERIA_NOT_FOUND",
            "SALES_OFFER_CRITERIA_NOT_FOUND"
          );
        }

        const resolved = await resolveOrCreateSalesOffer(
          tx,
          {
            modelOptionId: model.option_id,
            warrantyGroupOptionId,
          },
          {
            actorUserId: user.userId,
            desiredActive: true,
          }
        );

        if (resolved.outcome === "CREATED") {
          createdCount += 1;
          affectedOfferIds.push(resolved.row.sales_offer_id);
        } else if (resolved.outcome === "REACTIVATED") {
          reactivatedCount += 1;
          affectedOfferIds.push(resolved.row.sales_offer_id);
        } else {
          unchangedCount += 1;
        }
      }
    }
    const offerCount = createdCount + reactivatedCount + unchangedCount;
    const summary = {
      distinctProductCount: models.length,
      offerCount,
      createdCount,
      reactivatedCount,
      unchangedCount,
      affectedCount: affectedOfferIds.length,
    };
    const summaryChangeData = activityLogChangeData(null, summary);
    const summaryChanges = summaryChangeData.changes?.create ?? [];

    await tx.employee_activity_logs.create({
      data: {
        user_id: user.userId,
        action_type: "SALES_OFFER_BOOTSTRAP",
        target_type: "SALES_OFFER",
        target_id: "BOOTSTRAP",
        before_summary_text: summaryChangeData.before_summary_text,
        after_summary_text: summaryChangeData.after_summary_text,
        changes: {
          create: [
            ...summaryChanges,
            ...affectedOfferIds.map((offerId, index) => ({
              field_name: `affectedOfferId.${String(index + 1).padStart(6, "0")}`,
              before_value: null,
              after_value: String(offerId),
            })),
          ],
        },
        result: "SUCCESS",
        created_at: timestamp,
      },
    });

    return summary;
  });
}
