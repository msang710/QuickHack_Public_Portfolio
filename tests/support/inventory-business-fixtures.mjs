import { parseKstSqlDateTime } from "../../quickhack_shared/core/time.ts";

function safeKey(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "-").toUpperCase();
}

function databaseTimestamp(value) {
  const timestamp = parseKstSqlDateTime(value);
  if (!timestamp) throw new TypeError("A valid inventory fixture timestamp is required.");
  return timestamp;
}

async function findOrCreateOption(prisma, option, timestamp) {
  return (
    (await prisma.product_criteria_options.findFirst({
      where: {
        category: option.category,
        option_key: option.key,
        parent_key: "",
      },
    })) ??
    prisma.product_criteria_options.create({
      data: {
        category: option.category,
        option_key: option.key,
        label: option.label,
        parent_key: "",
        created_at: timestamp,
        updated_at: timestamp,
      },
    })
  );
}

export async function createInventoryCatalogFixture(prisma, input) {
  const prefix = safeKey(input.prefix);
  const timestamp = databaseTimestamp(input.timestamp);
  const options = {};

  for (const option of [
    {
      name: "model",
      category: "PRODUCT_MODEL",
      key: `${prefix}-MODEL`,
      label: `${prefix} Model`,
    },
    { name: "storage", category: "STORAGE", key: "128GB", label: "128GB" },
    {
      name: "color",
      category: "DEVICE_COLOR",
      key: `${prefix}-BLACK`,
      label: `${prefix} Black`,
    },
    { name: "grade", category: "SALE_GRADE", key: "A", label: "A" },
    {
      name: "warranty",
      category: "WARRANTY_GROUP",
      key: "2Y",
      label: "2 years",
    },
  ]) {
    options[option.name] = await findOrCreateOption(prisma, option, timestamp);
  }

  const sku = await prisma.inventory_skus.create({
    data: {
      sku_code: `${prefix}-SKU`,
      model_option_id: options.model.option_id,
      storage_option_id: options.storage.option_id,
      color_option_id: options.color.option_id,
      sale_grade_option_id: options.grade.option_id,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const salesOffer = await prisma.sales_offers.create({
    data: {
      offer_code: `${prefix}-OFFER`,
      model_option_id: options.model.option_id,
      storage_match_mode: "EXACT",
      storage_option_id: options.storage.option_id,
      color_match_mode: "EXACT",
      color_option_id: options.color.option_id,
      warranty_group_option_id: options.warranty.option_id,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });

  return {
    prefix,
    options,
    sku,
    salesOffer,
    orderMappingSnapshot: {
      required_model_label: options.model.label,
      required_storage_label: options.storage.label,
      required_color_label: options.color.label,
      required_warranty_group: options.warranty.option_key.toUpperCase(),
    },
  };
}

export async function createSellableDeviceFixtures(
  prisma,
  ledgerApi,
  catalog,
  input
) {
  const devices = [];
  const timestamp = databaseTimestamp(input.timestamp);

  for (let index = 1; index <= input.count; index += 1) {
    const pgNo = `${catalog.prefix}-PG-${index}`;

    await prisma.devices.create({
      data: {
        pg_no: pgNo,
        model: catalog.options.model.label,
        model_code: catalog.options.model.option_key,
        model_seq: index,
        storage: catalog.options.storage.label,
        color: catalog.options.color.label,
        sale_grade: catalog.options.grade.option_key,
        warranty: "2Y",
        inventory_sku_id: catalog.sku.inventory_sku_id,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await prisma.inventory.create({
      data: {
        pg_no: pgNo,
        inventory_status: "SELLABLE",
        location: "INTEGRATION_TEST",
        stocked_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    await prisma.$transaction((tx) =>
      ledgerApi.recordInventoryCreatedWithLedger(tx, {
        pgNo,
        inventoryStatus: "SELLABLE",
        operationKey: `integration-fixture:${pgNo}`,
        movementType:
          ledgerApi.INVENTORY_QUANTITY_MOVEMENT_TYPE.inventoryCreated,
        sourceType: "INTEGRATION_TEST",
        sourceId: pgNo,
        occurredAt: timestamp,
      })
    );
    devices.push({ pgNo, modelSeq: index });
  }

  return devices;
}
