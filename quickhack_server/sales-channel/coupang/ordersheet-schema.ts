import {
  expectIntegrationArray,
  expectIntegrationDecimalId,
  expectIntegrationNonnegativeSafeInteger,
  expectIntegrationObject,
  schemaError,
} from "@/quickhack_server/integration/schema-validation";
import type {
  NormalizedCoupangOrder,
  NormalizedCoupangOrderItem,
} from "@/quickhack_server/sales-channel/coupang/sync-service";

type ValidationContext = {
  provider: string;
  endpoint: string;
};

function optionalText(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    return schemaError({ ...context, path, reason: "EXPECTED_TEXT" });
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function optionalBoolean(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") {
    return schemaError({ ...context, path, reason: "EXPECTED_BOOLEAN" });
  }
  return value;
}

function optionalProviderTimestamp(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  const text = optionalText(value, context, path);
  if (!text) return null;
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match) {
    return null;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = match[9] ? Number(match[9]) : 0;
  const offsetMinute = match[10] ? Number(match[10]) : 0;
  const daysInMonth =
    month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function optionalMoney(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = expectIntegrationObject(value, context, path);
    return expectIntegrationNonnegativeSafeInteger(
      record.units,
      context,
      `${path}.units`
    );
  }
  return expectIntegrationNonnegativeSafeInteger(value, context, path);
}

function orderItem(
  value: unknown,
  context: ValidationContext,
  path: string
): NormalizedCoupangOrderItem {
  const row = expectIntegrationObject(value, context, path);
  const shippingCount = expectIntegrationNonnegativeSafeInteger(
    row.shippingCount,
    context,
    `${path}.shippingCount`
  );
  const holdCountForCancel = expectIntegrationNonnegativeSafeInteger(
    row.holdCountForCancel,
    context,
    `${path}.holdCountForCancel`
  );
  const cancelCount = expectIntegrationNonnegativeSafeInteger(
    row.cancelCount,
    context,
    `${path}.cancelCount`
  );
  if (typeof row.canceled !== "boolean") {
    return schemaError({
      ...context,
      path: `${path}.canceled`,
      reason: "EXPECTED_BOOLEAN",
    });
  }

  return {
    externalVendorItemId: expectIntegrationDecimalId(
      row.vendorItemId,
      context,
      `${path}.vendorItemId`
    ),
    vendorItemName: optionalText(row.vendorItemName, context, `${path}.vendorItemName`),
    sellerProductId:
      row.sellerProductId === null || row.sellerProductId === undefined
        ? null
        : expectIntegrationDecimalId(
            row.sellerProductId,
            context,
            `${path}.sellerProductId`
          ),
    sellerProductName: optionalText(
      row.sellerProductName,
      context,
      `${path}.sellerProductName`
    ),
    sellerProductItemName: optionalText(
      row.sellerProductItemName,
      context,
      `${path}.sellerProductItemName`
    ),
    externalVendorSkuCode:
      optionalText(row.externalVendorSkuCode, context, `${path}.externalVendorSkuCode`) ??
      optionalText(row.externalVendorSku, context, `${path}.externalVendorSku`) ??
      optionalText(row.vendorSkuCode, context, `${path}.vendorSkuCode`),
    salesPrice: optionalMoney(row.salesPrice, context, `${path}.salesPrice`),
    shippingCount,
    holdCountForCancel,
    cancelCount,
    canceled: row.canceled ? 1 : 0,
    availableQuantity: Math.max(
      0,
      shippingCount - holdCountForCancel - cancelCount
    ),
  };
}

function ordersheet(
  value: unknown,
  context: ValidationContext,
  path: string
): NormalizedCoupangOrder {
  const row = expectIntegrationObject(value, context, path);
  const receiver =
    row.receiver === null || row.receiver === undefined
      ? {}
      : expectIntegrationObject(row.receiver, context, `${path}.receiver`);
  const orderer =
    row.orderer === null || row.orderer === undefined
      ? {}
      : expectIntegrationObject(row.orderer, context, `${path}.orderer`);
  const items = expectIntegrationArray(row.orderItems, context, `${path}.orderItems`);

  return {
    externalOrderId: expectIntegrationDecimalId(
      row.orderId,
      context,
      `${path}.orderId`
    ),
    externalShipmentId: expectIntegrationDecimalId(
      row.shipmentBoxId,
      context,
      `${path}.shipmentBoxId`
    ),
    channelStatus: optionalText(row.status, context, `${path}.status`),
    orderedAt: optionalText(row.orderedAt, context, `${path}.orderedAt`),
    paidAt: optionalText(row.paidAt, context, `${path}.paidAt`),
    ordererName: optionalText(orderer.name, context, `${path}.orderer.name`),
    receiverName: optionalText(receiver.name, context, `${path}.receiver.name`),
    receiverSafeNumber: optionalText(
      receiver.safeNumber,
      context,
      `${path}.receiver.safeNumber`
    ),
    receiverAddress1: optionalText(receiver.addr1, context, `${path}.receiver.addr1`),
    receiverAddress2: optionalText(receiver.addr2, context, `${path}.receiver.addr2`),
    receiverPostCode: optionalText(
      receiver.postCode,
      context,
      `${path}.receiver.postCode`
    ),
    shippingMemo:
      optionalText(row.parcelPrintMessage, context, `${path}.parcelPrintMessage`) ??
      optionalText(row.deliveryMessage, context, `${path}.deliveryMessage`),
    deliveryCompanyName: optionalText(
      row.deliveryCompanyName,
      context,
      `${path}.deliveryCompanyName`
    ),
    invoiceNumber: optionalText(row.invoiceNumber, context, `${path}.invoiceNumber`),
    invoiceUploadedAt:
      items
        .map((item, index) => {
          const itemRow = expectIntegrationObject(
            item,
            context,
            `${path}.orderItems[${index}]`
          );
          return optionalText(
            itemRow.invoiceNumberUploadDate,
            context,
            `${path}.orderItems[${index}].invoiceNumberUploadDate`
          );
        })
        .find(Boolean) ?? null,
    splitShipping: optionalBoolean(
      row.splitShipping,
      context,
      `${path}.splitShipping`
    ),
    deliveredAt: optionalProviderTimestamp(
      row.deliveredDate,
      context,
      `${path}.deliveredDate`
    ),
    items: items.map((item, index) =>
      orderItem(item, context, `${path}.orderItems[${index}]`)
    ),
  };
}

export type NormalizedCoupangOrdersheetPage = {
  nextToken: string | null;
  orders: NormalizedCoupangOrder[];
};

export function validateCoupangOrdersheetPage(
  payload: unknown,
  context: ValidationContext = {
    provider: "COUPANG",
    endpoint: "ORDERSHEETS",
  }
): NormalizedCoupangOrdersheetPage {
  const root = expectIntegrationObject(payload, context);
  if (root.code === undefined || root.code === null) {
    return schemaError({
      ...context,
      path: "$.code",
      reason: "MISSING_SUCCESS_CODE",
    });
  }
  const code = String(root.code).trim().toUpperCase();
  if (!["200", "SUCCESS"].includes(code)) {
    return schemaError({ ...context, path: "$.code", reason: "APPLICATION_ERROR" });
  }
  const rows = expectIntegrationArray(root.data, context, "$.data");
  return {
    nextToken: optionalText(root.nextToken, context, "$.nextToken"),
    orders: rows.map((row, index) =>
      ordersheet(row, context, `$.data[${index}]`)
    ),
  };
}
