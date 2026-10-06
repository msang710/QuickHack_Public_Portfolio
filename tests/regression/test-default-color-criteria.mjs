import assert from "node:assert/strict";

import { MODEL_MAP } from "../../quickhack_client/adb/adb-config.ts";
import {
  INITIAL_COLOR_MODELS,
  INITIAL_COLOR_OPTIONS,
  INITIAL_MODEL_COLOR_LINKS,
} from "../../quickhack_server/catalog/default-color-criteria.ts";
import {
  ensureDefaultProductCriteriaOptionLinks,
  ensureDefaultProductCriteriaOptions,
} from "../../quickhack_server/catalog/product-criteria-service.ts";

function memoryClient() {
  const options = [];
  const links = [];

  return {
    options,
    links,
    product_criteria_options: {
      async findMany({ select, where } = {}) {
        const rows = options.filter(
          (row) => !where?.category?.in || where.category.in.includes(row.category)
        );
        return select
          ? rows.map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])))
          : rows;
      },
      async create({ data }) {
        assert(
          !options.some(
            (row) =>
              row.category === data.category &&
              row.option_key === data.option_key &&
              row.parent_key === data.parent_key
          ),
          `Duplicate option: ${data.category} / ${data.option_key}`
        );
        const row = { option_id: options.length + 1, ...data };
        options.push(row);
        return row;
      },
    },
    product_criteria_option_links: {
      async findMany({ where } = {}) {
        return links.filter(
          (link) => !where?.relation_type?.in || where.relation_type.in.includes(link.relation_type)
        );
      },
      async create({ data }) {
        assert(
          !links.some(
            (link) =>
              link.relation_type === data.relation_type &&
              link.parent_option_id === data.parent_option_id &&
              link.child_option_id === data.child_option_id
          ),
          "Duplicate relation"
        );
        const link = { link_id: links.length + 1, ...data };
        links.push(link);
        return link;
      },
    },
  };
}

assert.equal(INITIAL_COLOR_OPTIONS.length, 82);
assert.equal(INITIAL_COLOR_MODELS.length, 44);
assert.equal(INITIAL_MODEL_COLOR_LINKS.length, 225);
assert.equal(new Set(INITIAL_COLOR_OPTIONS.map((color) => color.optionKey)).size, 82);
assert.equal(new Set(INITIAL_COLOR_MODELS.map((model) => model.optionKey)).size, 44);
const colorKeys = new Set(INITIAL_COLOR_OPTIONS.map((color) => color.optionKey));
const modelKeys = new Set(INITIAL_COLOR_MODELS.map((model) => model.optionKey));
for (const model of INITIAL_COLOR_MODELS) {
  if (MODEL_MAP[model.optionKey]) {
    assert.equal(MODEL_MAP[model.optionKey], model.label);
  } else {
    assert.equal(model.isActive, false);
  }
}
for (const link of INITIAL_MODEL_COLOR_LINKS) {
  assert(modelKeys.has(link.modelKey));
  assert(colorKeys.has(link.colorKey));
}
assert.equal(
  new Set(INITIAL_MODEL_COLOR_LINKS.map((link) => `${link.modelKey}\u0000${link.colorKey}`)).size,
  225
);

const fresh = memoryClient();
await ensureDefaultProductCriteriaOptions(fresh);
await ensureDefaultProductCriteriaOptionLinks(fresh);
const colors = fresh.options.filter((row) => row.category === "DEVICE_COLOR");
const modelLinks = fresh.links.filter((row) => row.relation_type === "MODEL_COLOR");
assert.equal(colors.length, 82);
assert.equal(modelLinks.length, 225);
assert.equal(colors.find((row) => row.option_key === "핑크 골드")?.is_active, 0);
assert.equal(
  fresh.options.find((row) => row.category === "PRODUCT_MODEL" && row.option_key === "Galaxy S26")?.is_active,
  0
);
assert.equal(
  fresh.options.find((row) => row.category === "PRODUCT_MODEL" && row.option_key === "SM-A156N")?.is_active,
  0
);
const s23 = fresh.options.find((row) => row.category === "PRODUCT_MODEL" && row.option_key === "SM-S911N");
const graphite = colors.find((row) => row.option_key === "그라파이트");
assert(s23 && graphite);
const s23Graphite = modelLinks.find(
  (link) => link.parent_option_id === s23.option_id && link.child_option_id === graphite.option_id
);
assert(s23Graphite);
assert.equal(s23Graphite.is_active, 1);

graphite.label = "관리자 수정 그라파이트";
graphite.is_active = 0;
s23Graphite.is_active = 0;
await ensureDefaultProductCriteriaOptions(fresh);
await ensureDefaultProductCriteriaOptionLinks(fresh);
assert.equal(fresh.options.filter((row) => row.category === "DEVICE_COLOR").length, 82);
assert.equal(fresh.links.filter((row) => row.relation_type === "MODEL_COLOR").length, 225);
assert.equal(graphite.label, "관리자 수정 그라파이트");
assert.equal(graphite.is_active, 0);
assert.equal(s23Graphite.is_active, 0);

const configured = memoryClient();
const customModel = await configured.product_criteria_options.create({
  data: { category: "PRODUCT_MODEL", option_key: "SM-S911N", parent_key: "", label: "관리자 기종명", is_active: 1 },
});
const customColor = await configured.product_criteria_options.create({
  data: { category: "DEVICE_COLOR", option_key: "CUSTOM", parent_key: "", label: "관리자 색상", is_active: 1 },
});
await configured.product_criteria_option_links.create({
  data: { relation_type: "MODEL_COLOR", parent_option_id: customModel.option_id, child_option_id: customColor.option_id, is_active: 1 },
});
await ensureDefaultProductCriteriaOptions(configured);
await ensureDefaultProductCriteriaOptionLinks(configured);
assert.equal(customModel.label, "관리자 기종명");
assert.deepEqual(
  configured.links.filter((link) => link.relation_type === "MODEL_COLOR" && link.parent_option_id === customModel.option_id).map((link) => link.child_option_id),
  [customColor.option_id],
  "Existing model-color configuration must not be expanded by defaults."
);

console.log("Default color criteria and existing relation preservation verified.");
