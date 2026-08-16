// QuickHack note: 검수와 판매 상품 조합 생성에 필요한 상품 기준값을 DB 옵션과 기본값에서 조립합니다.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  CAMERA_CHECK_MAP,
  CSC_MAP,
  MODEL_MAP,
} from "@/quickhack_client/adb/adb-config";
import {
  APPEARANCE_DEFECT_MAP,
  FUNCTION_DEFECT_MAP,
  GRADE_OPTIONS,
} from "@/quickhack_shared/inspection/inspection-schema";
import {
  PRODUCT_CRITERIA_CATEGORIES,
  PRODUCT_CRITERIA_CATEGORY_LABELS,
  canUseProductCriteriaParentKey,
  isProductCriteriaCategory,
  type ProductCriteriaCategory,
  type ProductCameraCheckRuleDto,
  type ProductCriteriaOptionLinkDto,
  type ProductCriteriaOptionDto,
  type ProductCriteriaPayload,
} from "@/quickhack_shared/catalog/product-criteria";
import {
  activityLogChangeData,
  explicitActivityLogChangeData,
  type ExplicitActivityLogChange,
} from "@/quickhack_server/audit/structured-log-values";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import {
  databaseNow,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

type ProductCriteriaClient = PrismaClient | Prisma.TransactionClient;

type ProductCriteriaRow = {
  revision: number;
  relation_revision: number;
  option_id: number;
  category: string;
  option_key: string;
  label: string;
  parent_key: string;
  sort_order: number;
  is_active: number;
  updated_by_user_id: number | null;
  created_at: Date;
  updated_at: Date;
};

type ProductCriteriaOptionLinkRow = {
  link_id: number;
  relation_type: string;
  parent_option_id: number;
  child_option_id: number;
  sort_order: number;
  is_active: number;
  updated_by_user_id: number | null;
  created_at: Date;
  updated_at: Date;
  parent_option: ProductCriteriaRow;
  child_option: ProductCriteriaRow;
};

type ProductCameraCheckRuleRow = {
  rule_id: number;
  model_option_id: number;
  camera_lens_option_id: number | null;
  focus_rule_option_id: number | null;
  camera_name: string;
  focus_rule: string;
  sort_order: number;
  is_active: number;
  updated_by_user_id: number | null;
  created_at: Date;
  updated_at: Date;
  model_option: ProductCriteriaRow;
  camera_lens_option?: ProductCriteriaRow | null;
  focus_rule_option?: ProductCriteriaRow | null;
};

type DefaultOption = {
  category: ProductCriteriaCategory;
  optionKey: string;
  label: string;
  parentKey?: string;
  sortOrder: number;
};

type UpsertProductCriteriaInput = Record<string, unknown>;
type SaveProductCriteriaRelationsInput = Record<string, unknown>;

const MODEL_COLOR_RELATION_TYPE = "MODEL_COLOR";
const MODEL_STORAGE_RELATION_TYPE = "MODEL_STORAGE";

// QuickHack object: 개발용 이스터에그 기종처럼 운영 드롭다운에서 숨길 제품명을 정의합니다.
const HIDDEN_PRODUCT_NAMES = new Set(["★ 만든놈폰"]);
const STORAGE_OPTIONS = ["32GB", "64GB", "128GB", "256GB", "512GB", "1TB", "2TB"];
const COLOR_OPTIONS: string[] = [];
const SALE_GRADE_OPTIONS = ["A", "A-", "B+", "B"];
const WARRANTY_GROUP_OPTIONS = [
  { optionKey: "2Y", label: "2년 보증" },
  { optionKey: "1Y", label: "1년 보증" },
];

function cameraCriteriaDefaults() {
  const lensOptions: DefaultOption[] = [];
  const focusOptions: DefaultOption[] = [];
  const lensSeen = new Set<string>();
  const focusSeen = new Set<string>();

  for (const rules of Object.values(CAMERA_CHECK_MAP)) {
    for (const rule of rules) {
      const lens = rule.name.trim();
      const focus = rule.focus.trim();

      if (lens && !lensSeen.has(lens)) {
        lensSeen.add(lens);
        lensOptions.push({
          category: "CAMERA_LENS",
          optionKey: lens,
          label: lens,
          sortOrder: lensOptions.length * 10 + 10,
        });
      }

      if (focus && !focusSeen.has(focus)) {
        focusSeen.add(focus);
        focusOptions.push({
          category: "CAMERA_FOCUS_RULE",
          optionKey: focus,
          label: focus,
          sortOrder: focusOptions.length * 10 + 10,
        });
      }
    }
  }

  return [...lensOptions, ...focusOptions];
}

function text(input: UpsertProductCriteriaInput, key: string) {
  const value = input[key];

  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function requiredText(
  input: UpsertProductCriteriaInput,
  key: string,
  label: string
) {
  const value = text(input, key);

  if (!value) {
    throw publicBadRequest(
      "PRODUCT_CRITERIA_VALUE_REQUIRED",
      `${label} 값이 필요합니다.`
    );
  }

  return value;
}

function intValue(
  input: UpsertProductCriteriaInput,
  key: string,
  fallback: number
) {
  const value = text(input, key);

  if (!value) {
    return fallback;
  }

  if (!/^-?\d+$/.test(value)) {
    throw publicBadRequest(
      "INVALID_PRODUCT_CRITERIA_SORT_ORDER",
      "정렬 순서는 숫자로 입력해야 합니다."
    );
  }

  return Number.parseInt(value, 10);
}

function boolValue(input: UpsertProductCriteriaInput, key: string) {
  const value = input[key];

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = text(input, key).toUpperCase();

  if (["0", "N", "NO", "FALSE", "INACTIVE"].includes(normalized)) {
    return false;
  }

  return true;
}

function defaultOptions() {
  const options: DefaultOption[] = [];

  Object.entries(MODEL_MAP).forEach(([modelCode, product], index) => {
    options.push({
      category: "PRODUCT_MODEL",
      optionKey: modelCode,
      label: product,
      sortOrder: (index + 1) * 10,
    });
  });

  Array.from(new Set(Object.values(CSC_MAP))).forEach((carrier, index) => {
    options.push({
      category: "CARRIER",
      optionKey: carrier,
      label: carrier,
      sortOrder: (index + 1) * 10,
    });
  });

  STORAGE_OPTIONS.forEach((storage, index) => {
    options.push({
      category: "STORAGE",
      optionKey: storage,
      label: storage,
      sortOrder: (index + 1) * 10,
    });
  });

  COLOR_OPTIONS.forEach((color, index) => {
    options.push({
      category: "DEVICE_COLOR",
      optionKey: color,
      label: color,
      sortOrder: (index + 1) * 10,
    });
  });

  GRADE_OPTIONS.forEach((grade, index) => {
    options.push({
      category: "APPEARANCE_GRADE",
      optionKey: grade,
      label: grade,
      sortOrder: (index + 1) * 10,
    });
  });

  SALE_GRADE_OPTIONS.forEach((grade, index) => {
    options.push({
      category: "SALE_GRADE",
      optionKey: grade,
      label: grade,
      sortOrder: (index + 1) * 10,
    });
  });

  WARRANTY_GROUP_OPTIONS.forEach((warranty, index) => {
    options.push({
      category: "WARRANTY_GROUP",
      optionKey: warranty.optionKey,
      label: warranty.label,
      sortOrder: (index + 1) * 10,
    });
  });

  Object.entries(APPEARANCE_DEFECT_MAP).forEach(([part, states], partIndex) => {
    states.forEach((state, stateIndex) => {
      options.push({
        category: "APPEARANCE_DEFECT",
        parentKey: part,
        optionKey: state,
        label: state,
        sortOrder: (partIndex + 1) * 100 + stateIndex + 1,
      });
    });
  });

  Object.entries(FUNCTION_DEFECT_MAP).forEach(([part, states], partIndex) => {
    states.forEach((state, stateIndex) => {
      options.push({
        category: "FUNCTION_DEFECT",
        parentKey: part,
        optionKey: state,
        label: state,
        sortOrder: (partIndex + 1) * 100 + stateIndex + 1,
      });
    });
  });

  options.push(...cameraCriteriaDefaults());

  return options;
}

function rowKey(category: string, optionKey: string, parentKey: string) {
  return `${category}\u0000${parentKey}\u0000${optionKey}`;
}

function toDto(row: ProductCriteriaRow): ProductCriteriaOptionDto {
  return {
    optionId: row.option_id,
    revision: row.revision,
    relationRevision: row.relation_revision,
    category: isProductCriteriaCategory(row.category)
      ? row.category
      : "PRODUCT_MODEL",
    optionKey: row.option_key,
    label: row.label,
    parentKey: row.parent_key,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
    updatedByUserId: row.updated_by_user_id,
    createdAt: requiredApiDateTime(row.created_at),
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

function toLinkDto(row: ProductCriteriaOptionLinkRow): ProductCriteriaOptionLinkDto {
  return {
    linkId: row.link_id,
    relationType: row.relation_type,
    parentOptionId: row.parent_option_id,
    parentCategory: isProductCriteriaCategory(row.parent_option.category)
      ? row.parent_option.category
      : "PRODUCT_MODEL",
    parentKey: row.parent_option.option_key,
    parentLabel: row.parent_option.label,
    childOptionId: row.child_option_id,
    childCategory: isProductCriteriaCategory(row.child_option.category)
      ? row.child_option.category
      : "DEVICE_COLOR",
    childKey: row.child_option.option_key,
    childLabel: row.child_option.label,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
    updatedByUserId: row.updated_by_user_id,
    createdAt: requiredApiDateTime(row.created_at),
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

function toCameraRuleDto(
  row: ProductCameraCheckRuleRow
): ProductCameraCheckRuleDto {
  return {
    ruleId: row.rule_id,
    modelOptionId: row.model_option_id,
    cameraLensOptionId: row.camera_lens_option_id,
    focusRuleOptionId: row.focus_rule_option_id,
    modelLabel: row.model_option.label,
    cameraName: row.camera_lens_option?.label ?? row.camera_name,
    focusRule: row.focus_rule_option?.label ?? row.focus_rule,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
    updatedByUserId: row.updated_by_user_id,
    createdAt: requiredApiDateTime(row.created_at),
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

function scalarAuditValue(value: string | number | boolean | null | undefined) {
  return value === null || value === undefined ? null : String(value);
}

export function productCriteriaRelationAuditChanges(
  beforeLinks: ProductCriteriaOptionLinkRow[],
  afterLinks: ProductCriteriaOptionLinkRow[],
  beforeCameraRules: ProductCameraCheckRuleRow[],
  afterCameraRules: ProductCameraCheckRuleRow[]
) {
  const changes: ExplicitActivityLogChange[] = [];
  const appendDiff = (
    fieldName: string,
    beforeValue: string | number | boolean | null | undefined,
    afterValue: string | number | boolean | null | undefined
  ) => {
    const before = scalarAuditValue(beforeValue);
    const after = scalarAuditValue(afterValue);
    if (before !== after) {
      changes.push({ fieldName, beforeValue: before, afterValue: after });
    }
  };
  const beforeLinkByKey = new Map(
    beforeLinks.map((row) => [`${row.relation_type}.${row.child_option_id}`, row])
  );
  const afterLinkByKey = new Map(
    afterLinks.map((row) => [`${row.relation_type}.${row.child_option_id}`, row])
  );

  for (const key of [...new Set([...beforeLinkByKey.keys(), ...afterLinkByKey.keys()])].sort()) {
    const before = beforeLinkByKey.get(key);
    const after = afterLinkByKey.get(key);
    appendDiff(`relations.${key}.active`, before?.is_active === 1, after?.is_active === 1);
    appendDiff(`relations.${key}.sortOrder`, before?.sort_order, after?.sort_order);
  }

  const cameraKey = (row: ProductCameraCheckRuleRow) =>
    String(row.camera_lens_option_id ?? `legacy-${row.rule_id}`);
  const beforeCameraByKey = new Map(beforeCameraRules.map((row) => [cameraKey(row), row]));
  const afterCameraByKey = new Map(afterCameraRules.map((row) => [cameraKey(row), row]));

  for (const key of [...new Set([...beforeCameraByKey.keys(), ...afterCameraByKey.keys()])].sort()) {
    const before = beforeCameraByKey.get(key);
    const after = afterCameraByKey.get(key);
    appendDiff(`cameraRules.${key}.active`, before?.is_active === 1, after?.is_active === 1);
    appendDiff(
      `cameraRules.${key}.focusRuleOptionId`,
      before?.focus_rule_option_id,
      after?.focus_rule_option_id
    );
    appendDiff(`cameraRules.${key}.sortOrder`, before?.sort_order, after?.sort_order);
  }

  return changes;
}

function formatCameraCheckRules(rules: ProductCameraCheckRuleRow[]) {
  const items = rules
    .filter((rule) => rule.is_active === 1)
    .sort((a, b) => a.sort_order - b.sort_order || a.rule_id - b.rule_id)
    .map((rule) => {
      const cameraName = rule.camera_lens_option?.label ?? rule.camera_name;
      const focusRule = rule.focus_rule_option?.label ?? rule.focus_rule;

      return `${cameraName}[${focusRule}]`;
    });

  return items.length > 0 ? items.join(" / ") : "-";
}

function pushSimpleOption(
  target: string[],
  seen: Set<string>,
  row: ProductCriteriaRow
) {
  const value = row.label.trim();

  if (!value || seen.has(value)) {
    return;
  }

  seen.add(value);
  target.push(value);
}

function pushDefectOption(
  target: Record<string, string[]>,
  seen: Map<string, Set<string>>,
  row: ProductCriteriaRow
) {
  const part = row.parent_key.trim();
  const label = row.label.trim();

  if (!part || !label) {
    return;
  }

  const currentSeen = seen.get(part) ?? new Set<string>();

  if (currentSeen.has(label)) {
    return;
  }

  currentSeen.add(label);
  seen.set(part, currentSeen);
  target[part] = [...(target[part] ?? []), label];
}

// QuickHack object: DB가 비어 있을 때 기본 검수/상품 기준값을 초기 등록합니다.
export async function ensureDefaultProductCriteriaOptions(
  client: ProductCriteriaClient
) {
  const defaults = defaultOptions();
  const existingRows = await client.product_criteria_options.findMany({
    select: {
      category: true,
      option_key: true,
      parent_key: true,
    },
  });
  const existingKeys = new Set(
    existingRows.map((row) =>
      rowKey(row.category, row.option_key, row.parent_key)
    )
  );
  const timestamp = databaseNow();

  for (const option of defaults) {
    const parentKey = option.parentKey ?? "";

    if (existingKeys.has(rowKey(option.category, option.optionKey, parentKey))) {
      continue;
    }

    await client.product_criteria_options.create({
      data: {
        category: option.category,
        option_key: option.optionKey,
        label: option.label,
        parent_key: parentKey,
        sort_order: option.sortOrder,
        is_active: 1,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  }
}

export async function ensureDefaultProductCameraCheckRules(
  client: ProductCriteriaClient
) {
  await ensureDefaultProductCriteriaOptions(client);

  const criteriaRows = await client.product_criteria_options.findMany({
    where: {
      category: {
        in: ["PRODUCT_MODEL", "CAMERA_LENS", "CAMERA_FOCUS_RULE"],
      },
    },
  });
  const modelRows = criteriaRows.filter((row) => row.category === "PRODUCT_MODEL");
  const lensRowsByLabel = new Map(
    criteriaRows
      .filter((row) => row.category === "CAMERA_LENS")
      .map((row) => [row.label.trim(), row])
  );
  const focusRowsByLabel = new Map(
    criteriaRows
      .filter((row) => row.category === "CAMERA_FOCUS_RULE")
      .map((row) => [row.label.trim(), row])
  );
  const existingRules = await client.product_camera_check_rules.findMany({
    select: {
      rule_id: true,
      model_option_id: true,
      camera_lens_option_id: true,
      focus_rule_option_id: true,
      camera_name: true,
      focus_rule: true,
    },
  });
  const existingKeys = new Set(
    existingRules.map(
      (rule) =>
        `${rule.model_option_id}\u0000${rule.camera_lens_option_id ?? rule.camera_name}`
    )
  );
  const timestamp = databaseNow();

  for (const rule of existingRules) {
    const cameraLens = lensRowsByLabel.get(rule.camera_name.trim());
    const focusRule = focusRowsByLabel.get(rule.focus_rule.trim());

    if (!cameraLens && !focusRule) {
      continue;
    }

    if (
      rule.camera_lens_option_id === cameraLens?.option_id &&
      rule.focus_rule_option_id === focusRule?.option_id
    ) {
      continue;
    }

    await client.product_camera_check_rules.update({
      where: { rule_id: rule.rule_id },
      data: {
        camera_lens_option_id: cameraLens?.option_id ?? rule.camera_lens_option_id,
        focus_rule_option_id: focusRule?.option_id ?? rule.focus_rule_option_id,
        updated_at: timestamp,
      },
    });
  }

  for (const row of modelRows) {
    const modelCode = row.option_key.trim();
    const rules = CAMERA_CHECK_MAP[modelCode] ?? [];

    for (const [index, rule] of rules.entries()) {
      const cameraName = rule.name.trim();
      const focusRule = rule.focus.trim();
      const cameraLens = lensRowsByLabel.get(cameraName);
      const focusRuleOption = focusRowsByLabel.get(focusRule);

      if (!cameraName || !focusRule || !cameraLens || !focusRuleOption) {
        continue;
      }

      const key = `${row.option_id}\u0000${cameraLens.option_id}`;

      if (existingKeys.has(key)) {
        continue;
      }

      await client.product_camera_check_rules.create({
        data: {
          model_option_id: row.option_id,
          camera_lens_option_id: cameraLens.option_id,
          focus_rule_option_id: focusRuleOption.option_id,
          camera_name: cameraName,
          focus_rule: focusRule,
          sort_order: (index + 1) * 10,
          is_active: 1,
          created_at: timestamp,
          updated_at: timestamp,
        },
      });
      existingKeys.add(key);
    }
  }
}

export async function ensureDefaultProductCriteriaOptionLinks(
  client: ProductCriteriaClient
) {
  const rows = await client.product_criteria_options.findMany({
    where: {
      category: {
        in: ["PRODUCT_MODEL", "DEVICE_COLOR", "STORAGE"],
      },
    },
  });
  const modelRowsByLabel = new Map<string, ProductCriteriaRow[]>();
  const storageRowsByLabel = new Map<string, ProductCriteriaRow[]>();

  for (const row of rows) {
    if (row.category === "PRODUCT_MODEL") {
      const label = row.label.trim();

      if (!label) {
        continue;
      }

      modelRowsByLabel.set(label, [...(modelRowsByLabel.get(label) ?? []), row]);
    }

    if (row.category === "STORAGE" && !row.parent_key.trim()) {
      const label = row.label.trim();

      if (!label) {
        continue;
      }

      storageRowsByLabel.set(label, [
        ...(storageRowsByLabel.get(label) ?? []),
        row,
      ]);
    }
  }

  const existingLinks = await client.product_criteria_option_links.findMany({
    where: {
      relation_type: {
        in: [MODEL_COLOR_RELATION_TYPE, MODEL_STORAGE_RELATION_TYPE],
      },
    },
    select: {
      relation_type: true,
      parent_option_id: true,
      child_option_id: true,
    },
  });
  const existingKeys = new Set(
    existingLinks.map(
      (link) =>
        `${link.relation_type}\u0000${link.parent_option_id}\u0000${link.child_option_id}`
    )
  );
  const timestamp = databaseNow();

  for (const row of rows) {
    if (row.category !== "STORAGE") {
      continue;
    }

    const modelName = row.parent_key.trim();
    const storageLabel = row.label.trim();

    if (!modelName || !storageLabel) {
      continue;
    }

    const modelRows = modelRowsByLabel.get(modelName) ?? [];
    const storageRows = storageRowsByLabel.get(storageLabel) ?? [];

    for (const modelRow of modelRows) {
      for (const storageRow of storageRows) {
        const key = `${MODEL_STORAGE_RELATION_TYPE}\u0000${modelRow.option_id}\u0000${storageRow.option_id}`;

        if (existingKeys.has(key)) {
          continue;
        }

        await client.product_criteria_option_links.create({
          data: {
            relation_type: MODEL_STORAGE_RELATION_TYPE,
            parent_option_id: modelRow.option_id,
            child_option_id: storageRow.option_id,
            sort_order: row.sort_order,
            is_active: 1,
            created_at: timestamp,
            updated_at: timestamp,
          },
        });
        existingKeys.add(key);
      }
    }
  }
}

export async function listProductCriteriaOptions(
  client: PrismaClient,
  includeInactive = false
) {
  await ensureDefaultProductCriteriaOptions(client);
  await ensureDefaultProductCriteriaOptionLinks(client);
  await ensureDefaultProductCameraCheckRules(client);

  return client.product_criteria_options.findMany({
    where: includeInactive ? undefined : { is_active: 1 },
    orderBy: [
      { category: "asc" },
      { parent_key: "asc" },
      { sort_order: "asc" },
      { label: "asc" },
      { option_id: "asc" },
    ],
  });
}

export async function listProductCameraCheckRules(
  client: PrismaClient,
  includeInactive = false
) {
  await ensureDefaultProductCriteriaOptions(client);
  await ensureDefaultProductCameraCheckRules(client);

  return client.product_camera_check_rules.findMany({
    where: includeInactive ? undefined : { is_active: 1 },
    include: {
      model_option: true,
      camera_lens_option: true,
      focus_rule_option: true,
    },
    orderBy: [
      { model_option_id: "asc" },
      { sort_order: "asc" },
      { rule_id: "asc" },
    ],
  });
}

// QuickHack object: DB option row를 검수 UI가 쓰기 쉬운 카테고리별 payload로 조립합니다.
export async function listProductCriteriaOptionLinks(
  client: PrismaClient,
  includeInactive = false
) {
  await ensureDefaultProductCriteriaOptions(client);
  await ensureDefaultProductCriteriaOptionLinks(client);

  return client.product_criteria_option_links.findMany({
    where: includeInactive ? undefined : { is_active: 1 },
    include: {
      parent_option: true,
      child_option: true,
    },
    orderBy: [
      { relation_type: "asc" },
      { sort_order: "asc" },
      { link_id: "asc" },
    ],
  });
}

export function buildProductCriteriaPayload(
  rows: ProductCriteriaRow[],
  links: ProductCriteriaOptionLinkRow[] = [],
  cameraRules: ProductCameraCheckRuleRow[] = [],
  includeInactive = false
): ProductCriteriaPayload {
  const activeRows = rows.filter(
    (row) =>
      row.is_active === 1 &&
      isProductCriteriaCategory(row.category) &&
      (PRODUCT_CRITERIA_CATEGORIES as readonly string[]).includes(row.category)
  );
  const productValues = new Set<string>();
  const productsByLabel = new Map<
    string,
    { value: string; searchText: string; hidden: boolean }
  >();
  const cameraCheckByProduct: Record<string, string> = {};
  const carriers: string[] = [];
  const carrierSeen = new Set<string>();
  const storages: string[] = [];
  const storageSeen = new Set<string>();
  const storagesByProduct: Record<string, string[]> = {};
  const scopedStorageSeen = new Map<string, Set<string>>();
  const colors: string[] = [];
  const colorSeen = new Set<string>();
  const colorModelsByColor: Record<string, string[]> = {};
  const colorModelSeen = new Map<string, Set<string>>();
  const grades: string[] = [];
  const gradeSeen = new Set<string>();
  const appearanceDefectMap: Record<string, string[]> = {};
  const appearanceDefectSeen = new Map<string, Set<string>>();
  const functionDefectMap: Record<string, string[]> = {};
  const functionDefectSeen = new Map<string, Set<string>>();

  for (const row of activeRows) {
    switch (row.category) {
      case "PRODUCT_MODEL": {
        const label = row.label.trim();

        if (!label) {
          break;
        }

        const hidden = HIDDEN_PRODUCT_NAMES.has(label);
        const current = productsByLabel.get(label);
        const modelCode = row.option_key.trim();

        productValues.add(label);

        if (!current) {
          productsByLabel.set(label, {
            value: label,
            searchText: `${label} ${modelCode}`.toLowerCase(),
            hidden,
          });
        } else {
          current.searchText = `${current.searchText} ${modelCode.toLowerCase()}`;
          current.hidden = current.hidden && hidden;
        }

        break;
      }
      case "CARRIER":
        pushSimpleOption(carriers, carrierSeen, row);
        break;
      case "STORAGE":
        if (!row.parent_key.trim()) {
          pushSimpleOption(storages, storageSeen, row);
        }
        break;
      case "DEVICE_COLOR":
        pushSimpleOption(colors, colorSeen, row);
        break;
      case "APPEARANCE_GRADE":
        pushSimpleOption(grades, gradeSeen, row);
        break;
      case "APPEARANCE_DEFECT":
        pushDefectOption(appearanceDefectMap, appearanceDefectSeen, row);
        break;
      case "FUNCTION_DEFECT":
        pushDefectOption(functionDefectMap, functionDefectSeen, row);
        break;
    }
  }

  for (const link of links) {
    const parent = link.parent_option;
    const child = link.child_option;

    if (parent.category !== "PRODUCT_MODEL") {
      continue;
    }

    if (link.relation_type === MODEL_COLOR_RELATION_TYPE) {
      if (child.category !== "DEVICE_COLOR") {
        continue;
      }

      if (!includeInactive && (link.is_active !== 1 || child.is_active !== 1)) {
        continue;
      }

      const model = parent.label.trim();
      const color = child.label.trim();

      if (!model || !color) {
        continue;
      }

      const currentSeen = colorModelSeen.get(color) ?? new Set<string>();

      if (currentSeen.has(model)) {
        continue;
      }

      currentSeen.add(model);
      colorModelSeen.set(color, currentSeen);
      colorModelsByColor[color] = [...(colorModelsByColor[color] ?? []), model];
      continue;
    }

    if (link.relation_type === MODEL_STORAGE_RELATION_TYPE) {
      if (child.category !== "STORAGE") {
        continue;
      }

      if (
        !includeInactive &&
        (link.is_active !== 1 ||
          parent.is_active !== 1 ||
          child.is_active !== 1)
      ) {
        continue;
      }

      const model = parent.label.trim();
      const storage = child.label.trim();

      if (!model || !storage) {
        continue;
      }

      const currentSeen = scopedStorageSeen.get(model) ?? new Set<string>();

      if (currentSeen.has(storage)) {
        continue;
      }

      currentSeen.add(storage);
      scopedStorageSeen.set(model, currentSeen);
      storagesByProduct[model] = [...(storagesByProduct[model] ?? []), storage];
    }
  }

  for (const [color, models] of Object.entries(colorModelsByColor)) {
    colorModelsByColor[color] = models.sort((a, b) =>
      a.localeCompare(b, "ko")
    );
  }

  for (const [product, storageValues] of Object.entries(storagesByProduct)) {
    storagesByProduct[product] = storageValues.sort((a, b) =>
      a.localeCompare(b, "ko", { numeric: true })
    );
  }

  const cameraRulesByProduct = new Map<string, ProductCameraCheckRuleRow[]>();

  for (const rule of cameraRules) {
    if (
      !includeInactive &&
      (rule.is_active !== 1 || rule.model_option.is_active !== 1)
    ) {
      continue;
    }

    const product = rule.model_option.label.trim();

    if (!product) {
      continue;
    }

    cameraRulesByProduct.set(product, [
      ...(cameraRulesByProduct.get(product) ?? []),
      rule,
    ]);
  }

  for (const [product, rules] of cameraRulesByProduct.entries()) {
    cameraCheckByProduct[product] = formatCameraCheckRules(rules);
  }

  return {
    modelOptions: activeRows
      .filter((row) => row.category === "PRODUCT_MODEL")
      .map(toDto),
    products: Array.from(productsByLabel.values())
      .filter((option) => !option.hidden)
      .sort((a, b) => a.value.localeCompare(b.value, "ko"))
      .map(({ value, searchText }) => ({ value, searchText })),
    productValues: Array.from(productValues),
    carriers,
    storages,
    storagesByProduct,
    colors,
    colorModelsByColor,
    grades,
    appearanceDefectMap,
    functionDefectMap,
    cameraCheckByProduct,
    rawOptions: (includeInactive ? rows : activeRows).map(toDto),
    rawLinks: links
      .filter((link) => includeInactive || link.is_active === 1)
      .map(toLinkDto),
    rawCameraRules: cameraRules
      .filter((rule) => includeInactive || rule.is_active === 1)
      .map(toCameraRuleDto),
  };
}

// QuickHack object: 상품 기준값 전체를 기본값 보정 후 UI에 반환합니다.
export async function getProductCriteriaPayload(
  client: PrismaClient,
  includeInactive = false
) {
  const rows = await listProductCriteriaOptions(client, includeInactive);
  const links = await listProductCriteriaOptionLinks(client, includeInactive);
  const cameraRules = await listProductCameraCheckRules(client, includeInactive);
  return buildProductCriteriaPayload(rows, links, cameraRules, includeInactive);
}

// QuickHack object: 상품 기준값 관리 화면에서 옵션 하나를 생성하거나 수정합니다.
export async function upsertProductCriteriaOption(
  client: PrismaClient,
  input: UpsertProductCriteriaInput,
  user: AuthUser
) {
  const optionIdText = text(input, "optionId");
  const optionId = optionIdText ? Number.parseInt(optionIdText, 10) : null;

  if (
    optionIdText &&
    (!Number.isInteger(optionId) || Number(optionId) <= 0)
  ) {
    throw publicBadRequest(
      "PRODUCT_CRITERIA_OPTION_ID_INVALID",
      "수정할 상품 기준값 ID가 올바르지 않습니다."
    );
  }

  const expectedRevisionText = text(input, "expectedRevision");
  const expectedRevision = expectedRevisionText
    ? Number.parseInt(expectedRevisionText, 10)
    : null;

  if (
    optionId !== null &&
    (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0)
  ) {
    throw publicBadRequest(
      "PRODUCT_CRITERIA_REVISION_REQUIRED",
      "상품 기준값을 수정하려면 현재 revision이 필요합니다."
    );
  }

  const category = requiredText(input, "category", "분류");

  if (!isProductCriteriaCategory(category)) {
    throw publicBadRequest(
      "INVALID_PRODUCT_CRITERIA_CATEGORY",
      "알 수 없는 기준값 분류입니다."
    );
  }

  const optionKey = requiredText(input, "optionKey", "기준키");
  const label = requiredText(input, "label", "표시값");
  const rawParentKey = text(input, "parentKey");
  const parentKey = canUseProductCriteriaParentKey(category) ? rawParentKey : "";

  if (rawParentKey && !canUseProductCriteriaParentKey(category)) {
    throw publicBadRequest(
      "PRODUCT_CRITERIA_PARENT_NOT_ALLOWED",
      `${PRODUCT_CRITERIA_CATEGORY_LABELS[category]} 분류에는 상위값을 입력할 수 없습니다.`
    );
  }
  const sortOrder = intValue(input, "sortOrder", 0);
  const isActive = boolValue(input, "isActive");
  const timestamp = databaseNow();

  return client.$transaction(async (tx) => {
    let before = null;

    if (optionId !== null) {
      await tx.$queryRaw`
        SELECT option_id
        FROM product_criteria_options
        WHERE option_id = ${optionId}
        FOR UPDATE
      `;
      before = await tx.product_criteria_options.findUnique({
        where: { option_id: optionId },
      });

      if (!before) {
        throw publicNotFound(
          "PRODUCT_CRITERIA_OPTION_NOT_FOUND",
          "수정할 상품 기준값을 찾을 수 없습니다."
        );
      }

      if (before.revision !== expectedRevision) {
        throw publicConflict(
          "PRODUCT_CRITERIA_OPTION_CONFLICT",
          "상품 기준값이 다른 작업에서 변경되었습니다. 목록을 새로 고친 뒤 다시 시도해 주세요.",
          { currentRevision: before.revision }
        );
      }

      if (
        before.category !== category ||
        before.option_key !== optionKey ||
        before.parent_key !== parentKey
      ) {
        throw publicConflict(
          "PRODUCT_CRITERIA_IDENTITY_IMMUTABLE",
          "분류, 기준 키, 상위 키는 생성 후 변경할 수 없습니다. 새 기준값으로 등록해 주세요."
        );
      }
    } else {
      const identityKey = [
        "PRODUCT_CRITERIA_OPTION",
        category,
        optionKey,
        parentKey,
      ].join(":");
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${identityKey}, 0))
      `;
      const duplicate = await tx.product_criteria_options.findUnique({
        where: {
          category_option_key_parent_key: {
            category,
            option_key: optionKey,
            parent_key: parentKey,
          },
        },
      });

      if (duplicate) {
        throw publicConflict(
          "PRODUCT_CRITERIA_IDENTITY_EXISTS",
          "같은 분류, 기준 키, 상위 키를 가진 상품 기준값이 이미 존재합니다."
        );
      }
    }

    const mutableData = {
      label,
      sort_order: sortOrder,
      is_active: isActive ? 1 : 0,
      updated_by_user_id: user.userId,
      updated_at: timestamp,
    };
    const unchanged =
      before &&
      before.label === mutableData.label &&
      before.sort_order === mutableData.sort_order &&
      before.is_active === mutableData.is_active;

    if (before && unchanged) {
      return toDto(before);
    }

    const option = before
      ? await tx.product_criteria_options.update({
          where: { option_id: before.option_id },
          data: {
            ...mutableData,
            revision: { increment: 1 },
          },
        })
      : await tx.product_criteria_options.create({
          data: {
            category,
            option_key: optionKey,
            parent_key: parentKey,
            ...mutableData,
            created_at: timestamp,
          },
        });

    await tx.employee_activity_logs.create({
      data: {
        user_id: user.userId,
        action_type: "PRODUCT_CRITERIA_UPSERT",
        target_type: "PRODUCT_CRITERIA_OPTION",
        target_id: String(option.option_id),
        ...activityLogChangeData(before ? toDto(before) : null, toDto(option)),
        result: "SUCCESS",
        created_at: timestamp,
      },
    });

    return toDto(option);
  });
}

function intArray(input: SaveProductCriteriaRelationsInput, key: string) {
  const value = input[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => Number.parseInt(String(item), 10))
        .filter((item) => Number.isInteger(item) && item > 0)
    )
  );
}

function cameraRuleInputs(input: SaveProductCriteriaRelationsInput) {
  const value = input.cameraRules;

  if (!Array.isArray(value)) {
    return [];
  }

  const parsedRules = value
    .map((item, index) => {
      const record =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {};
      const cameraLensOptionId = Number.parseInt(
        String(record.cameraLensOptionId ?? ""),
        10
      );
      const focusRuleOptionId = Number.parseInt(
        String(record.focusRuleOptionId ?? ""),
        10
      );
      const cameraName = String(record.cameraName ?? "").trim();
      const focusRule = String(record.focusRule ?? "").trim();

      return {
        cameraLensOptionId: Number.isInteger(cameraLensOptionId)
          ? cameraLensOptionId
          : null,
        focusRuleOptionId: Number.isInteger(focusRuleOptionId)
          ? focusRuleOptionId
          : null,
        cameraName,
        focusRule,
        sortOrder: index + 1,
      };
    })
    .filter(
      (item) =>
        (item.cameraLensOptionId && item.focusRuleOptionId) ||
        (item.cameraName && item.focusRule)
    );

  const seen = new Set<string>();
  const uniqueRules = parsedRules.filter((item) => {
    const key = item.cameraLensOptionId
      ? `option:${item.cameraLensOptionId}`
      : `text:${item.cameraName}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  return uniqueRules.map((item, index) => ({
    ...item,
    sortOrder: index + 1,
  }));
}

async function validateRelationChildren(
  tx: Prisma.TransactionClient,
  optionIds: number[],
  category: ProductCriteriaCategory,
  label: string
) {
  if (optionIds.length === 0) {
    return [];
  }

  const rows = await tx.product_criteria_options.findMany({
    where: {
      option_id: { in: optionIds },
      category,
      is_active: 1,
    },
  });

  if (rows.length !== optionIds.length) {
    throw publicBadRequest(
      "PRODUCT_CRITERIA_LINK_NOT_FOUND",
      `${label} 연결값 중 존재하지 않는 기준값이 있습니다.`
    );
  }

  return rows;
}

async function replaceOptionLinks(
  tx: Prisma.TransactionClient,
  relationType: string,
  modelOptionId: number,
  childOptionIds: number[],
  userId: number,
  timestamp: Date
) {
  const existingLinks = await tx.product_criteria_option_links.findMany({
    where: {
      relation_type: relationType,
      parent_option_id: modelOptionId,
    },
  });
  const existingByChildId = new Map(
    existingLinks.map((link) => [link.child_option_id, link])
  );

  await tx.product_criteria_option_links.updateMany({
    where: {
      relation_type: relationType,
      parent_option_id: modelOptionId,
    },
    data: {
      is_active: 0,
      updated_by_user_id: userId,
      updated_at: timestamp,
    },
  });

  for (const [index, childOptionId] of childOptionIds.entries()) {
    const existing = existingByChildId.get(childOptionId);
    const data = {
      sort_order: (index + 1) * 10,
      is_active: 1,
      updated_by_user_id: userId,
      updated_at: timestamp,
    };

    if (existing) {
      await tx.product_criteria_option_links.update({
        where: { link_id: existing.link_id },
        data,
      });
      continue;
    }

    await tx.product_criteria_option_links.create({
      data: {
        relation_type: relationType,
        parent_option_id: modelOptionId,
        child_option_id: childOptionId,
        ...data,
        created_at: timestamp,
      },
    });
  }
}

// QuickHack object: 기종 기준으로 연결된 저장공간, 공식 색상명, 카메라 점검 기준을 저장합니다.
export async function saveProductCriteriaRelations(
  client: PrismaClient,
  input: SaveProductCriteriaRelationsInput,
  user: AuthUser
) {
  const modelOptionId = Number.parseInt(String(input.modelOptionId ?? ""), 10);

  if (!Number.isInteger(modelOptionId) || modelOptionId <= 0) {
    throw publicBadRequest(
      "PRODUCT_MODEL_REQUIRED",
      "연결할 기종을 선택해야 합니다."
    );
  }

  const expectedRelationRevision = Number.parseInt(
    String(input.expectedRelationRevision ?? ""),
    10
  );

  if (
    !Number.isInteger(expectedRelationRevision) ||
    expectedRelationRevision < 0
  ) {
    throw publicBadRequest(
      "PRODUCT_CRITERIA_RELATION_REVISION_REQUIRED",
      "연결 기준값을 저장하려면 현재 relation revision이 필요합니다."
    );
  }

  const storageOptionIds = intArray(input, "storageOptionIds");
  const colorOptionIds = intArray(input, "colorOptionIds");
  const cameraRules = cameraRuleInputs(input);
  const timestamp = databaseNow();

  return client.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT option_id
      FROM product_criteria_options
      WHERE option_id = ${modelOptionId}
      FOR UPDATE
    `;
    const model = await tx.product_criteria_options.findFirst({
      where: {
        option_id: modelOptionId,
        category: "PRODUCT_MODEL",
      },
    });

    if (!model) {
      throw publicNotFound(
        "PRODUCT_MODEL_NOT_FOUND",
        "연결할 기종 기준값을 찾을 수 없습니다."
      );
    }

    if (model.is_active !== 1) {
      throw publicConflict(
        "PRODUCT_CRITERIA_RELATION_MODEL_INACTIVE",
        "비활성 모델에는 연결 기준값을 저장할 수 없습니다."
      );
    }

    if (model.relation_revision !== expectedRelationRevision) {
      throw publicConflict(
        "PRODUCT_CRITERIA_RELATION_CONFLICT",
        "상품 연결 기준값이 다른 작업에서 변경되었습니다. 목록을 새로 고친 뒤 다시 시도해 주세요.",
        { currentRelationRevision: model.relation_revision }
      );
    }

    await validateRelationChildren(tx, storageOptionIds, "STORAGE", "저장공간");
    await validateRelationChildren(tx, colorOptionIds, "DEVICE_COLOR", "색상");
    const cameraLensRows = await validateRelationChildren(
      tx,
      cameraRules
        .map((rule) => rule.cameraLensOptionId)
        .filter((optionId): optionId is number => Boolean(optionId)),
      "CAMERA_LENS",
      "카메라 렌즈 배율"
    );
    const focusRuleRows = await validateRelationChildren(
      tx,
      cameraRules
        .map((rule) => rule.focusRuleOptionId)
        .filter((optionId): optionId is number => Boolean(optionId)),
      "CAMERA_FOCUS_RULE",
      "카메라 초점 기준"
    );
    const cameraLensById = new Map(
      cameraLensRows.map((row) => [row.option_id, row])
    );
    const focusRuleById = new Map(
      focusRuleRows.map((row) => [row.option_id, row])
    );

    const beforeLinks = await tx.product_criteria_option_links.findMany({
      where: {
        parent_option_id: modelOptionId,
        relation_type: { in: [MODEL_STORAGE_RELATION_TYPE, MODEL_COLOR_RELATION_TYPE] },
      },
      include: {
        parent_option: true,
        child_option: true,
      },
    });
    const beforeCameraRules = await tx.product_camera_check_rules.findMany({
      where: { model_option_id: modelOptionId },
      include: {
        model_option: true,
        camera_lens_option: true,
        focus_rule_option: true,
      },
    });

    const currentStorageOptionIds = beforeLinks
      .filter(
        (link) =>
          link.relation_type === MODEL_STORAGE_RELATION_TYPE &&
          link.is_active === 1
      )
      .sort((left, right) => left.sort_order - right.sort_order || left.link_id - right.link_id)
      .map((link) => link.child_option_id);
    const currentColorOptionIds = beforeLinks
      .filter(
        (link) =>
          link.relation_type === MODEL_COLOR_RELATION_TYPE &&
          link.is_active === 1
      )
      .sort((left, right) => left.sort_order - right.sort_order || left.link_id - right.link_id)
      .map((link) => link.child_option_id);
    const currentCameraRules = beforeCameraRules
      .filter((rule) => rule.is_active === 1)
      .sort((left, right) => left.sort_order - right.sort_order || left.rule_id - right.rule_id)
      .map((rule) => ({
        cameraLensOptionId: rule.camera_lens_option_id,
        focusRuleOptionId: rule.focus_rule_option_id,
      }));
    const desiredCameraRules = cameraRules.map((rule) => ({
      cameraLensOptionId: rule.cameraLensOptionId,
      focusRuleOptionId: rule.focusRuleOptionId,
    }));
    const unchanged =
      JSON.stringify(currentStorageOptionIds) === JSON.stringify(storageOptionIds) &&
      JSON.stringify(currentColorOptionIds) === JSON.stringify(colorOptionIds) &&
      JSON.stringify(currentCameraRules) === JSON.stringify(desiredCameraRules);

    if (unchanged) {
      return toDto(model);
    }

    await replaceOptionLinks(
      tx,
      MODEL_STORAGE_RELATION_TYPE,
      modelOptionId,
      storageOptionIds,
      user.userId,
      timestamp
    );
    await replaceOptionLinks(
      tx,
      MODEL_COLOR_RELATION_TYPE,
      modelOptionId,
      colorOptionIds,
      user.userId,
      timestamp
    );

    const existingCameraRules = await tx.product_camera_check_rules.findMany({
      where: { model_option_id: modelOptionId },
    });
    const existingCameraByLensId = new Map(
      existingCameraRules
        .filter((rule) => rule.camera_lens_option_id)
        .map((rule) => [rule.camera_lens_option_id, rule])
    );

    await tx.product_camera_check_rules.updateMany({
      where: { model_option_id: modelOptionId },
      data: {
        is_active: 0,
        updated_by_user_id: user.userId,
        updated_at: timestamp,
      },
    });

    for (const rule of cameraRules) {
      if (!rule.cameraLensOptionId || !rule.focusRuleOptionId) {
        throw publicBadRequest(
          "CAMERA_CRITERIA_PAIR_REQUIRED",
          "카메라 렌즈 배율과 초점 기준을 모두 선택해야 합니다."
        );
      }

      const cameraLens = cameraLensById.get(rule.cameraLensOptionId);
      const focusRule = focusRuleById.get(rule.focusRuleOptionId);

      if (!cameraLens || !focusRule) {
        throw publicBadRequest(
          "CAMERA_CRITERIA_NOT_FOUND",
          "카메라 점검 기준 중 존재하지 않는 기준값이 있습니다."
        );
      }

      const existing = existingCameraByLensId.get(rule.cameraLensOptionId);
      const data = {
        camera_lens_option_id: cameraLens.option_id,
        focus_rule_option_id: focusRule.option_id,
        camera_name: cameraLens.label,
        focus_rule: focusRule.label,
        sort_order: rule.sortOrder * 10,
        is_active: 1,
        updated_by_user_id: user.userId,
        updated_at: timestamp,
      };

      if (existing) {
        await tx.product_camera_check_rules.update({
          where: { rule_id: existing.rule_id },
          data,
        });
        continue;
      }

      await tx.product_camera_check_rules.create({
        data: {
          model_option_id: modelOptionId,
          ...data,
          created_at: timestamp,
        },
      });
    }

    const afterLinks = await tx.product_criteria_option_links.findMany({
      where: {
        parent_option_id: modelOptionId,
        relation_type: { in: [MODEL_STORAGE_RELATION_TYPE, MODEL_COLOR_RELATION_TYPE] },
      },
      include: {
        parent_option: true,
        child_option: true,
      },
    });
    const afterCameraRules = await tx.product_camera_check_rules.findMany({
      where: { model_option_id: modelOptionId },
      include: {
        model_option: true,
        camera_lens_option: true,
        focus_rule_option: true,
      },
    });
    const updatedModel = await tx.product_criteria_options.update({
      where: { option_id: modelOptionId },
      data: {
        relation_revision: { increment: 1 },
        updated_by_user_id: user.userId,
        updated_at: timestamp,
      },
    });

    await tx.employee_activity_logs.create({
      data: {
        user_id: user.userId,
        action_type: "PRODUCT_CRITERIA_RELATIONS_UPDATE",
        target_type: "PRODUCT_CRITERIA_OPTION",
        target_id: String(modelOptionId),
        ...explicitActivityLogChangeData(
          productCriteriaRelationAuditChanges(
            beforeLinks,
            afterLinks,
            beforeCameraRules,
            afterCameraRules
          ),
          {
            beforeSummary: `links=${beforeLinks.filter((row) => row.is_active === 1).length} / cameraRules=${beforeCameraRules.filter((row) => row.is_active === 1).length}`,
            afterSummary: `links=${afterLinks.filter((row) => row.is_active === 1).length} / cameraRules=${afterCameraRules.filter((row) => row.is_active === 1).length}`,
          }
        ),
        result: "SUCCESS",
        created_at: timestamp,
      },
    });

    return toDto(updatedModel);
  });
}

