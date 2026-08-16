import type { Prisma } from "@/generated/prisma/client";
import { insertOrObserve } from "@/quickhack_server/core/database/aggregate-command";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";

type TransactionClient = Prisma.TransactionClient;

export type InventorySkuDefinitionInput = {
  modelOptionId?: unknown;
  storageOptionId?: unknown;
  colorOptionId?: unknown;
  saleGradeOptionId?: unknown;
  modelOptionKey?: unknown;
  model?: unknown;
  storage?: unknown;
  color?: unknown;
  saleGrade?: unknown;
};

export type InventorySkuCriteriaChanges = {
  modelLabel?: boolean;
  modelOptionKey?: boolean;
  storage?: boolean;
  color?: boolean;
  saleGrade?: boolean;
};

function requiredText(value: unknown, label: string) {
  const text = String(value ?? "").trim();

  if (!text) {
    throw publicBadRequest(
      "INVENTORY_SKU_INPUT_INVALID",
      `${label} 값이 없어 재고 SKU를 확정할 수 없습니다.`
    );
  }

  return text;
}

function optionalPositiveId(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
      "INVENTORY_SKU_CRITERIA_INVALID",
      `${label} 상품 기준값을 찾을 수 없거나 비활성 상태입니다.`
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
  const rows = await tx.product_criteria_options.findMany({
    where: { category, is_active: 1, [field]: value },
    orderBy: { option_id: "asc" },
    take: 2,
  });

  if (rows.length === 0) {
    throw publicBadRequest(
      "INVENTORY_SKU_CRITERIA_INVALID",
      `${label} '${value}'이(가) 상품 기준값에 등록되어 있지 않습니다.`
    );
  }

  if (rows.length > 1) {
    throw publicConflict(
      "INVENTORY_SKU_CRITERIA_AMBIGUOUS",
      `${label} '${value}'에 해당하는 기준값이 둘 이상입니다. option ID를 명시해 주세요.`
    );
  }

  return rows[0];
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

  if (optionId) {
    return requireActiveOptionById(tx, input.category, optionId, input.label);
  }

  return requireUniqueActiveOption(
    tx,
    input.category,
    requiredText(input.fallbackValue, input.label),
    input.label,
    input.fallbackField
  );
}

async function validateModelOptionLink(
  tx: TransactionClient,
  relationType: "MODEL_STORAGE" | "MODEL_COLOR",
  modelOptionId: number,
  childOptionId: number,
  label: string
) {
  const configuredCount = await tx.product_criteria_option_links.count({
    where: {
      relation_type: relationType,
      parent_option_id: modelOptionId,
      is_active: 1,
    },
  });

  if (configuredCount === 0) {
    return;
  }

  const allowed = await tx.product_criteria_option_links.findFirst({
    where: {
      relation_type: relationType,
      parent_option_id: modelOptionId,
      child_option_id: childOptionId,
      is_active: 1,
    },
    select: { link_id: true },
  });

  if (!allowed) {
    throw publicBadRequest(
      "INVENTORY_SKU_CRITERIA_INVALID",
      `선택한 ${label}은(는) 해당 모델에 허용된 기준값이 아닙니다.`
    );
  }
}

export async function resolveInventorySkuCriteria(
  tx: TransactionClient,
  input: InventorySkuDefinitionInput
) {
  const modelOption = await resolveActiveOption(tx, {
    optionId: input.modelOptionId,
    category: "PRODUCT_MODEL",
    fallbackValue: input.modelOptionKey ?? input.model,
    fallbackField: input.modelOptionKey ? "option_key" : "label",
    label: "모델",
  });
  const storageOption = await resolveActiveOption(tx, {
    optionId: input.storageOptionId,
    category: "STORAGE",
    fallbackValue: input.storage,
    label: "용량",
  });
  const colorOption = await resolveActiveOption(tx, {
    optionId: input.colorOptionId,
    category: "DEVICE_COLOR",
    fallbackValue: input.color,
    label: "색상",
  });
  const saleGradeOption = await resolveActiveOption(tx, {
    optionId: input.saleGradeOptionId,
    category: "SALE_GRADE",
    fallbackValue: String(input.saleGrade ?? "").trim().toUpperCase(),
    fallbackField: "option_key",
    label: "판매등급",
  });

  await validateModelOptionLink(
    tx,
    "MODEL_STORAGE",
    modelOption.option_id,
    storageOption.option_id,
    "용량"
  );
  await validateModelOptionLink(
    tx,
    "MODEL_COLOR",
    modelOption.option_id,
    colorOption.option_id,
    "색상"
  );

  return {
    model: modelOption.label,
    storage: storageOption.label,
    color: colorOption.label,
    saleGrade: saleGradeOption.option_key.toUpperCase(),
    modelOption,
    storageOption,
    colorOption,
    saleGradeOption,
  };
}

export async function resolveOrCreateInventorySku(
  tx: TransactionClient,
  input: InventorySkuDefinitionInput,
  options: {
    actorUserId?: number | null;
  } = {}
) {
  const criteria = await resolveInventorySkuCriteria(tx, input);
  const dimensions = {
    model_option_id: criteria.modelOption.option_id,
    storage_option_id: criteria.storageOption.option_id,
    color_option_id: criteria.colorOption.option_id,
    sale_grade_option_id: criteria.saleGradeOption.option_id,
  };
  const uniqueWhere = {
    model_option_id_storage_option_id_color_option_id_sale_grade_option_id:
      dimensions,
  } as const;
  const existing = await tx.inventory_skus.findUnique({ where: uniqueWhere });

  if (existing) {
    if (existing.is_active !== 1) {
      throw publicConflict(
        "INVENTORY_SKU_INACTIVE",
        `비활성화된 재고 SKU에는 새 재고를 연결할 수 없습니다: ${existing.sku_code}`
      );
    }

    return existing;
  }

  const skuCode =
    `QH-SKU-M${dimensions.model_option_id}` +
    `-S${dimensions.storage_option_id}` +
    `-C${dimensions.color_option_id}` +
    `-G${dimensions.sale_grade_option_id}`;
  const timestamp = databaseNow();

  const resolved = await insertOrObserve({
    name: "inventory_skus.dimensions",
    insert: () => tx.$queryRaw<Array<{ inventory_sku_id: number }>>`
      INSERT INTO inventory_skus (
        sku_code,
        model_option_id,
        storage_option_id,
        color_option_id,
        sale_grade_option_id,
        is_active,
        created_by_user_id,
        updated_by_user_id,
        created_at,
        updated_at
      ) VALUES (
        ${skuCode},
        ${dimensions.model_option_id},
        ${dimensions.storage_option_id},
        ${dimensions.color_option_id},
        ${dimensions.sale_grade_option_id},
        1,
        ${options.actorUserId ?? null},
        ${options.actorUserId ?? null},
        ${timestamp},
        ${timestamp}
      )
      ON CONFLICT DO NOTHING
      RETURNING inventory_sku_id
    `,
    observe: async () => {
      const concurrent = await tx.inventory_skus.findUnique({
        where: uniqueWhere,
        select: { inventory_sku_id: true },
      });
      return concurrent;
    },
  });
  const row = await tx.inventory_skus.findUniqueOrThrow({
    where: { inventory_sku_id: resolved.row.inventory_sku_id },
  });

  if (row.is_active !== 1) {
    throw publicConflict(
      "INVENTORY_SKU_INACTIVE",
      `비활성화된 재고 SKU에는 새 재고를 연결할 수 없습니다: ${row.sku_code}`
    );
  }

  return row;
}

export async function assignCurrentInventorySkuToDevice(
  tx: TransactionClient,
  pgNo: string,
  options: {
    actorUserId?: number | null;
    required?: boolean;
    changedCriteria?: InventorySkuCriteriaChanges;
  } = {}
) {
  const device = await tx.devices.findUnique({
    where: { pg_no: pgNo },
    select: {
      pg_no: true,
      model_code: true,
      model: true,
      storage: true,
      color: true,
      sale_grade: true,
      inventory_sku_id: true,
      inventory: {
        select: { inventory_id: true },
      },
      inventory_sku: {
        include: {
          model_option: true,
          storage_option: true,
          color_option: true,
          sale_grade_option: true,
        },
      },
    },
  });

  if (!device) {
    throw publicNotFound(
      "INVENTORY_NOT_FOUND",
      `PG를 찾을 수 없습니다: ${pgNo}`
    );
  }

  if (
    !device.model.trim() ||
    !device.storage?.trim() ||
    !device.color?.trim() ||
    !device.sale_grade?.trim()
  ) {
    if (options.required) {
      throw publicConflict(
        "INVENTORY_SKU_INCOMPLETE",
        `PG ${pgNo}의 SKU 확정 정보가 부족합니다.`
      );
    }

    return null;
  }

  const linkedSku = device.inventory_sku;
  const changedCriteria = options.changedCriteria ?? {};
  const modelIdentityChanged = Boolean(
    changedCriteria.modelOptionKey ||
      (!device.model_code?.trim() && changedCriteria.modelLabel)
  );
  const mustResolve = Boolean(
    modelIdentityChanged ||
      changedCriteria.storage ||
      changedCriteria.color ||
      changedCriteria.saleGrade
  );

  if (linkedSku && !mustResolve) {
    if (linkedSku.is_active !== 1 && !device.inventory) {
      throw publicConflict(
        "INVENTORY_SKU_INACTIVE",
        `비활성화된 재고 SKU에는 새 재고를 연결할 수 없습니다: ${linkedSku.sku_code}`
      );
    }

    return linkedSku;
  }

  const sku = await resolveOrCreateInventorySku(
    tx,
    {
      modelOptionId:
        linkedSku && !modelIdentityChanged
          ? linkedSku.model_option_id
          : undefined,
      modelOptionKey: modelIdentityChanged || !linkedSku
        ? device.model_code || undefined
        : undefined,
      model: device.model,
      storageOptionId:
        linkedSku && !changedCriteria.storage
          ? linkedSku.storage_option_id
          : undefined,
      storage: device.storage,
      colorOptionId:
        linkedSku && !changedCriteria.color
          ? linkedSku.color_option_id
          : undefined,
      color: device.color,
      saleGradeOptionId:
        linkedSku && !changedCriteria.saleGrade
          ? linkedSku.sale_grade_option_id
          : undefined,
      saleGrade: device.sale_grade,
    },
    { actorUserId: options.actorUserId }
  );

  if (device.inventory_sku_id !== sku.inventory_sku_id) {
    await tx.devices.update({
      where: { pg_no: pgNo },
      data: {
        inventory_sku_id: sku.inventory_sku_id,
        updated_at: databaseNow(),
      },
    });
  }

  return sku;
}
