function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function cafe24OrderPreview(payload: unknown) {
  const rows = record(payload)?.orders;
  if (!Array.isArray(rows)) throw new Error("Cafe24 order list shape is invalid.");
  return rows.map((row) => {
    const item = record(row);
    if (!item || !text(item.order_id)) throw new Error("Cafe24 order item shape is invalid.");
    return { orderId: text(item.order_id), orderDate: text(item.order_date), orderStatus: text(item.order_status) };
  });
}

export function cafe24ProductPreview(payload: unknown) {
  const rows = record(payload)?.products;
  if (!Array.isArray(rows)) throw new Error("Cafe24 product list shape is invalid.");
  return rows.map((row) => {
    const item = record(row);
    const number = item?.product_no;
    if (!item || !Number.isSafeInteger(number)) throw new Error("Cafe24 product item shape is invalid.");
    return { productNo: number as number, productName: text(item.product_name) };
  });
}
