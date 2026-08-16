import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createInventoryCatalogFixture } from "../../support/inventory-business-fixtures.mjs";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-mobile-packing-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const keyAccess = {
  async withKey(operation) {
    const key = Buffer.alloc(32, 0x6d);
    try {
      return await operation(key);
    } finally {
      key.fill(0);
    }
  },
};

function authUser(row) {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.username,
    role: row.role,
    isDeveloper: false,
    mobilePackingEnabled: true,
    mustChangePassword: false,
  };
}

function registrationProof(input) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const tokenDigest = crypto
    .createHash("sha256")
    .update(input.deviceToken)
    .digest("base64url");
  const message = [
    "QH-MOBILE-PROVISION-V1",
    String(input.deviceId),
    String(input.registrationRevision),
    input.provisioningToken,
    input.appInstanceId,
    tokenDigest,
  ].join("\n");
  return {
    devicePublicKeySpki: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    signature: crypto.sign("sha256", Buffer.from(message), privateKey).toString("base64"),
  };
}

let prisma;

try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { createUserSession, hashSessionToken } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const { hashPassword } = await import("@/quickhack_server/core/password");
  const mobileService = await import("@/quickhack_server/mobile/mobile-device-service");
  const { checkPackingIntegrity } = await import(
    "@/quickhack_server/mobile/packing-check-service"
  );
  const timestamp = new Date("2026-08-14T09:00:00+09:00");

  const userRow = await prisma.users.create({
    data: {
      username: "mobile-packing-owner",
      password_hash: await hashPassword("Mobile!234"),
      role: "STAFF",
      is_active: 1,
      mobile_packing_enabled: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.employee_profiles.create({
    data: {
      user_id: userRow.user_id,
      display_name: userRow.username,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const sessionToken = await createUserSession(
    userRow.user_id,
    userRow.credential_revision
  );
  const session = await prisma.user_sessions.findUniqueOrThrow({
    where: { session_token_hash: hashSessionToken(sessionToken) },
  });
  const user = authUser(userRow);
  const context = {
    actor: user,
    sessionId: session.session_id,
    scope: "SELF",
  };

  const provisioning = await mobileService.beginMobileDeviceProvisioning(
    {
      userId: userRow.user_id,
      adbSerial: "PHYSICAL-PACKING-USB-001",
      label: "packing integration",
    },
    context,
    keyAccess
  );
  const appInstanceId = crypto.randomUUID();
  const deviceToken = crypto.randomBytes(32).toString("base64url");
  await mobileService.activateMobileDevice(
    {
      deviceId: provisioning.bootstrap.deviceId,
      registrationRevision: provisioning.bootstrap.registrationRevision,
      provisioningToken: provisioning.bootstrap.provisioningToken,
      appInstanceId,
      deviceToken,
      ...registrationProof({
        deviceId: provisioning.bootstrap.deviceId,
        registrationRevision: provisioning.bootstrap.registrationRevision,
        provisioningToken: provisioning.bootstrap.provisioningToken,
        appInstanceId,
        deviceToken,
      }),
    },
    context
  );

  const catalog = await createInventoryCatalogFixture(prisma, {
    prefix: "mobile-packing",
    timestamp,
  });
  const bulkOrderId = "MOBILE-PACKING-ORDER-BULK";
  const bulkShipmentId = "MOBILE-PACKING-SHIPMENT-BULK";
  await prisma.coupang_order_raw.create({
    data: {
      external_order_id: bulkOrderId,
      external_shipment_id: bulkShipmentId,
      external_order_status: "INSTRUCT",
      synced_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.devices.createMany({
    data: Array.from({ length: 52 }, (_, index) => ({
      pg_no: `MOBILEPACKPG${String(index + 1).padStart(3, "0")}`,
      model: catalog.options.model.label,
      model_code: catalog.options.model.option_key,
      model_seq: index + 1,
      storage: catalog.options.storage.label,
      color: catalog.options.color.label,
      sale_grade: catalog.options.grade.option_key,
      warranty: "2Y",
      inventory_sku_id: catalog.sku.inventory_sku_id,
      created_at: timestamp,
      updated_at: timestamp,
    })),
  });
  await prisma.match_worker_allocation.createMany({
    data: Array.from({ length: 52 }, (_, index) => ({
      external_order_id: bulkOrderId,
      external_shipment_id: bulkShipmentId,
      external_vendor_item_id: `MOBILE-PACKING-ITEM-${index + 1}`,
      pg_no: `MOBILEPACKPG${String(index + 1).padStart(3, "0")}`,
      sales_offer_id: catalog.salesOffer.sales_offer_id,
      inventory_sku_id: catalog.sku.inventory_sku_id,
      required_model: catalog.options.model.label,
      required_storage: index === 51 ? "랜덤" : catalog.options.storage.label,
      required_color: index === 51 ? "ANY" : catalog.options.color.label,
      allocation_status: "SHIPMENT_LIST_PRINTED",
      allocated_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    })),
  });

  const exactMismatchPg = "MOBILEPACKEXACT001";
  const invoicePg = "MOBILEPACKINVOICE001";
  await prisma.devices.createMany({
    data: [exactMismatchPg, invoicePg].map((pgNo, index) => ({
      pg_no: pgNo,
      model: catalog.options.model.label,
      model_code: catalog.options.model.option_key,
      model_seq: 53 + index,
      storage: catalog.options.storage.label,
      color: catalog.options.color.label,
      sale_grade: catalog.options.grade.option_key,
      warranty: "2Y",
      inventory_sku_id: catalog.sku.inventory_sku_id,
      created_at: timestamp,
      updated_at: timestamp,
    })),
  });
  await prisma.inventory.createMany({
    data: [
      { pg_no: "MOBILEPACKPG052", inventory_status: "PACKING" },
      { pg_no: exactMismatchPg, inventory_status: "PACKING" },
      { pg_no: invoicePg, inventory_status: "PACKING" },
    ].map((row) => ({
      ...row,
      location: "MOBILE_PACKING_TEST",
      stocked_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    })),
  });
  await prisma.inventory_quantity_balances.createMany({
    data: [
      { inventory_status: "PACKING", quantity: 3 },
      { inventory_status: "PACKED", quantity: 0 },
    ].map((row) => ({
      ...row,
      inventory_sku_id: catalog.sku.inventory_sku_id,
      created_at: timestamp,
      updated_at: timestamp,
    })),
  });

  async function createSingleAllocation(input) {
    await prisma.coupang_order_raw.create({
      data: {
        external_order_id: input.orderId,
        external_shipment_id: input.shipmentId,
        external_order_status: "INSTRUCT",
        synced_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
    return prisma.match_worker_allocation.create({
      data: {
        external_order_id: input.orderId,
        external_shipment_id: input.shipmentId,
        external_vendor_item_id: input.itemId,
        pg_no: input.pgNo,
        sales_offer_id: catalog.salesOffer.sales_offer_id,
        inventory_sku_id: catalog.sku.inventory_sku_id,
        required_model: catalog.options.model.label,
        required_storage: catalog.options.storage.label,
        required_color: input.requiredColor,
        allocation_status: "SHIPMENT_LIST_PRINTED",
        allocated_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  }

  const mismatchAllocation = await createSingleAllocation({
    orderId: "MOBILE-PACKING-ORDER-EXACT",
    shipmentId: "MOBILE-PACKING-SHIPMENT-EXACT",
    itemId: "MOBILE-PACKING-ITEM-EXACT",
    pgNo: exactMismatchPg,
    requiredColor: "UNMATCHED-BLUE",
  });
  const invoiceAllocation = await createSingleAllocation({
    orderId: "MOBILE-PACKING-ORDER-INVOICE",
    shipmentId: "MOBILE-PACKING-SHIPMENT-INVOICE",
    itemId: "MOBILE-PACKING-ITEM-INVOICE",
    pgNo: invoicePg,
    requiredColor: catalog.options.color.label,
  });

  const packageGroup = await prisma.shipment_package_groups.create({
    data: {
      grouping_key: "mobile-packing-invoice-group",
      receiver_name_snapshot: "packing receiver",
      receiver_address_snapshot: "packing address",
      group_status: "FROZEN",
      frozen_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.shipment_package_group_members.create({
    data: {
      package_group_id: packageGroup.package_group_id,
      allocation_id: invoiceAllocation.allocation_id,
      external_order_id: invoiceAllocation.external_order_id,
      external_shipment_id: invoiceAllocation.external_shipment_id,
      member_sequence: 1,
      added_at: timestamp,
    },
  });
  await prisma.carrier_shipments.create({
    data: {
      carrier_code: "LOGEN",
      package_group_id: packageGroup.package_group_id,
      tracking_number: "MOBILE-OLD-INVOICE-001",
      revision_no: 1,
      invoice_status: "REPLACED",
      shipment_status: "REGISTERED",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  const currentShipment = await prisma.carrier_shipments.create({
    data: {
      carrier_code: "LOGEN",
      package_group_id: packageGroup.package_group_id,
      tracking_number: "MOBILE-CURRENT-INVOICE-002",
      previous_tracking_number: "MOBILE-OLD-INVOICE-001",
      revision_no: 2,
      invoice_status: "REGISTERED",
      shipment_status: "REGISTERED",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  await prisma.shipment_package_groups.update({
    where: { package_group_id: packageGroup.package_group_id },
    data: {
      current_carrier_shipment_id: currentShipment.carrier_shipment_id,
      updated_at: timestamp,
    },
  });

  const credential = { appInstanceId, deviceToken };
  const bulkResult = await checkPackingIntegrity(
    { ...credential, scannedValues: [bulkOrderId, "MOBILEPACKPG052"] },
    user,
    context
  );
  assert.equal(bulkResult.code, "MATCH");
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({ where: { pg_no: "MOBILEPACKPG052" } }))
      .inventory_status,
    "PACKED",
    "The 52nd active allocation or RANDOM/ANY option did not pack."
  );

  const mismatchResult = await checkPackingIntegrity(
    {
      ...credential,
      scannedValues: [mismatchAllocation.external_order_id, exactMismatchPg],
    },
    user,
    context
  );
  assert.equal(mismatchResult.code, "MODEL_MISMATCH");
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({ where: { pg_no: exactMismatchPg } }))
      .inventory_status,
    "PACKING",
    "An exact option mismatch mutated inventory."
  );

  const staleInvoiceResult = await checkPackingIntegrity(
    { ...credential, scannedValues: ["MOBILE-OLD-INVOICE-001", invoicePg] },
    user,
    context
  );
  assert.equal(staleInvoiceResult.code, "STALE_INVOICE");

  const currentInvoiceResult = await checkPackingIntegrity(
    { ...credential, scannedValues: ["MOBILE-CURRENT-INVOICE-002", invoicePg] },
    user,
    context
  );
  assert.equal(currentInvoiceResult.code, "MATCH");
  assert.equal(currentInvoiceResult.orderLookupSource, "CURRENT_INVOICE");

  const balances = await prisma.inventory_quantity_balances.findMany({
    where: { inventory_sku_id: catalog.sku.inventory_sku_id },
  });
  assert.equal(
    balances.find((row) => row.inventory_status === "PACKING")?.quantity,
    1
  );
  assert.equal(
    balances.find((row) => row.inventory_status === "PACKED")?.quantity,
    2
  );
  assert.equal(
    await prisma.inventory_quantity_movements.count({
      where: { source_type: "PACKING_CHECK" },
    }),
    4,
    "Each successful packing transition must write one OUT and one IN movement."
  );
  assert.equal(
    await prisma.employee_activity_logs.count({
      where: { action_type: "MOBILE_PACKING_CHECK" },
    }),
    4,
    "Each packing attempt must leave exactly one audit record."
  );

  console.log(
    "Mobile packing 52nd-allocation lookup, RANDOM/ANY and EXACT options, stale/current invoices, atomic inventory ledger, and audit verified."
  );
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
