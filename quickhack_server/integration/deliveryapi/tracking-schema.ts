export type DeliveryApiTraceInput = {
  courierCode: string;
  trackingNumber: string;
  clientId?: string;
};

export type DeliveryApiTraceItem = {
  clientId: string | null;
  success: boolean;
  deliveryStatus: string | null;
  queriedAt: string | null;
  fromCache: boolean | null;
  errorCode: string | null;
  billable: boolean | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeDeliveryApiTrace(payload: unknown, expectedCount: number): DeliveryApiTraceItem[] {
  const root = object(payload);
  const data = object(root?.data);
  const results = data?.results;
  if (root?.isSuccess !== true || !Array.isArray(results) || results.length !== expectedCount) {
    throw new Error("DeliveryAPI response shape is invalid.");
  }
  return results.map((unknownItem) => {
    const item = object(unknownItem);
    const detail = object(item?.data);
    const error = object(item?.error);
    const cache = object(item?.cache);
    if (!item || typeof item.success !== "boolean" || (item.success && !detail) || (!item.success && !error)) {
      throw new Error("DeliveryAPI result item is invalid.");
    }
    return {
      clientId: string(item.clientId),
      success: item.success,
      deliveryStatus: item.success ? string(detail?.deliveryStatus) : null,
      queriedAt: item.success ? string(detail?.queriedAt) : null,
      fromCache: typeof cache?.fromCache === "boolean" ? cache.fromCache : null,
      errorCode: !item.success ? string(error?.code) : null,
      billable: !item.success && typeof error?.billable === "boolean" ? error.billable : null,
    };
  });
}
