import { performance } from "node:perf_hooks";
import { DELIVERYAPI_ORIGIN, type DeliveryApiCredentials } from "@/quickhack_server/integration/deliveryapi/config";
import { normalizeDeliveryApiTrace, type DeliveryApiTraceInput } from "@/quickhack_server/integration/deliveryapi/tracking-schema";

export class DeliveryApiRequestError extends Error {
  readonly code: "DELIVERYAPI_HTTP" | "DELIVERYAPI_TRANSPORT" | "DELIVERYAPI_RESPONSE";
  readonly status: number | null;
  constructor(code: "DELIVERYAPI_HTTP" | "DELIVERYAPI_TRANSPORT" | "DELIVERYAPI_RESPONSE", status: number | null = null) {
    super(`DeliveryAPI request failed (${code}, ${status ?? "NO_STATUS"}).`);
    this.name = "DeliveryApiRequestError";
    this.code = code;
    this.status = status;
  }
}

export function createDeliveryApiClient({
  credentials,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}: {
  credentials: () => DeliveryApiCredentials;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("DeliveryAPI timeout must be 1 to 60000 ms.");
  }
  return {
    async trace(items: DeliveryApiTraceInput[], options: { signal?: AbortSignal } = {}) {
      if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
        throw new TypeError("DeliveryAPI trace accepts 1 to 50 items.");
      }
      for (const item of items) {
        if (!/^[a-z0-9.]{2,40}$/.test(item.courierCode) || !/^\d{8,30}$/.test(item.trackingNumber)) {
          throw new TypeError("DeliveryAPI courier code or tracking number is invalid.");
        }
      }
      const { apiKey, secretKey } = credentials();
      const started = performance.now();
      let response: Response;
      try {
        response = await fetchImpl(`${DELIVERYAPI_ORIGIN}/v1/tracking/trace`, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          headers: { Authorization: `Bearer ${apiKey}:${secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ items, includeProgresses: false, skipCache: false }),
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new DeliveryApiRequestError("DELIVERYAPI_TRANSPORT");
      }
      if (!response.ok) throw new DeliveryApiRequestError("DELIVERYAPI_HTTP", response.status);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new DeliveryApiRequestError("DELIVERYAPI_RESPONSE", response.status); }
      try {
        return {
          provider: "DELIVERYAPI" as const,
          httpStatus: response.status,
          durationMs: Math.round(performance.now() - started),
          items: normalizeDeliveryApiTrace(payload, items.length),
        };
      } catch {
        throw new DeliveryApiRequestError("DELIVERYAPI_RESPONSE", response.status);
      }
    },
  };
}
